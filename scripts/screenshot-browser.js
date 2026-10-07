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
    this.root = await mkdtemp(join(tmpdir(), 'tabernacle-screenshots-'));
    const appData = join(this.root, 'app-data');
    await mkdir(appData);
    const options = new firefox.Options().addArguments('-headless', '-no-remote').enableBidi();
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    else if (process.platform === 'darwin')
      options.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
    options.setPreference('browser.shell.checkDefaultBrowser', false);
    options.setPreference('browser.startup.page', 0);
    options.setPreference('browser.tabs.warnOnClose', false);
    options.setPreference('ui.prefersReducedMotion', 1);
    options.setPreference('layout.css.prefers-color-scheme.content-override', 1);
    const binary = process.env.GECKODRIVER_BINARY || (await download('0.37.1'));
    this.log = await open(logPath, 'w');
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
    const addonId = await this.driver.installAddon(resolve('extension'), true);
    assert.equal(addonId, 'tabernacle@michaelprojects.com');
    await this.driver.setContext(firefox.Context.CHROME);
    await this.driver.wait(
      () =>
        this.chrome(() =>
          Boolean(
            document
              .getElementById('sidebar')
              ?.contentDocument?.getElementById('webext-panels-browser')
              ?.browsingContext?.currentWindowGlobal?.documentURI.spec.startsWith('moz-extension:'),
          ),
        ),
      15000,
      'Firefox did not open the extension sidebar',
    );
    await this.chrome(
      async (id, sidebarWidth) => {
        document.getElementById('sidebar-box').style.width = `${sidebarWidth}px`;
        const { require } = ChromeUtils.importESModule(
          'resource://devtools/shared/loader/Loader.sys.mjs',
        );
        const { CommandsFactory } = require('devtools/shared/commands/commands-factory');
        // In-process DevTools transport: no debugging listener or inspector window.
        window.tabernacleScreenshotCommands = await CommandsFactory.forAddon(id);
        await window.tabernacleScreenshotCommands.targetCommand.startListening();
      },
      addonId,
      fixture.sidebarWidth,
    );
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
    }
    const actual = await this.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.deepEqual(actual, size, 'Firefox sidebar dimensions do not match the fixture');
    await this.evaluate(async () => {
      await document.fonts.ready;
    });
    return this.environment;
  }

  async chrome(fn, ...args) {
    const result = await this.driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];Promise.resolve().then(()=>(${fn.toString()})(...arguments[0])).then(value=>done({ok:true,value:value??null}),error=>done({ok:false,error:error.stack||error.message}));`,
      args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async evaluate(fn, ...args) {
    const expression = `(async()=>{try{return JSON.stringify({ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})??null})}catch(error){return JSON.stringify({ok:false,error:error.stack||error.message})}})()`;
    const json = await this.chrome(async (expression) => {
      const panel = document
        .getElementById('sidebar')
        .contentDocument.getElementById('webext-panels-browser');
      const response = await window.tabernacleScreenshotCommands.scriptCommand.execute(expression, {
        innerWindowID: panel.browsingContext.currentWindowGlobal.innerWindowId,
      });
      if (response.exceptionMessage) throw new Error(String(response.exceptionMessage));
      const promise = response.result;
      try {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const { promiseState } = await promise.getPromiseState();
          if (promiseState.state === 'fulfilled') {
            const value = promiseState.value;
            return typeof value === 'string' ? value : await value.string();
          }
          if (promiseState.state === 'rejected') throw new Error('Sidebar evaluation rejected');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Sidebar evaluation timed out');
      } finally {
        await promise.release();
      }
    }, expression);
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
