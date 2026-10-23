import assert from 'node:assert/strict';
import test from 'node:test';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

function fixture(count = 2000) {
  const data = performanceFixture({ tabs: count, windows: 2 });
  for (const tab of data.tabs) tab.windowId = tab.id <= 4 ? 1 : 2;
  const browser = performanceBrowser(data);
  const controller = createController(browser.api);
  const send = (type = 'snapshot', values = {}, windowId = 1) =>
    controller.request({ type, windowId, ...values });
  return { ...browser, controller, send };
}

// Observe actual Map traversals only during this request. Large ownership Maps
// must not be cloned or scanned for a small-window metadata refresh. Tree-key
// lookups also distinguish a resolved-tree reuse from another full resolution.
async function mapProbe(work, globalSize = 2000) {
  const stats = { globalVisits: 0, treeKeyReads: 0 };
  const originals = new Map();
  for (const name of [Symbol.iterator, 'entries', 'keys', 'values']) {
    const original = Map.prototype[name];
    originals.set(name, original);
    Map.prototype[name] = function* (...args) {
      const global = this.size >= globalSize;
      for (const item of original.apply(this, args)) {
        if (global) stats.globalVisits++;
        yield item;
      }
    };
  }
  const get = Map.prototype.get;
  const forEach = Map.prototype.forEach;
  Map.prototype.get = function (key) {
    if (typeof key === 'string' && key.startsWith('perf-tab-')) stats.treeKeyReads++;
    return get.call(this, key);
  };
  Map.prototype.forEach = function (callback, receiver) {
    const global = this.size >= globalSize;
    return forEach.call(this, (value, key, map) => {
      if (global) stats.globalVisits++;
      callback.call(receiver, value, key, map);
    });
  };
  try {
    return { result: await work(), stats };
  } finally {
    for (const [name, original] of originals) Map.prototype[name] = original;
    Map.prototype.get = get;
    Map.prototype.forEach = forEach;
  }
}

function pauseMembership(api, id) {
  const get = api.sessions.getTabValue;
  let started, release;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  api.sessions.getTabValue = async (...args) => {
    if (args[0] === id) {
      started();
      await held;
    }
    return get(...args);
  };
  return { waiting, release, restore: () => (api.sessions.getTabValue = get) };
}

test('small-window title refreshes do not traverse global ownership or resolve trees again', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  const before = await f.send();
  assert.equal(f.controller.cacheStats().treeOwners, 2000);
  assert.equal(f.controller.cacheStats().tabWindows, 2000);
  f.resetStats();
  for (let index = 0; index < 100; index++)
    await f.api.tabs.update(1, { title: `Title ${index}`, mutedInfo: { muted: index % 2 === 0 } });
  const { result: after, stats } = await mapProbe(() => f.send());
  assert.equal(after.tabs[0].title, 'Title 99');
  assert.deepEqual(after.tabs[0].mutedInfo, { muted: false });
  assert.equal(before.tabs[0].title.includes('Fixture'), true);
  assert.equal(stats.globalVisits, 0);
  assert.equal(stats.treeKeyReads, 0);
  assert.equal(f.stats().reads, 0);
  assert.equal(f.stats().writes, 0);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.equal(after.tabs[1].treeId, before.tabs[1].treeId);
  assert.deepEqual(after.tabs[1].ancestors, before.tabs[1].ancestors);
});

test('window-local structural reads update indexes without walking global ownership', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.send();
  await f.api.tabs.update(1, { url: 'https://example.test/new', futureNative: { nested: [1] } });
  const { result, stats } = await mapProbe(() => f.send());
  assert.equal(result.tabs[0].url, 'https://example.test/new');
  assert.deepEqual(result.tabs[0].futureNative, { nested: [1] });
  assert.equal(stats.globalVisits, 0);
  assert(stats.treeKeyReads > 0);
  assert.equal(f.controller.cacheStats().treeOwners, 2000);
  assert.equal(f.controller.cacheStats().tabTreeKeys, 2000);
  assert.equal(f.controller.cacheStats().tabWindows, 2000);
});

test('folder names, appearance and hierarchy reuse tab resolution while folder-ID changes refresh it', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  f.memberships.get(1).groupId = '11111111-1111-4111-8111-111111111111';
  assert.equal((await f.send()).tabs[0].groupId, null);
  for (const [type, values] of [
    ['renameGroup', { id: 'perf-folder-0', name: 'Renamed' }],
    ['setGroupAppearance', { id: 'perf-folder-0', appearance: { color: 'blue' } }],
    ['moveGroup', { id: 'perf-folder-1', parentId: null }],
  ]) {
    const { stats } = await mapProbe(() => f.send(type, values));
    assert.equal(stats.globalVisits, 0, type);
    assert.equal(stats.treeKeyReads, 0, type);
  }
  const { result, stats } = await mapProbe(() =>
    f.send('createGroup', { id: '11111111-1111-4111-8111-111111111111', name: 'Now available' }),
  );
  assert.equal(result.tabs[0].groupId, '11111111-1111-4111-8111-111111111111');
  assert.equal(stats.globalVisits, 0);
  assert(stats.treeKeyReads > 0);
});

test('known-window membership writes leave another window’s resolution reusable', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.send();
  await f.send('snapshot', {}, 2);
  await f.send('toggleTab', { id: 5 }, 2);
  const { result, stats } = await mapProbe(() => f.send());
  assert.equal(result.tabs.length, 4);
  assert.equal(stats.globalVisits, 0);
  assert.equal(stats.treeKeyReads, 0);
});

test('new identity repairs reuse another window’s resolution without publishing partial owners', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.send();
  const before = await f.send('snapshot', {}, 2);
  const created = await f.api.tabs.create({ windowId: 1 });
  const set = f.api.sessions.setTabValue;
  f.api.sessions.setTabValue = async (...args) => {
    assert.equal(f.controller.cacheStats().treeOwners, 2000);
    assert.equal(f.controller.cacheStats().tabWindows, 2000);
    return set(...args);
  };
  const repaired = await f.send();
  const row = repaired.tabs.find((tab) => tab.id === created.id);
  assert.equal(typeof row.treeId, 'string');
  assert.equal(row.treeId, f.memberships.get(created.id).treeId);
  const { result, stats } = await mapProbe(() => f.send('snapshot', {}, 2));
  assert.deepEqual(result.tabs, before.tabs);
  assert.equal(stats.treeKeyReads, 0);
  assert.equal(f.controller.cacheStats().treeOwners, 2001);
});

test('a membership write with unknown window ownership invalidates every resolved window', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  await f.send();
  await f.send('snapshot', {}, 2);
  const created = await f.api.tabs.create({ windowId: 2, url: 'https://example.test/new' });
  f.memberships.set(created.id, { treeId: 'new-identity', order: 100, savedForLaterAt: 1 });
  await f.send('returnFromLater', { id: created.id }, 2);
  const { stats } = await mapProbe(() => f.send());
  assert.equal(stats.globalVisits, 0);
  assert(stats.treeKeyReads > 0);
  assert.equal(f.controller.cacheStats().treeOwners, 2001);
});

test('metadata refreshes preserve native unknown fields and all resolved membership fields', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  Object.assign(f.native.get(1), { groupId: 77, futureNative: { opaque: ['retained'] } });
  const before = await f.send();
  await f.api.tabs.update(1, { title: 'Metadata', mutedInfo: { muted: true } });
  const after = await f.send();
  const row = after.tabs.find((tab) => tab.id === 1);
  const previous = before.tabs.find((tab) => tab.id === 1);
  assert.equal(row.nativeGroupId, 77);
  for (const key of [
    'groupId',
    'treeId',
    'ancestors',
    'order',
    'openedAt',
    'collapsed',
    'parentTabId',
  ])
    assert.deepEqual(row[key], previous[key], key);
  assert.deepEqual(row.futureNative, { opaque: ['retained'] });
  assert.equal(row.title, 'Metadata');
  assert.notEqual(previous.title, row.title);
  assert.deepEqual(previous.mutedInfo, { muted: false });
});

test('native position sharing preserves differently ordered and filtered presentation rows', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  f.native.get(2).incognito = true;
  f.native.get(3).url = f.api.runtime.getURL('settings.html');
  const query = f.api.tabs.query;
  f.api.tabs.query = async (...args) => (await query(...args)).reverse();
  const before = await f.send();
  assert.deepEqual(
    before.tabs.map((tab) => tab.id),
    [1, 4],
  );
  await f.api.tabs.update(1, { title: 'Correct native position' });
  const after = await f.send();
  assert.deepEqual(
    after.tabs.map((tab) => tab.id),
    [1, 4],
  );
  assert.equal(after.tabs[0].title, 'Correct native position');
  assert.deepEqual(after.tabs[1], before.tabs[1]);
  assert.notEqual(before.tabs[0].title, after.tabs[0].title);
  await f.api.tabs.remove(1);
  await f.api.tabs.update(4, { title: 'Remaining row' });
  assert.deepEqual(
    (await f.send()).tabs.map(({ id, title }) => ({ id, title })),
    [{ id: 4, title: 'Remaining row' }],
  );
});

for (const properties of [
  { title: 'While memberships load' },
  { url: 'https://example.test/changed', futureNative: { current: true } },
]) {
  test(`${Object.keys(properties).join('/')} during the initial read cannot publish stale native rows`, async (t) => {
    const f = fixture(20);
    t.after(() => f.controller.dispose());
    const held = pauseMembership(f.api, 1);
    const reading = f.send();
    await held.waiting;
    await f.api.tabs.update(1, properties);
    held.restore();
    held.release();
    const state = await reading;
    for (const [key, value] of Object.entries(properties))
      assert.deepEqual(state.tabs[0][key], value);
    assert.equal(f.controller.cacheStats().treeOwners, 20);
    assert.equal(f.controller.cacheStats().tabTreeKeys, 20);
    assert.equal(f.controller.cacheStats().tabWindows, 20);
    assert.equal(f.stats().writes, 0);
  });
}

test('another window closing an identity owner during a read preserves the restored identity', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  await f.send();
  const saved = structuredClone(f.memberships.get(20));
  const restored = await f.api.tabs.create({ windowId: 1, url: 'https://example.test/restored' });
  f.memberships.set(restored.id, saved);
  const held = pauseMembership(f.api, restored.id);
  const reading = f.send();
  await held.waiting;
  await f.api.tabs.remove(20);
  held.restore();
  held.release();
  const state = await reading;
  assert.equal(state.tabs.find((tab) => tab.id === restored.id).treeId, saved.treeId);
  assert.equal(f.memberships.get(restored.id).treeId, saved.treeId);
  assert.equal(f.controller.cacheStats().treeOwners, 20);
  assert.equal(f.controller.cacheStats().tabTreeKeys, 20);
  assert.equal(f.controller.cacheStats().tabWindows, 20);
});

test('failed repairs commit no partial ownership index and retry already saved identities safely', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  await f.send();
  const untouched = await f.send('snapshot', {}, 2);
  const first = await f.api.tabs.create({ windowId: 1 });
  const second = await f.api.tabs.create({ windowId: 1 });
  const set = f.api.sessions.setTabValue;
  f.api.sessions.setTabValue = async (...args) => {
    if (args[0] === second.id) throw new Error('Repair unavailable');
    return set(...args);
  };
  await assert.rejects(f.send(), /Repair unavailable/);
  const partial = structuredClone(f.memberships.get(first.id));
  assert.equal(typeof partial.treeId, 'string');
  assert.equal(f.memberships.has(second.id), false);
  for (const key of ['treeOwners', 'tabTreeKeys', 'tabWindows'])
    assert.equal(f.controller.cacheStats()[key], 20, key);
  const { result, stats } = await mapProbe(() => f.send('snapshot', {}, 2));
  assert.deepEqual(result.tabs, untouched.tabs);
  assert.equal(stats.treeKeyReads, 0);
  f.api.sessions.setTabValue = set;
  const after = await f.send();
  assert.equal(after.tabs.find((tab) => tab.id === first.id).treeId, partial.treeId);
  assert.equal(new Set(after.tabs.map((tab) => tab.treeId)).size, 6);
  for (const key of ['treeOwners', 'tabTreeKeys', 'tabWindows'])
    assert.equal(f.controller.cacheStats()[key], 22, key);
});

test('a duplicate in another window gets a new identity without displacing its live owner', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  await f.send();
  const original = structuredClone(f.memberships.get(20));
  const duplicate = await f.api.tabs.create({ windowId: 1 });
  f.memberships.set(duplicate.id, { ...original, collapsed: true, savedForLaterAt: 1 });
  const after = await f.send();
  const copied = after.tabs.find((tab) => tab.id === duplicate.id);
  assert.notEqual(copied.treeId, original.treeId);
  assert.equal(copied.collapsed, false);
  assert.equal(copied.savedForLaterAt, undefined);
  assert.deepEqual(f.memberships.get(20), original);
  for (const key of ['treeOwners', 'tabTreeKeys', 'tabWindows'])
    assert.equal(f.controller.cacheStats()[key], 21, key);
});

test('container replacement transfers identity indexes and disposal releases every owned map', async () => {
  const f = fixture(20);
  try {
    await f.send();
    const before = structuredClone(f.memberships.get(6));
    const result = await f.send(
      'reopenInContainer',
      { id: 6, cookieStoreId: 'firefox-default' },
      2,
    );
    const replacement = result.tabs.find((tab) => tab.id === result.reopenedTabId);
    assert.equal(replacement.treeId, before.treeId);
    assert.equal(replacement.cookieStoreId, 'firefox-default');
    assert.equal(f.native.has(6), false);
    for (const key of ['treeOwners', 'tabTreeKeys', 'tabWindows'])
      assert.equal(f.controller.cacheStats()[key], 20, key);
    await f.controller.dispose();
    assert(Object.values(f.controller.cacheStats()).every((value) => value === 0));
  } finally {
    await f.controller.dispose();
  }
});

test('a structural event while a repair is pending retries before publishing ownership', async (t) => {
  const f = fixture(20);
  t.after(() => f.controller.dispose());
  await f.send();
  const untouched = await f.send('snapshot', {}, 2);
  const created = await f.api.tabs.create({ windowId: 1 });
  const set = f.api.sessions.setTabValue;
  let started, release;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.api.sessions.setTabValue = async (...args) => {
    if (args[0] === created.id) {
      started();
      await held;
    }
    return set(...args);
  };
  const reading = f.send();
  await waiting;
  await f.api.tabs.update(created.id, { url: 'https://example.test/while-saving' });
  release();
  const state = await reading;
  assert.equal(
    state.tabs.find((tab) => tab.id === created.id).url,
    'https://example.test/while-saving',
  );
  assert.equal(f.controller.cacheStats().treeOwners, 21);
  assert.equal(f.controller.cacheStats().tabTreeKeys, 21);
  assert.equal(f.controller.cacheStats().tabWindows, 21);
  // The saved repair's native evidence became stale while awaiting the write.
  // Keep the conservative global invalidation in that case.
  const { result, stats } = await mapProbe(() => f.send('snapshot', {}, 2));
  assert.deepEqual(result.tabs, untouched.tabs);
  assert(stats.treeKeyReads > 0);
});
