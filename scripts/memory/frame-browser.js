import assert from 'node:assert/strict';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from '../firefox-session.js';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

export class FrameBrowser {
  async open() {
    this.session = await startFirefox({
      configure: (options) => {
        options.setPreference('browser.nova.enabled', true);
        options.setPreference('ui.prefersReducedMotion', 1);
        options.setPreference('ui.systemUsesDarkTheme', 0);
        options.setPreference('layout.css.prefers-color-scheme.content-override', 1);
      },
    });
    this.driver = this.session.driver;
    await this.driver.manage().setTimeouts({ script: 45000, pageLoad: 30000 });
    await this.driver.manage().window().setRect({ width: 1100, height: 850 });
    const id = await this.driver.installAddon(resolve(import.meta.dirname, 'control'), true);
    assert.equal(id, 'tabernacle-memory-control@fixture.invalid');
    const url = await this.chrome(
      (id) => WebExtensionPolicy.getByID(id).getURL('control.html'),
      id,
    );
    await this.setContext(firefox.Context.CONTENT);
    await this.driver.get(url);
    this.controlHandle = await this.driver.getWindowHandle();
    return { firefox: this.session.version, profile: this.session.profile };
  }

  async setContext(context) {
    if (this.context !== context) {
      await this.driver.setContext(context);
      this.context = context;
    }
  }

  async execute(fn, args) {
    const result = await this.driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];Promise.resolve().then(()=>(${fn.toString()})(...arguments[0])).then(value=>done({ok:true,value:value??null}),error=>done({ok:false,error:String(error)+'\\n'+String(error.stack)}));`,
      args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async chrome(fn, ...args) {
    await this.setContext(firefox.Context.CHROME);
    return this.execute(fn, args);
  }

  async control(fn, ...args) {
    await this.setContext(firefox.Context.CONTENT);
    return this.execute(fn, args);
  }

  async install(root) {
    await this.setContext(firefox.Context.CONTENT);
    assert.equal(
      await this.driver.installAddon(resolve(root, 'extension'), true),
      'tabernacle@michaelprojects.com',
    );
    this.sidebarUrl = await this.chrome(() =>
      WebExtensionPolicy.getByID('tabernacle@michaelprojects.com').getURL('sidebar.html'),
    );
  }

  async show() {
    if (!this.command) {
      await this.driver.wait(
        () =>
          this.chrome(() =>
            [...Services.wm.getEnumerator('navigator:browser')].some((win) =>
              win.document
                .getElementById('sidebar-box')
                ?.getAttribute('sidebarcommand')
                ?.includes('tabernacle'),
            ),
          ),
        15000,
        'Missing native sidebar command',
      );
      this.command = await this.chrome(() =>
        [...Services.wm.getEnumerator('navigator:browser')]
          .map((win) => win.document.getElementById('sidebar-box')?.getAttribute('sidebarcommand'))
          .find((command) => command?.includes('tabernacle')),
      );
    }
    await this.chrome(async (command) => {
      for (const win of Services.wm.getEnumerator('navigator:browser')) {
        const box = win.document.getElementById('sidebar-box');
        box.style.width = '330px';
        // open_at_install already starts each sidebar. A second show during its
        // chrome document load races Firefox's loadPanel callback.
        if (win.SidebarController.isOpen && box.getAttribute('sidebarcommand') === command)
          continue;
        await win.SidebarController.show(command);
      }
    }, this.command);
  }

  async hide() {
    await this.chrome(() => {
      for (const win of Services.wm.getEnumerator('navigator:browser'))
        win.SidebarController.hide();
    });
  }

  async panels() {
    return this.chrome(
      (url) =>
        [...Services.wm.getEnumerator('navigator:browser')].map((win) => {
          const box = win.document.getElementById('sidebar-box');
          const panel = win.document
            .getElementById('sidebar')
            ?.contentDocument?.getElementById('webext-panels-browser');
          return {
            windowKey: win.windowGlobalChild.innerWindowId,
            browserId: panel?.browserId,
            uri: panel?.browsingContext?.currentWindowGlobal?.documentURI.spec,
            open: !!win.SidebarController.isOpen,
            hidden: !box || box.hidden || win.getComputedStyle(box).display === 'none',
            watched: !!panel?.browsingContext?.isWatchedByDevTools,
            isTarget: panel?.browsingContext?.currentWindowGlobal?.documentURI.spec === url,
          };
        }),
      this.sidebarUrl,
    );
  }

  async frame(browserId, fn, ...args) {
    // A one-shot frame script binds to this panel's content. Shared process
    // globalThis registries can accidentally retain another panel's handler.
    const id = crypto.randomUUID();
    const script = `(async function(){
      try{
        const window=content.wrappedJSObject,document=content.document,browser=window.browser;
        const Event=window.Event,MouseEvent=window.MouseEvent,performance=window.performance,TextEncoder=window.TextEncoder;
        const clone=value=>Cu.cloneInto(value,window);
        const value=await (${fn.toString()})(...clone(${JSON.stringify(args)}));
        sendAsyncMessage('TabernacleMemory:${id}',{json:JSON.stringify({ok:true,value:value??null})});
      }catch(error){sendAsyncMessage('TabernacleMemory:${id}',{json:JSON.stringify({ok:false,error:String(error)+'\\n'+String(error.stack)})});}
    })();`;
    const json = await this.chrome(
      async (browserId, id, script, url) => {
        const panel = [...Services.wm.getEnumerator('navigator:browser')]
          .map((win) =>
            win.document
              .getElementById('sidebar')
              ?.contentDocument?.getElementById('webext-panels-browser'),
          )
          .find((panel) => panel?.browserId === browserId);
        if (!panel || panel.browsingContext.currentWindowGlobal.documentURI.spec !== url)
          throw new Error('Memory bridge target is not the installed sidebar');
        const manager = panel.messageManager,
          name = 'TabernacleMemory:' + id;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            manager.removeMessageListener(name, listener);
            reject(new Error('Sidebar diagnostic call timed out'));
          }, 30000);

          const listener = (message) => {
            clearTimeout(timeout);
            manager.removeMessageListener(name, listener);
            resolve(message.data.json);
          };

          manager.addMessageListener(name, listener);
          manager.loadFrameScript(
            'data:application/javascript,' + encodeURIComponent(script),
            false,
            false,
          );
        });
      },
      browserId,
      id,
      script,
      this.sidebarUrl,
    );
    const result = JSON.parse(json);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async toggle(enabled) {
    await this.chrome(async (enabled) => {
      const { AddonManager } = ChromeUtils.importESModule(
        'resource://gre/modules/AddonManager.sys.mjs',
      );
      const addon = await AddonManager.getAddonByID('tabernacle@michaelprojects.com');
      await (enabled ? addon.enable() : addon.disable());
      if (addon.isActive !== enabled) throw new Error('Add-on state did not change');
    }, enabled);
  }

  async cpu() {
    return this.chrome(async () => {
      const p = await ChromeUtils.requestProcInfo();
      return [p, ...p.children].map(({ pid, type, cpuTime, memory }) => ({
        pid,
        type,
        cpuTimeNs: cpuTime,
        memoryBytes: memory,
      }));
    });
  }

  async noDebugger() {
    return this.chrome(() => {
      const { ExtensionParent } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionParent.sys.mjs',
      );
      return !ExtensionParent.DebugUtils.hasDevToolsAttached('tabernacle@michaelprojects.com');
    });
  }

  async close() {
    await this.session?.close();
  }
}
