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

function pauseGets(api) {
  const get = api.tabs.get;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  api.tabs.get = async (id) => {
    const value = await get(id);
    start();
    await held;
    return value;
  };
  return { started, release, restore: () => (api.tabs.get = get) };
}

async function navigate(f) {
  await f.api.tabs.update(3, { url: new URL('/next', f.native.get(3).url).href });
}

for (const property of ['title', 'favIconUrl', 'status']) {
  test(`${property} during native refresh retries complete data and preserves topology`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    const other = await f.cache.tabsState(2);
    const saved = structuredClone(before.tabs);
    await navigate(f);
    f.resetStats();
    const held = pauseGets(f.api);
    const reading = f.cache.tabsState(1);
    await held.started;
    assert.equal(f.cache.isTabsStateCurrent(1, before.structureToken), false);
    assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), true);
    assert.equal(f.cache.isTabsRefreshPending(1, other.structureToken), false);
    const value = property === 'status' ? 'loading' : `Updated ${property}`;
    await f.api.tabs.update(3, { [property]: value });
    held.release();
    const after = await reading;
    assert.equal(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.get'], 4);
    assert.equal(f.stats().calls['tabs.query'] || 0, 0);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
    assert.deepEqual(before.tabs, saved);
    assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
    assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
    assert.equal(f.cache.isTabsStateCurrent(1, before.structureToken), true);
  });
}

test('a late metadata event cannot overwrite newer native data in a pending reply', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await navigate(f);
  f.native.get(3).title = 'Newer native title';
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  f.api.tabs.onUpdated.emit(3, { title: 'Older queued event' }, { windowId: 1 });
  held.release();
  const after = await reading;
  assert.equal(after.tabs.find((tab) => tab.id === 3).title, 'Newer native title');
  assert.equal(after.structureToken, before.structureToken);
});

test('metadata for another tab joins the bounded refresh and supersedes earlier patches', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(9, { title: 'Earlier patch' });
  await navigate(f);
  f.resetStats();
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  await f.api.tabs.update(9, { title: 'Latest native value' });
  held.release();
  const after = await reading;
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.stats().calls['tabs.get'], 5);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

test('a retry reads removed optional fields rather than retaining a stale icon', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await navigate(f);
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  await f.api.tabs.update(3, { title: 'No icon' });
  delete f.native.get(3).favIconUrl;
  held.release();
  const after = await reading;
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(
    Object.hasOwn(
      after.tabs.find((tab) => tab.id === 3),
      'favIconUrl',
    ),
    false,
  );
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

for (const properties of [
  { url: 'https://other.invalid/' },
  { isArticle: true },
  { active: true },
  { futureField: { opaque: true } },
]) {
  test(`${Object.keys(properties)} during a pending refresh still invalidates it`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await navigate(f);
    const held = pauseGets(f.api);
    const reading = f.cache.tabsState(1);
    await held.started;
    await f.api.tabs.update(3, properties);
    assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
    held.release();
    const after = await reading;
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('continuous metadata events stop after three get rounds and use a full query', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await navigate(f);
  f.resetStats();
  const get = f.api.tabs.get;
  let round = 0;
  f.api.tabs.get = async (id) => {
    const value = await get(id);
    if (id === 3) await f.api.tabs.update(3, { title: `Round ${++round}` });
    return value;
  };
  const after = await f.cache.tabsState(1);
  assert.equal(round, 3);
  assert.equal(f.stats().calls['tabs.get'], 6);
  assert.equal(f.stats().calls['tabs.query'], 1);
  assert.notEqual(after.structureToken, before.structureToken);
  assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

test('metadata bursts exceeding 32 IDs abandon pending retries and preserve another window', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const other = await f.cache.tabsState(2);
  await navigate(f);
  f.resetStats();
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  for (const tab of before.tabs) await f.api.tabs.update(tab.id, { title: `New ${tab.id}` });
  assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
  held.release();
  const after = await reading;
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(f.stats().calls['tabs.query'], 1);
  assert.notEqual(after.structureToken, before.structureToken);
  assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

test('failed retry and fallback preserve errors, release pending state and allow a later read', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await navigate(f);
  const query = f.api.tabs.query;
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  await f.api.tabs.update(3, { title: 'Changed' });
  f.api.tabs.get = async () => {
    throw new Error('Retry failed');
  };
  f.api.tabs.query = async () => {
    throw new Error('Fallback failed');
  };
  held.release();
  await assert.rejects(reading, /Fallback failed/);
  assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
  held.restore();
  f.api.tabs.query = query;
  assert.deepEqual(await f.cache.tabs(1), await query({ windowId: 1 }));
});

test('an event during the capped fallback query retries instead of accepting stale rows', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  await navigate(f);
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) => {
    const value = await get(id);
    if (id === 3) await f.api.tabs.update(3, { title: 'During get' });
    return value;
  };
  const query = f.api.tabs.query;
  let calls = 0;
  f.api.tabs.query = async (args) => {
    const rows = await query(args);
    if (++calls === 1) await f.api.tabs.update(3, { title: 'During fallback' });
    return rows;
  };
  const after = await f.cache.tabs(1);
  assert.equal(calls, 2);
  assert.equal(after.find((tab) => tab.id === 3).title, 'During fallback');
});

test('controller retains only the matching resolution while a metadata retry is unfinished', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = () => controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const before = await read();
  await controller.requestForTransport({ type: 'snapshot', windowId: 2 });
  const snapshot = structuredClone(before);
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  await navigate(f);
  const held = pauseGets(f.api);
  const reading = read();
  await held.started;
  await f.api.tabs.update(3, { title: 'Updated during read' });
  assert.equal(controller.cacheStats().resolvedWindows, 2);
  held.release();
  const after = await reading;
  assert.equal(
    after.tabs.find((tab) => tab.id === 5),
    before.tabs.find((tab) => tab.id === 5),
  );
  assert.equal(after.tabs.find((tab) => tab.id === 3).title, 'Updated during read');
  assert.deepEqual(before, snapshot);
  assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
  controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).tabs, after.tabs);
});

test('a structural discovery after retry replaces the retained controller resolution', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = () => controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const before = await read();
  await navigate(f);
  f.resetStats();
  const held = pauseGets(f.api);
  const reading = read();
  await held.started;
  await f.api.tabs.update(3, { title: 'During read' });
  f.native.get(3).futureNativeField = { newlyObserved: true };
  held.release();
  const after = await reading;
  assert.equal(f.stats().calls['tabs.query'], 1);
  assert.notEqual(
    after.tabs.find((tab) => tab.id === 5),
    before.tabs.find((tab) => tab.id === 5),
  );
  assert.deepEqual(after.tabs.find((tab) => tab.id === 3).futureNativeField, {
    newlyObserved: true,
  });
  assert.equal(before.tabs.find((tab) => tab.id === 3).futureNativeField, undefined);
});

test('disposal after a queued retry cannot retain a resolution or repopulate native lists', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await navigate(f);
  const held = pauseGets(f.api);
  const reading = f.cache.tabsState(1);
  await held.started;
  await f.api.tabs.update(3, { title: 'Queued before disposal' });
  f.cache.dispose();
  assert.equal(f.cache.isTabsRefreshPending(1, before.structureToken), false);
  held.release();
  assert.deepEqual((await reading).tabs, await f.api.tabs.query({ windowId: 1 }));
  assert(Object.values(f.cache.stats()).every((value) => value === 0));
});
