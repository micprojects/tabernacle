import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

function fixture(t) {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const cache = createBrowserCache(f.api);
  t.after(() => cache.dispose());
  return { ...f, cache };
}

for (const url of [
  'https://other.invalid/next',
  'http://other.invalid/next',
  'https://other.invalid:8443/next#part',
]) {
  test(`announced navigation to ${url} validates complete native data`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    const other = await f.cache.tabsState(2);
    const saved = structuredClone(before.tabs);
    f.resetStats();
    await f.api.tabs.update(3, { url, status: 'complete', title: 'Other site' });
    delete f.native.get(3).favIconUrl;
    const after = await f.cache.tabsState(1);
    assert.equal(after.structureToken, before.structureToken);
    assert.equal(after.positions, before.positions);
    assert.equal(f.stats().calls['tabs.get'], 2);
    assert.equal(f.stats().calls['tabs.query'] || 0, 0);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
    assert.deepEqual(before.tabs, saved);
    assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
    assert.equal(after.tabs[2], before.tabs[2]);
    assert.equal(
      Object.hasOwn(
        after.tabs.find((tab) => tab.id === 3),
        'favIconUrl',
      ),
      false,
    );
  });
}

for (const field of ['cookieStoreId', 'groupId', 'futureField', 'pinned', 'url']) {
  test(`cross-origin native ${field} mismatch still requires a full query`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { url: 'https://other.invalid/next' });
    f.native.get(3)[field] = field === 'pinned' ? !f.native.get(3).pinned : 'unannounced';
    f.resetStats();
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.query'], 1);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

for (const from of ['about:blank', 'moz-extension://fixture/settings.html', 'http://[']) {
  test(`navigation from ${from} keeps the authoritative full query`, async (t) => {
    const f = fixture(t);
    f.native.get(3).url = from;
    const before = await f.cache.tabsState(1);
    f.resetStats();
    await f.api.tabs.update(3, { url: 'https://other.invalid/next' });
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.get'] || 0, 0);
    assert.equal(f.stats().calls['tabs.query'], 1);
  });
}

test('cross-origin metadata retry discards a stale complete native reply', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(3, { url: 'https://other.invalid/next', title: 'Loading' });
  const get = f.api.tabs.get;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  f.api.tabs.get = async (id) => {
    const result = await get(id);
    start();
    await held;
    return result;
  };
  f.resetStats();
  const reading = f.cache.tabsState(1);
  await started;
  await f.api.tabs.update(3, { title: 'Latest site title', status: 'complete' });
  delete f.native.get(3).favIconUrl;
  release();
  const after = await reading;
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.stats().calls['tabs.get'], 4);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

test('cross-origin controller refresh preserves durable organisation and restart results', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = () => controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const before = await read();
  const savedRows = structuredClone(before.tabs);
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  await f.api.tabs.update(3, { url: 'https://other.invalid/next', title: 'Different site' });
  delete f.native.get(3).favIconUrl;
  const after = await read();
  assert.deepEqual(before.tabs, savedRows);
  const old = before.tabs.find((tab) => tab.id === 3);
  const next = after.tabs.find((tab) => tab.id === 3);
  assert.equal(next.url, 'https://other.invalid/next');
  assert.equal(Object.hasOwn(next, 'favIconUrl'), false);
  for (const field of ['groupId', 'order', 'treeId', 'ancestors', 'collapsed', 'parentTabId'])
    assert.deepEqual(next[field], old[field]);
  assert.equal(
    after.tabs.find((tab) => tab.id === 5),
    before.tabs.find((tab) => tab.id === 5),
  );
  await controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).tabs, after.tabs);
  assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
});

test('a late cross-origin get cannot retain memberships from a closed window', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 40, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  await controller.request({ type: 'snapshot', windowId: 1 });
  await f.api.tabs.update(2, { url: 'https://other.invalid/next' });
  const get = f.api.tabs.get;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  f.api.tabs.get = async (id) => {
    const result = await get(id);
    start();
    await held;
    return result;
  };
  const reading = controller.request({ type: 'snapshot', windowId: 2 });
  await started;
  const emit = f.api.tabs.onRemoved.emit;
  try {
    f.api.tabs.onRemoved.emit = () => {};
    await f.api.tabs.remove(
      [...f.native.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
    );
  } finally {
    f.api.tabs.onRemoved.emit = emit;
    f.closeWindow(2);
    release();
  }
  await reading;
  assert.equal(controller.cacheStats().memberships, 20);
  assert.equal(controller.cacheStats().treeOwners, 20);
  assert.equal((await controller.request({ type: 'snapshot', windowId: 1 })).tabs.length, 20);
});
