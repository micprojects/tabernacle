import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ScreenshotBrowser } from '../scripts/screenshot-browser.js';

function fixture(options = {}) {
  const url = 'moz-extension://test/sidebar.html';
  const page = vm.createContext({
    document: { documentURI: url, readyState: 'complete' },
    windowGlobalChild: { innerWindowId: 17 },
  });
  vm.runInContext('window = globalThis; counter = 0;', page);
  const objectPrototype = vm.runInContext('Object.prototype', page);
  page.browser = {
    runtime: {
      async sendMessage(value) {
        assert.equal(Object.getPrototypeOf(value), objectPrototype);
        return { echo: value };
      },
    },
  };
  const listeners = new Map();
  const timers = new Map();
  const names = [];
  const stats = { loads: 0, executions: 0 };
  const panel = {
    browsingContext: {
      currentWindowGlobal: { documentURI: { spec: url }, innerWindowId: 17 },
    },
    messageManager: {
      addMessageListener(name, listener) {
        assert(!listeners.has(name));
        names.push(name);
        listeners.set(name, listener);
      },

      removeMessageListener(name) {
        listeners.delete(name);
      },

      loadFrameScript(source, delayed, globalScope) {
        stats.loads++;
        assert.equal(delayed, false);
        assert.equal(globalScope, false);
        if (options.loadError) throw new Error('Frame script load failed');
        if (options.noReply) return;
        vm.runInNewContext(decodeURIComponent(source.split(',').slice(1).join(',')), {
          content: page,
          ChromeUtils: {
            async compileScript(source, configuration) {
              assert.equal(configuration.hasReturnValue, true);
              options.beforeCompile?.({ page, panel });
              return {
                executeInGlobal(global, configuration) {
                  assert.equal(global, page);
                  assert.equal(configuration.reportExceptions, false);
                  stats.executions++;
                  return vm.runInContext(
                    decodeURIComponent(source.split(',').slice(1).join(',')),
                    page,
                  );
                },
              };
            },
          },

          sendAsyncMessage(name, data) {
            options.beforeReply?.({ page, panel });
            queueMicrotask(() => listeners.get(name)?.({ data }));
          },
        });
      },
    },
  };
  const session = new ScreenshotBrowser();
  session.sidebarUrl = url;
  session.chrome = (fn, ...args) =>
    vm.runInNewContext(`(${fn.toString()})(...args)`, {
      args,
      document: {
        getElementById: () => ({ contentDocument: { getElementById: () => panel } }),
      },

      setTimeout(callback, delay) {
        assert.equal(delay, 30000);
        const key = Symbol();
        timers.set(key, callback);
        return key;
      },

      clearTimeout(key) {
        timers.delete(key);
      },
    });
  return { session, page, panel, listeners, timers, names, stats };
}

test('sidebar evaluation uses the page realm and preserves globals and JSON arguments', async () => {
  const f = fixture();
  const value = JSON.parse('{"__proto__":{"kept":true},"text":"quotes \\\" and \\n"}');
  assert.deepEqual(
    await f.session.evaluate(async (value) => {
      globalThis.counter++;
      const response = await browser.runtime.sendMessage({ value });
      return {
        global: globalThis === window,
        own: Object.hasOwn(value, '__proto__'),
        prototype: Object.getPrototypeOf(value) === Object.prototype,
        echo: response.echo.value,
      };
    }, value),
    { global: true, own: true, prototype: true, echo: value },
  );
  assert.equal(await f.session.evaluate(() => counter), 1);
  assert.equal(await f.session.evaluate(() => undefined), null);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('chrome failures preserve the message when the Firefox stack contains only frames', async () => {
  const session = new ScreenshotBrowser();
  session.driver = {
    executeAsyncScript(script, args) {
      return new Promise((resolve) => vm.runInNewContext(script, { arguments: [args, resolve] }));
    },
  };
  await assert.rejects(
    session.chrome(() => {
      const error = new Error('Chrome refused');
      error.stack = 'chrome@fixture:1:2';
      throw error;
    }),
    /Chrome refused\nchrome@fixture:1:2/,
  );
  await assert.rejects(
    session.chrome(() => {
      throw null;
    }),
    { message: 'null\n' },
  );
});

test('sidebar reload navigates once and waits in chrome before evaluating the new document', async () => {
  const f = fixture();
  let reloads = 0;
  f.panel.reload = () => reloads++;
  f.session.driver = {
    async wait(predicate, timeout) {
      assert.equal(timeout, 15000);
      assert.equal(await predicate(), false);
      assert.equal(f.stats.loads, 0);
      f.panel.browsingContext.currentWindowGlobal.innerWindowId++;
      f.page.windowGlobalChild.innerWindowId++;
      assert.equal(await predicate(), true);
    },
  };
  await f.session.reloadSidebar();
  assert.equal(reloads, 1);
  assert.equal(f.stats.executions, 1);
  f.panel.browsingContext.currentWindowGlobal.documentURI.spec = 'about:blank';
  await assert.rejects(f.session.reloadSidebar(), /not the installed sidebar/);
  assert.equal(reloads, 1);
});

test('concurrent sidebar calls have independent one-shot listeners', async () => {
  const f = fixture();
  const values = await Promise.all(
    Array.from({ length: 12 }, () => f.session.evaluate(() => ++window.counter)),
  );
  assert.deepEqual(
    values.sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(new Set(f.names).size, 12);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('errors and synchronous frame-loading failures clean up without replay', async () => {
  const f = fixture();
  await assert.rejects(
    f.session.evaluate(async () => {
      window.counter++;
      const error = new Error('Evaluation refused');
      error.stack = 'evaluate@fixture:1:2';
      throw error;
    }),
    /Evaluation refused/,
  );
  assert.equal(f.page.counter, 1);
  assert.equal(f.stats.executions, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  const failed = fixture({ loadError: true });
  await assert.rejects(
    failed.session.evaluate(() => 1),
    /Frame script load failed/,
  );
  assert.equal(failed.stats.loads, 1);
  assert.equal(failed.stats.executions, 0);
  assert.equal(failed.listeners.size, 0);
  assert.equal(failed.timers.size, 0);
});

test('a sidebar timeout removes its listener and never repeats the evaluation', async () => {
  const f = fixture({ noReply: true });
  const pending = f.session.evaluate(() => 1);
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  await assert.rejects(pending, /Sidebar evaluation timed out/);
  assert.equal(f.stats.loads, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('the bridge refuses another document before injection or execution', async () => {
  const f = fixture();
  f.panel.browsingContext.currentWindowGlobal.documentURI.spec = 'https://example.com/';
  await assert.rejects(
    f.session.evaluate(() => 1),
    /not the installed sidebar/,
  );
  assert.equal(f.stats.loads, 0);
  const changed = fixture({
    beforeCompile({ page }) {
      page.windowGlobalChild.innerWindowId++;
    },
  });
  await assert.rejects(
    changed.session.evaluate(() => 1),
    /changed before evaluation/,
  );
  assert.equal(changed.stats.executions, 0);
  assert.equal(changed.listeners.size, 0);
  assert.equal(changed.timers.size, 0);
});

test('a reply from a replaced sidebar is rejected without replaying its side effects', async () => {
  const f = fixture({
    beforeReply({ panel }) {
      panel.browsingContext.currentWindowGlobal.innerWindowId++;
    },
  });
  await assert.rejects(
    f.session.evaluate(() => ++window.counter),
    /changed during evaluation/,
  );
  assert.equal(f.page.counter, 1);
  assert.equal(f.stats.executions, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});
