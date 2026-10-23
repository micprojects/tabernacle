import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { performanceFixture, performanceBrowser } from '../preview/performance-fixture.js';

async function closeWithoutTabEvents(fixture, windowId) {
  const removed = fixture.api.tabs.onRemoved.emit;
  fixture.api.tabs.onRemoved.emit = () => {};
  try {
    const ids = [...fixture.native.values()]
      .filter((tab) => tab.windowId === windowId)
      .map((tab) => tab.id);
    await fixture.api.tabs.remove(ids);
  } finally {
    fixture.api.tabs.onRemoved.emit = removed;
  }
  fixture.closeWindow(windowId);
}

test('window removal releases memberships after its native tab list was invalidated', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  const controller = createController(f.api);
  try {
    await controller.request({ type: 'snapshot', windowId: 1 });
    await controller.request({ type: 'snapshot', windowId: 2 });
    assert.equal(controller.cacheStats().memberships, 40);
    await f.api.tabs.update(2, { url: 'https://navigated.invalid/' });
    await closeWithoutTabEvents(f, 2);
    assert.equal(controller.cacheStats().treeOwners, 20);
    assert.equal(controller.cacheStats().memberships, 20);
    const open = await controller.request({ type: 'snapshot', windowId: 1 });
    assert.equal(open.tabs.length, 20);
    assert(open.tabs.every((tab) => tab.windowId === 1));
  } finally {
    await controller.dispose();
  }
});

test('a late native query cannot restore memberships for a removed known window', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  const controller = createController(f.api);
  let release;
  try {
    await controller.request({ type: 'snapshot', windowId: 1 });
    await f.api.tabs.update(2, { url: 'https://navigated.invalid/' });
    const query = f.api.tabs.query;
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    f.api.tabs.query = async (options) => {
      f.api.tabs.query = query;
      const result = await query(options);
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return result;
    };
    const reading = controller.request({ type: 'snapshot', windowId: 2 });
    await waiting;
    await closeWithoutTabEvents(f, 2);
    release();
    await reading;
    assert.equal(controller.cacheStats().memberships, 20);
    assert.equal(controller.cacheStats().treeOwners, 20);
  } finally {
    release?.();
    await controller.dispose();
  }
});

test('a cold membership read settling after window closure cannot retain closed rows', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.api.sessions.getTabValue = async (...args) => {
    const result = await get(...args);
    if (args[0] % 2 === 0) {
      started();
      await held;
    }
    return result;
  };
  try {
    const reading = controller.request({ type: 'snapshot', windowId: 1 });
    await waiting;
    await f.api.tabs.update(2, { url: 'https://navigated.invalid/' });
    await closeWithoutTabEvents(f, 2);
    release();
    const open = await reading;
    assert.equal(open.tabs.length, 20);
    assert.equal(controller.cacheStats().memberships, 20);
    assert.equal(controller.cacheStats().treeOwners, 20);
  } finally {
    release();
    await controller.dispose();
  }
});

test('cold global cleanup retains a tab moved out of the closing window', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  // This scenario controls native placement directly, so queries follow the Map
  // instead of the fixture's private window buckets.
  f.api.tabs.query = async ({ windowId } = {}) =>
    structuredClone(
      [...f.native.values()].filter((tab) => windowId == null || tab.windowId === windowId),
    );
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  let release, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let movedReads = 0;
  f.api.sessions.getTabValue = async (...args) => {
    const result = await get(...args);
    if (args[0] === 2) {
      movedReads++;
      started();
      await held;
    }
    return result;
  };
  try {
    const reading = controller.request({ type: 'snapshot', windowId: 1 });
    await waiting;
    f.api.tabs.onDetached.emit(2, { oldWindowId: 2 });
    f.native.get(2).windowId = 1;
    f.api.tabs.onAttached.emit(2, { newWindowId: 1 });
    const removed = f.api.tabs.onRemoved.emit;
    f.api.tabs.onRemoved.emit = () => {};
    await f.api.tabs.remove(
      [...f.native.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
    );
    f.api.tabs.onRemoved.emit = removed;
    f.api.windows.onRemoved.emit(2);
    release();
    const open = await reading;
    assert.equal(open.tabs.length, 21);
    assert.equal(open.tabs.find((tab) => tab.id === 2).treeId, 'perf-tab-2');
    assert.equal(controller.cacheStats().memberships, 21);
    assert.equal(movedReads, 1, 'a window-local absence must not evict the transferred membership');
    assert.deepEqual(f.memberships.get(2).fixtureUnknown, { retained: true });
  } finally {
    release();
    await controller.dispose();
  }
});

test('a failed authoritative query preserves unverified entries until a successful retry', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  const query = f.api.tabs.query;
  let release, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.api.sessions.getTabValue = async (...args) => {
    const result = await get(...args);
    if (args[0] % 2 === 0) {
      started();
      await held;
    }
    return result;
  };
  try {
    const reading = controller.request({ type: 'snapshot', windowId: 1 });
    await waiting;
    await f.api.tabs.update(2, { url: 'https://navigated.invalid/' });
    await closeWithoutTabEvents(f, 2);
    f.api.tabs.query = async () => {
      throw new Error('Temporary native read failure');
    };
    release();
    await assert.rejects(reading, /Temporary native read failure/);
    assert.equal(
      controller.cacheStats().memberships,
      36,
      'failed query cannot prove which cached entries remain live',
    );
    f.api.tabs.query = query;
    f.resetStats();
    const open = await controller.request({ type: 'snapshot', windowId: 1 });
    assert.equal(open.tabs.length, 20);
    assert.equal(controller.cacheStats().memberships, 20);
    assert.equal(f.stats().reads, 0, 'live memberships survived the failed query');
  } finally {
    release();
    f.api.tabs.query = query;
    await controller.dispose();
  }
});
