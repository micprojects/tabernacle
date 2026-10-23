import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

function fixture(t) {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  let highlighted;
  f.api.tabs.onHighlighted = {
    addListener: (listener) => (highlighted = listener),

    removeListener: () => {},
  };
  const cache = createBrowserCache(f.api);
  t.after(() => cache.dispose());
  return { ...f, cache, highlight: (tabIds) => highlighted({ windowId: 1, tabIds }) };
}

function pauseGet(api) {
  const get = api.tabs.get;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  api.tabs.get = async (id) => {
    const result = await get(id);
    start();
    await held;
    return result;
  };
  return { started, release };
}

test('activation reads affected native tabs and preserves immutable rows, topology and other windows', async (t) => {
  const f = fixture(t);
  const global = await f.cache.tabsState();
  const before = await f.cache.tabsState(1);
  const other = await f.cache.tabsState(2);
  const saved = structuredClone(before.tabs);
  f.resetStats();
  f.native.get(1).highlighted = false;
  await f.api.tabs.update(3, { active: true, highlighted: true, lastAccessed: 987654321 });
  const after = await f.cache.tabsState(1);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.equal(f.stats().calls['tabs.query'], 1, 'only the explicit reference query above');
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(after.positions, before.positions);
  assert.equal(after.tabs[2], before.tabs[2], 'unchanged rows remain shared');
  assert.deepEqual(before.tabs, saved);
  assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
  const nextGlobal = await f.cache.tabsState();
  assert.notEqual(nextGlobal.structureToken, global.structureToken);
  assert.equal(nextGlobal.tabs.find((tab) => tab.id === 3).lastAccessed, 987654321);
});

test('rapid selections, highlight changes and queued metadata coalesce without losing native fields', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(9, { title: 'Unrelated title', mutedInfo: { muted: true } });
  for (const id of [3, 5, 7, 3])
    await f.api.tabs.update(id, { active: true, lastAccessed: id * 100 });
  f.native.get(5).highlighted = true;
  f.highlight([3, 5]);
  const after = await f.cache.tabsState(1);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.equal(after.structureToken, before.structureToken);
  assert.deepEqual(
    after.tabs.filter((tab) => tab.active).map((tab) => tab.id),
    [3],
  );
  f.native.get(5).highlighted = false;
  f.highlight([3]);
  assert.equal((await f.cache.tabs(1)).find((tab) => tab.id === 5).highlighted, false);
});

for (const change of ['move', 'remove', 'metadata', 'activation']) {
  test(`${change} during selection reads retries native state without resurrecting stale rows`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { active: true });
    const held = pauseGet(f.api);
    const reading = f.cache.tabsState(1);
    await held.started;
    if (change === 'move') {
      f.native.get(3).index = 20;
      f.api.tabs.onMoved.emit(3, { windowId: 1 });
    } else if (change === 'remove') await f.api.tabs.remove(3);
    else if (change === 'metadata') await f.api.tabs.update(3, { title: 'During read' });
    else await f.api.tabs.update(5, { active: true });
    held.release();
    const after = await reading;
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(before.tabs.find((tab) => tab.id === 1).active, true);
  });
}

for (const changes of [
  { windowId: 2 },
  { pinned: false },
  { url: 'https://example.test/navigated' },
  { cookieStoreId: 'firefox-default' },
  { openerTabId: 9 },
  { futureNativeField: { keep: ['unknown'] } },
]) {
  test(`unannounced ${Object.keys(changes)} change during activation uses full resolution`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { active: true });
    Object.assign(f.native.get(3), changes);
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('failed selection reads use a full query; failed fallback propagates and remains retryable', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  await f.api.tabs.update(3, { active: true });
  const get = f.api.tabs.get;
  const query = f.api.tabs.query;
  f.api.tabs.get = async () => {
    throw new Error('Native read failed');
  };
  f.api.tabs.query = async () => {
    throw new Error('Fallback failed');
  };
  await assert.rejects(f.cache.tabs(1), /Fallback failed/);
  f.api.tabs.get = get;
  f.api.tabs.query = query;
  assert.deepEqual(await f.cache.tabs(1), await query({ windowId: 1 }));
});

test('cold and missing-ID activations retain the full native query path', async (t) => {
  const f = fixture(t);
  await f.api.tabs.update(3, { active: true });
  await f.cache.tabsState(1);
  f.resetStats();
  f.api.tabs.onActivated.emit({ windowId: 1 });
  await f.cache.tabsState(1);
  f.api.tabs.onActivated.emit({ windowId: 1, tabId: 999 });
  assert.deepEqual(await f.cache.tabs(1), await f.api.tabs.query({ windowId: 1 }));
  assert.equal(f.stats().calls['tabs.query'], 3);
});

test('disposing during selection reads never repopulates the cache', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  await f.api.tabs.update(3, { active: true });
  const held = pauseGet(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  f.cache.dispose();
  held.release();
  await reading;
  assert(Object.values(f.cache.stats()).every((value) => value === 0));
});

test('incoherent selection replies fall back to a single authoritative query', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(3, { active: true });
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) => ({ ...(await get(id)), active: true });
  const after = await f.cache.tabsState(1);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.notEqual(after.structureToken, before.structureToken);
});

test('bulk highlighting uses one full query instead of an unbounded set of native reads', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  f.resetStats();
  const ids = [...f.native.values()].filter((tab) => tab.windowId === 1).map((tab) => tab.id);
  for (const id of ids) f.native.get(id).highlighted = true;
  f.highlight(ids);
  const after = await f.cache.tabs(1);
  assert.equal(after.filter((tab) => tab.highlighted).length, ids.length);
  assert.equal(f.stats().calls['tabs.query'], 1);
  assert.equal(f.stats().calls['tabs.get'] || 0, 0);
});

test('activation while a cold query is pending cannot seed stale window state', async (t) => {
  const f = fixture(t);
  const query = f.api.tabs.query;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  f.api.tabs.query = async (args) => {
    const rows = await query(args);
    f.api.tabs.query = query;
    start();
    await held;
    return rows;
  };
  const reading = f.cache.tabsState();
  await started;
  await f.api.tabs.update(3, { active: true });
  release();
  assert.deepEqual((await reading).tabs, await query({}));
  assert.deepEqual(await f.cache.tabs(1), await query({ windowId: 1 }));
});

test('controller activation preserves durable data and recovers after a rejected native update', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  const before = await send('snapshot');
  const persisted = () =>
    structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  const saved = persisted();
  const update = f.api.tabs.update;
  f.api.tabs.update = async () => {
    throw new Error('Activation rejected');
  };
  await assert.rejects(
    send('activateTab', { id: 3, expandAncestors: false }),
    /Activation rejected/,
  );
  assert.deepEqual(persisted(), saved);
  assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  f.api.tabs.update = update;
  f.resetStats();
  const after = await send('activateTab', { id: 3, expandAncestors: false });
  assert.equal(after.tabs.find((tab) => tab.id === 3).active, true);
  assert.deepEqual(persisted(), saved);
  assert.equal(f.stats().writes, 0);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  await controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).tabs, after.tabs);
  assert.deepEqual(persisted(), saved);
});
