import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { performanceFixture, performanceBrowser } from '../preview/performance-fixture.js';
import { VIEW_KEY } from '../extension/src/model.js';

test('closed windows release temporary state and keep forgotten pins for open windows', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 120, windows: 12 }));
  const controller = createController(f.api);
  try {
    await f.api.sessions.setWindowValue(1, VIEW_KEY, {
      scopeId: null,
      collapsed: [],
      pinLayout: [{ kind: 'tab', id: 'perf-tab-1' }],
    });
    for (let windowId = 1; windowId <= 12; windowId++)
      await controller.request({ type: 'snapshot', windowId });
    await f.api.tabs.remove(1);
    assert.equal(controller.cacheStats().forgottenWindows, 1);
    for (let windowId = 2; windowId <= 12; windowId++) {
      const ids = [...f.native.values()]
        .filter((tab) => tab.windowId === windowId)
        .map((tab) => tab.id);
      await f.api.tabs.remove(ids);
      f.closeWindow(windowId);
      const sizes = controller.cacheStats();
      assert.equal(sizes.forgottenWindows, 1, 'the still-open window must keep its forgotten pins');
      assert.equal(sizes.treeOwners, f.native.size);
      assert.equal(sizes.tabTreeKeys, f.native.size);
      assert.equal(sizes.resolvedWindows, 12 - windowId);
    }
    await controller.request({ type: 'snapshot', windowId: 1 });
    assert.equal(controller.cacheStats().forgottenWindows, 0);
    await controller.dispose();
    assert(Object.values(controller.cacheStats()).every((value) => value === 0));
  } finally {
    controller.dispose();
  }
});

test('disposed controllers reject new work and release maps after pending reads settle', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 1 }));
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  f.api.sessions.getTabValue = async (...args) => {
    started();
    await held;
    return get(...args);
  };
  const reading = controller.request({ type: 'snapshot', windowId: 1 });
  await waiting;
  controller.dispose();
  await assert.rejects(controller.request({ type: 'snapshot', windowId: 1 }), /disposed/);
  release();
  await reading;
  await new Promise(setImmediate);
  assert(Object.values(controller.cacheStats()).every((value) => value === 0));
});

test('disposing a browser cache cannot be undone by an outstanding membership save', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 10, windows: 1 }));
  const cache = createBrowserCache(f.api);
  const set = f.api.sessions.setTabValue;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.api.sessions.setTabValue = async (...args) => {
    await held;
    return set(...args);
  };
  const saving = cache.saveMembership(1, { treeId: 'test', ancestors: [] });
  cache.dispose();
  release();
  await saving;
  assert(Object.values(cache.stats()).every((value) => value === 0));
});
