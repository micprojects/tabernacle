import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';

// This session always owns a new profile and process. Never attach to an existing
// Firefox instance, copy a personal profile, or use OS input/clipboard APIs.
export class ScreenshotBrowser {
  async open(fixture, logPath) {
    console.log('Firefox fixture: preparing isolated profile');
    this.root = await mkdtemp(join(tmpdir(), 'tabernacle-screenshots-'));
    const appData = join(this.root, 'app-data');
    await mkdir(appData);
    const options = new firefox.Options().addArguments('-no-remote').enableBidi();
    if (!fixture.headed) options.addArguments('-headless');
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    else if (process.platform === 'darwin')
      options.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
    options.setPreference('browser.shell.checkDefaultBrowser', false);
    options.setPreference('browser.nova.enabled', true);
    options.setPreference('browser.startup.page', 0);
    options.setPreference('browser.tabs.warnOnClose', false);
    options.setPreference('ui.prefersReducedMotion', 1);
    options.setPreference('ui.systemUsesDarkTheme', 0);
    options.setPreference('layout.css.prefers-color-scheme.content-override', 1);
    const binary = process.env.GECKODRIVER_BINARY || (await download('0.37.1'));
    this.log = await open(logPath, 'w');
    console.log('Firefox fixture: starting WebDriver session');
    this.driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(
        new firefox.ServiceBuilder(binary)
          .addArguments('--allow-system-access', '--profile-root', this.root)
          .setEnvironment({ ...process.env, MOZ_APP_DATA: appData })
          .setStdio(['ignore', this.log.fd, this.log.fd]),
      )
      .build();
    console.log('Firefox fixture: WebDriver session ready');
    await this.driver.manage().setTimeouts({ script: 125000, pageLoad: 30000 });
    await this.driver.manage().window().setRect(fixture.window);
    await this.driver.setContext(firefox.Context.CHROME);
    this.environment = await this.chrome(() => ({
      profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
      firefox: Services.appinfo.version,
    }));
    const profile = await realpath(this.environment.profile);
    const within = relative(await realpath(this.root), profile);
    assert(within && !within.startsWith('..') && !isAbsolute(within), 'Unexpected Firefox profile');
    await this.driver.setContext(firefox.Context.CONTENT);
    console.log('Firefox fixture: installing extension');
    const addonId = await this.driver.installAddon(resolve('extension'), true);
    assert.equal(addonId, 'tabernacle@michaelprojects.com');
    console.log('Firefox fixture: extension installed, waiting for sidebar');
    await this.driver.setContext(firefox.Context.CHROME);
    this.sidebarUrl = await this.driver.wait(
      () =>
        this.chrome((id) => {
          const url = WebExtensionPolicy.getByID(id)?.getURL('sidebar.html');
          const global = document
            .getElementById('sidebar')
            ?.contentDocument?.getElementById('webext-panels-browser')
            ?.browsingContext?.currentWindowGlobal;
          return url && global?.documentURI.spec === url ? url : null;
        }, addonId),
      15000,
      'Firefox did not open the extension sidebar',
    );
    await this.chrome((width) => {
      document.getElementById('sidebar-box').style.width = `${width}px`;
    }, fixture.sidebarWidth);
    console.log('Firefox fixture: waiting for the sidebar document (without DevTools)');
    await this.evaluate(async () => {
      if (document.readyState !== 'complete')
        await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    });
    console.log('Firefox fixture: sizing sidebar');
    const size = fixture.capture.sourceSize;
    for (let attempt = 0; attempt < 3; attempt++) {
      const actual = await this.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (actual.width === size.width && actual.height === size.height) break;
      await this.chrome((delta) => {
        const box = document.getElementById('sidebar-box');
        box.style.width = `${parseFloat(box.style.width) + delta}px`;
      }, size.width - actual.width);
      const rect = await this.driver.manage().window().getRect();
      await this.driver
        .manage()
        .window()
        .setRect({ width: rect.width, height: rect.height + size.height - actual.height });
      await this.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }
    const actual = await this.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.deepEqual(actual, size, 'Firefox sidebar dimensions do not match the fixture');
    console.log('Firefox fixture: dimensions verified, waiting for fonts');
    await this.evaluate(async () => {
      await document.fonts.ready;
    });
    console.log('Firefox fixture: sidebar ready for checks');
    return this.environment;
  }

  async reloadSidebar() {
    // Navigate from chrome, then wait there for a new document. An evaluation
    // polling the old page can be discarded during reload; never replay it.
    const previousId = await this.chrome((url) => {
      const panel = document
        .getElementById('sidebar')
        ?.contentDocument?.getElementById('webext-panels-browser');
      const global = panel?.browsingContext?.currentWindowGlobal;
      if (!global || global.documentURI.spec !== url)
        throw new Error('Reload target is not the installed sidebar');
      const id = global.innerWindowId;
      panel.reload();
      return id;
    }, this.sidebarUrl);
    await this.driver.wait(
      () =>
        this.chrome(
          (previousId, url) => {
            const global = document
              .getElementById('sidebar')
              ?.contentDocument?.getElementById('webext-panels-browser')
              ?.browsingContext?.currentWindowGlobal;
            return global?.documentURI.spec === url && global.innerWindowId !== previousId;
          },
          previousId,
          this.sidebarUrl,
        ),
      15000,
      'Sidebar did not reload',
    );
    await this.evaluate(async () => {
      if (document.readyState !== 'complete')
        await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    });
  }

  async setColorScheme(scheme) {
    assert(['light', 'dark'].includes(scheme), 'Unsupported screenshot colour scheme');
    // The real sidebar follows browser chrome, independently of website colour
    // preferences. Change only this owned profile's system appearance override.
    await this.chrome((dark) => {
      Services.prefs.setIntPref('ui.systemUsesDarkTheme', dark ? 1 : 0);
    }, scheme === 'dark');
  }

  async chrome(fn, ...args) {
    const result = await this.driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];Promise.resolve().then(()=>(${fn.toString()})(...arguments[0])).then(value=>done({ok:true,value:value??null}),error=>done({ok:false,error:String(error)+'\\n'+(error?.stack||'')}));`,
      args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async evaluate(fn, ...args) {
    const values = JSON.stringify(JSON.stringify(args));
    const expression = `(async()=>{try{return JSON.stringify({ok:true,value:await (${fn.toString()})(...JSON.parse(${values}))??null})}catch(error){return JSON.stringify({ok:false,error:String(error)+'\\n'+(error?.stack||'')})}})()`;
    const json = await this.chrome(
      async (id, expression, url) => {
        const panel = document
          .getElementById('sidebar')
          ?.contentDocument?.getElementById('webext-panels-browser');
        const global = panel?.browsingContext?.currentWindowGlobal;
        if (!global || global.documentURI.spec !== url)
          throw new Error('Screenshot bridge target is not the installed sidebar');
        const innerWindowId = global.innerWindowId;
        const name = `TabernacleScreenshot:${id}`;
        // PrecompiledScript executes in the actual page global, as Firefox's
        // scripting API does. Keep DOM constructors, globals and browser API
        // arguments in that realm without attaching DevTools or relaxing CSP.
        const script = `(async()=>{try{
          const compiled=await ChromeUtils.compileScript(
            ${JSON.stringify('data:text/javascript,' + encodeURIComponent(expression))},
            {hasReturnValue:true,filename:'tabernacle-sidebar-test'});
          if(content.document.documentURI!==${JSON.stringify(url)} ||
             content.windowGlobalChild.innerWindowId!==${JSON.stringify(innerWindowId)})
            throw new Error('Sidebar document changed before evaluation');
          const json=await compiled.executeInGlobal(content,{reportExceptions:false});
          sendAsyncMessage(${JSON.stringify(name)},{json});
        }catch(error){sendAsyncMessage(${JSON.stringify(name)},{error:String(error)+'\\n'+(error?.stack||'')})}})();`;
        const manager = panel.messageManager;
        return new Promise((resolve, reject) => {
          let finished = false;

          const finish = (error, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            try {
              manager.removeMessageListener(name, listener);
            } catch {
              // A discarded panel has already removed its message listeners.
            }
            if (error) reject(error);
            else resolve(value);
          };

          const listener = (message) => {
            const current = panel.browsingContext?.currentWindowGlobal;
            if (current?.innerWindowId !== innerWindowId || current.documentURI.spec !== url)
              finish(new Error('Sidebar document changed during evaluation'));
            else if (message.data.error) finish(new Error(message.data.error));
            else finish(null, message.data.json);
          };

          const timeout = setTimeout(
            () => finish(new Error('Sidebar evaluation timed out')),
            30000,
          );
          try {
            manager.addMessageListener(name, listener);
            manager.loadFrameScript(
              'data:application/javascript,' + encodeURIComponent(script),
              false,
              false,
            );
          } catch (error) {
            finish(error);
          }
        });
      },
      crypto.randomUUID(),
      expression,
      this.sidebarUrl,
    );
    const result = JSON.parse(json);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async screenshot({ sourceSize: { width, height }, scale }) {
    const png = await this.chrome(
      async (width, height, scale) => {
        const panel = document
          .getElementById('sidebar')
          .contentDocument.getElementById('webext-panels-browser');
        const global = panel.browsingContext.currentWindowGlobal;
        if (
          !global.documentURI.spec.startsWith('moz-extension:') ||
          !global.documentURI.spec.endsWith('/sidebar.html')
        )
          throw new Error('Refusing to capture a document other than the extension sidebar');
        // The same native rendering API used by Firefox's DevTools screenshot command.
        const bitmap = await global.drawSnapshot(new DOMRect(0, 0, width, height), scale, 'white');
        const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        return canvas.toDataURL('image/png').split(',')[1];
      },
      width,
      height,
      scale,
    );
    return Buffer.from(png, 'base64');
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        if (this.driver) await this.driver.quit();
      } finally {
        if (this.log) await this.log.close();
        if (this.root) await rm(this.root, { recursive: true, force: true });
      }
    })();
    return this.closing;
  }
}
