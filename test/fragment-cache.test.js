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

test('fragment navigation reads complete native records and preserves other rows and windows', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const other = await f.cache.tabsState(2);
  const saved = structuredClone(before.tabs);
  f.resetStats();
  await f.api.tabs.update(3, { url: f.native.get(3).url + '#section', title: 'Section' });
  const after = await f.cache.tabsState(1);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(after.positions, before.positions);
  assert.equal(after.tabs[2], before.tabs[2]);
  assert.deepEqual(before.tabs, saved);
  assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

for (const change of ['path', 'query', 'internal', 'unknown', 'pinned']) {
  test(`fragment refresh falls back on ${change} changes`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { url: f.native.get(3).url + '#section' });
    const tab = f.native.get(3);
    if (change === 'path') tab.url = 'https://different.invalid/';
    if (change === 'query') tab.url = tab.url.split('?')[0] + '?changed';
    if (change === 'internal') tab.url = f.api.runtime.getURL('settings.html');
    if (change === 'unknown') tab.futureField = { kept: ['complete'] };
    if (change === 'pinned') tab.pinned = !tab.pinned;
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

for (const change of ['metadata', 'fragment', 'remove', 'move', 'dispose']) {
  test(`${change} during fragment reads cannot revive stale native state`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { url: f.native.get(3).url + '#one' });
    const get = f.api.tabs.get;
    let started, release;
    const waiting = new Promise((resolve) => (started = resolve));
    const held = new Promise((resolve) => (release = resolve));
    f.api.tabs.get = async (id) => {
      const result = await get(id);
      started();
      await held;
      return result;
    };
    const reading = f.cache.tabsState(1);
    await waiting;
    if (change === 'metadata') await f.api.tabs.update(3, { title: 'Latest' });
    if (change === 'fragment')
      await f.api.tabs.update(3, { url: f.native.get(3).url.replace('#one', '#two') });
    if (change === 'remove') await f.api.tabs.remove(3);
    if (change === 'move') {
      f.native.get(3).index = 25;
      f.api.tabs.onMoved.emit(3, { windowId: 1 });
    }
    if (change === 'dispose') f.cache.dispose();
    release();
    const after = await reading;
    if (change === 'dispose') assert(Object.values(f.cache.stats()).every((n) => n === 0));
    else {
      if (change === 'metadata') assert.equal(after.structureToken, before.structureToken);
      else assert.notEqual(after.structureToken, before.structureToken);
      assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
    }
  });
}

test('failed fragment get/query reads remain retryable', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  await f.api.tabs.update(3, { url: f.native.get(3).url + '#section' });
  const get = f.api.tabs.get;
  const query = f.api.tabs.query;
  f.api.tabs.get = async () => {
    throw new Error('Get failed');
  };
  f.api.tabs.query = async () => {
    throw new Error('Query failed');
  };
  await assert.rejects(f.cache.tabsState(1), /Query failed/);
  f.api.tabs.get = get;
  f.api.tabs.query = query;
  assert.deepEqual(await f.cache.tabs(1), await query({ windowId: 1 }));
});

test('bursts coalesce and bulk fragment changes keep bounded native reads', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const address = f.native.get(3).url;
  for (let i = 0; i < 20; i++) await f.api.tabs.update(3, { url: address + '#' + i });
  f.resetStats();
  const after = await f.cache.tabsState(1);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(after.tabs.find((tab) => tab.id === 3).url, address + '#19');
  assert.equal(f.stats().calls['tabs.get'], 2);
  for (const tab of after.tabs) await f.api.tabs.update(tab.id, { url: tab.url + '#bulk' });
  f.resetStats();
  await f.cache.tabsState(1);
  assert.equal(f.stats().calls['tabs.get'] || 0, 0);
  assert.equal(f.stats().calls['tabs.query'], 1);
});

test('controller fragment refresh preserves old snapshots and durable organisation across restart', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = () => controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const before = await read();
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  const url = f.native.get(3).url + '#section';
  await f.api.tabs.update(3, { url });
  const after = await read();
  assert.equal(after.tabs.find((tab) => tab.id === 3).url, url);
  assert.notEqual(before.tabs.find((tab) => tab.id === 3).url, url);
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
