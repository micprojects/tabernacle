import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCache } from '../extension/src/browser-cache.js';

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),

    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fixture(rows = [{ id: 1, windowId: 1, title: 'Before' }]) {
  const native = structuredClone(rows);
  const counts = { copies: 0, queries: [] };

  // Instrument only arrays returned by this fixture. No production counters or
  // global prototype changes are needed to count full-list metadata copies.
  class MeasuredTabs extends Array {
    slice(...args) {
      counts.copies++;
      return super.slice(...args);
    }
  }

  const api = {
    tabs: {
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
      onMoved: event(),
      onAttached: event(),
      onDetached: event(),

      async query(query = {}) {
        counts.queries.push(query);
        return MeasuredTabs.from(
          native.filter((tab) => query.windowId === undefined || tab.windowId === query.windowId),
          (tab) => structuredClone(tab),
        );
      },
    },
    windows: { onRemoved: event() },
    sessions: {},
  };
  const cache = createBrowserCache(api);

  function update(id, properties) {
    const tab = native.find((row) => row.id === id);
    Object.assign(tab, structuredClone(properties));
    api.tabs.onUpdated.emit(id, properties, { windowId: tab.windowId });
  }

  return { api, cache, counts, native, update };
}

function pauseNextQuery(api) {
  const query = api.tabs.query;
  let release, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  api.tabs.query = async (args) => {
    api.tabs.query = query;
    const result = await query(args);
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return result;
  };
  return { waiting, release: () => release() };
}

test('metadata bursts copy a settled window array once per consumed batch', async (t) => {
  const f = fixture(
    Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, windowId: 1, title: `${index}` })),
  );
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  for (let index = 0; index < 4000; index++)
    f.update((index % 20) + 1, { title: `Changed ${index}`, audible: index % 2 === 0 });
  assert.equal(f.counts.copies, 0);
  const after = await f.cache.tabsState(1);
  assert.equal(f.counts.copies, 1);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(after.positions, before.positions);
  assert.notEqual(after.tabs, before.tabs);
  assert.equal(after.tabs[0].title, 'Changed 3980');
  assert.equal(after.tabs[19].title, 'Changed 3999');
  assert.equal(before.tabs[0].title, '0');
  assert.equal(after.tabs[20], before.tabs[20]);
  assert.notEqual(after.tabs[0], before.tabs[0]);
  assert.equal(await f.cache.tabs(1), after.tabs);
  assert.equal((await f.cache.tabsState(1)).tabs, after.tabs);
  assert.equal(f.counts.copies, 1);
  f.update(1, { status: 'complete', discarded: true });
  const second = await f.cache.tabsState(1);
  assert.equal(f.counts.copies, 2);
  assert.equal(second.tabs[0].title, 'Changed 3980');
  assert.equal(second.tabs[0].discarded, true);
  assert.equal(after.tabs[0].discarded, undefined);
  assert.equal(second.structureToken, before.structureToken);
  assert.deepEqual(f.counts.queries, [{ windowId: 1 }]);
});

test('shared native positions follow structural changes without rewriting held indexes', async (t) => {
  const f = fixture([1, 2, 3].map((id) => ({ id, windowId: 1, title: `Tab ${id}` })));
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  assert.deepEqual(
    [...before.positions],
    [
      [1, 0],
      [2, 1],
      [3, 2],
    ],
  );
  f.native.reverse();
  f.api.tabs.onMoved.emit(3, { windowId: 1 });
  const moved = await f.cache.tabsState(1);
  assert.notEqual(moved.positions, before.positions);
  assert.deepEqual(
    [...moved.positions],
    [
      [3, 0],
      [2, 1],
      [1, 2],
    ],
  );
  f.update(1, { title: 'Moved then updated' });
  const updated = await f.cache.tabsState(1);
  assert.equal(updated.positions, moved.positions);
  assert.equal(updated.tabs[updated.positions.get(1)].title, 'Moved then updated');
  f.native.splice(1, 1);
  f.api.tabs.onRemoved.emit(2, { windowId: 1 });
  const removed = await f.cache.tabsState(1);
  assert.deepEqual(
    [...removed.positions],
    [
      [3, 0],
      [1, 1],
    ],
  );
  assert.deepEqual(
    [...before.positions],
    [
      [1, 0],
      [2, 1],
      [3, 2],
    ],
  );
  assert.deepEqual(
    [...moved.positions],
    [
      [3, 0],
      [2, 1],
      [1, 2],
    ],
  );
});

test('metadata patches own event values and preserve unknown nested row fields', async (t) => {
  const f = fixture([
    {
      id: 1,
      windowId: 1,
      title: 'Before',
      mutedInfo: { muted: false, opaque: { version: 1 } },
      futureNativeField: { entries: [{ value: 'preserved' }] },
    },
  ]);
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  Object.freeze(before.tabs[0]);
  Object.freeze(before.tabs);
  const properties = { title: 'After', mutedInfo: { muted: true, opaque: { version: 2 } } };
  f.update(1, properties);
  properties.title = 'Mutated by event producer';
  properties.mutedInfo.muted = false;
  properties.mutedInfo.opaque.version = 99;
  f.update(1, { favIconUrl: 'https://example.test/icon.png' });
  const after = await f.cache.tabsState(1);
  assert.equal(after.tabs[0].title, 'After');
  assert.deepEqual(after.tabs[0].mutedInfo, { muted: true, opaque: { version: 2 } });
  assert.deepEqual(before.tabs[0].mutedInfo, { muted: false, opaque: { version: 1 } });
  assert.deepEqual(after.tabs[0].futureNativeField, { entries: [{ value: 'preserved' }] });
  assert.equal(after.tabs[0].futureNativeField, before.tabs[0].futureNativeField);
  assert.equal(after.tabs[0].favIconUrl, 'https://example.test/icon.png');
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.counts.copies, 1);
});

test('later nested metadata replaces the whole property instead of merging old subfields', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  await f.cache.tabs(1);
  f.update(1, { mutedInfo: { muted: true, reason: 'user', opaque: { old: true } }, title: 'New' });
  f.update(1, { mutedInfo: { muted: false } });
  const [tab] = await f.cache.tabs(1);
  assert.deepEqual(tab.mutedInfo, { muted: false });
  assert.equal(tab.title, 'New');
  assert.equal(f.counts.copies, 1);
});

test('warm simultaneous readers share one flushed array and the latest metadata', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  const first = f.cache.tabsState(1);
  const second = f.cache.tabs(1);
  f.update(1, { title: 'During read' });
  const [state, tabs] = await Promise.all([first, second]);
  assert.equal(state.tabs, tabs);
  assert.equal(state.tabs[0].title, 'During read');
  assert.equal(state.structureToken, before.structureToken);
  assert.equal(f.counts.copies, 1);
  assert.equal(before.tabs[0].title, 'Before');
});

for (const properties of [
  { url: 'https://example.test/new' },
  { pinned: true },
  { hidden: true },
  { groupId: 7 },
  { cookieStoreId: 'firefox-container-2' },
  { active: true },
  { lastAccessed: 42 },
  { title: 'Unknown change', futureNativeField: { nested: ['kept'] } },
]) {
  test(`${Object.keys(properties).join('/')} invalidates the structural token and queries`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    const before = await f.cache.tabsState(1);
    f.update(1, { title: 'Queued metadata' });
    f.update(1, properties);
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    for (const [key, value] of Object.entries(properties))
      assert.deepEqual(after.tabs[0][key], value);
    assert.equal(before.tabs[0].title, 'Before');
    assert.equal(f.counts.copies, 0);
    assert.deepEqual(f.counts.queries, [{ windowId: 1 }, { windowId: 1 }]);
  });
}

test('explicit invalidation replaces only the affected window token and abandons queued patches', async (t) => {
  const f = fixture([
    { id: 1, windowId: 1, title: 'One' },
    { id: 2, windowId: 2, title: 'Two' },
  ]);
  t.after(() => f.cache.dispose());
  const one = await f.cache.tabsState(1);
  const two = await f.cache.tabsState(2);
  f.update(1, { title: 'Updated' });
  f.cache.invalidateTabs(1);
  const oneAfter = await f.cache.tabsState(1);
  const twoAfter = await f.cache.tabsState(2);
  assert.notEqual(oneAfter.structureToken, one.structureToken);
  assert.equal(twoAfter.structureToken, two.structureToken);
  assert.equal(oneAfter.tabs[0].title, 'Updated');
  assert.equal(f.counts.copies, 0);
  f.cache.invalidateTabs();
  assert.notEqual((await f.cache.tabsState(1)).structureToken, oneAfter.structureToken);
  assert.notEqual((await f.cache.tabsState(2)).structureToken, twoAfter.structureToken);
});

test('metadata during an unsettled window query retries authoritative native data', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const paused = pauseNextQuery(f.api);
  const reading = f.cache.tabsState(1);
  await paused.waiting;
  f.update(1, { title: 'During native read' });
  paused.release();
  const state = await reading;
  assert.equal(state.tabs[0].title, 'During native read');
  assert.equal((await f.cache.tabsState(1)).structureToken, state.structureToken);
  assert.deepEqual(f.counts.queries, [{ windowId: 1 }, { windowId: 1 }]);
  assert.equal(f.counts.copies, 0);
});

test('metadata invalidates the global list while retaining a settled window token', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const globalBefore = await f.cache.tabsState();
  const windowBefore = await f.cache.tabsState(1);
  f.update(1, { title: 'Changed' });
  const globalAfter = await f.cache.tabsState();
  const windowAfter = await f.cache.tabsState(1);
  assert.notEqual(globalAfter.structureToken, globalBefore.structureToken);
  assert.equal(windowAfter.structureToken, windowBefore.structureToken);
  assert.equal(globalAfter.tabs[0].title, 'Changed');
  assert.equal(windowAfter.tabs[0].title, 'Changed');
  assert.equal(globalBefore.tabs[0].title, 'Before');
  assert.equal(windowBefore.tabs[0].title, 'Before');
  assert.deepEqual(f.counts.queries, [{}, {}]);
});

test('metadata during a pending global query retries without overwriting queued window metadata', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  const paused = pauseNextQuery(f.api);
  const reading = f.cache.tabsState();
  await paused.waiting;
  f.update(1, { title: 'During global read', mutedInfo: { muted: true } });
  paused.release();
  const global = await reading;
  const window = await f.cache.tabsState(1);
  assert.equal(global.tabs[0].title, 'During global read');
  assert.equal(window.tabs[0].title, 'During global read');
  assert.deepEqual(window.tabs[0].mutedInfo, { muted: true });
  assert.equal(window.structureToken, before.structureToken);
  assert.equal(f.counts.copies, 1);
  assert.deepEqual(f.counts.queries, [{ windowId: 1 }, {}, {}]);
});

for (const change of ['metadata', 'remove', 'attach']) {
  test(`${change} racing a warm global read cannot seed stale window rows`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    await f.cache.tabs();
    const reading = f.cache.tabs();
    queueMicrotask(() => {
      if (change === 'metadata') f.update(1, { title: 'Current' });
      else if (change === 'remove') {
        f.native.splice(0, 1);
        f.api.tabs.onRemoved.emit(1, { windowId: 1 });
      } else {
        f.api.tabs.onDetached.emit(1, { oldWindowId: 1 });
        f.native[0].windowId = 2;
        f.api.tabs.onAttached.emit(1, { newWindowId: 2 });
      }
    });
    await reading;
    const current = await f.cache.tabs(1);
    if (change === 'metadata') assert.equal(current[0].title, 'Current');
    else assert.equal(current.length, 0);
    if (change === 'attach') assert.equal((await f.cache.tabs(2))[0].id, 1);
  });
}

test('removed and detached rows cannot be restored by queued or late metadata', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  f.update(1, { title: 'Before move' });
  f.api.tabs.onDetached.emit(1, { oldWindowId: 1 });
  f.native[0].windowId = 2;
  f.api.tabs.onAttached.emit(1, { newWindowId: 2 });
  f.api.tabs.onUpdated.emit(1, { title: 'Late old window' }, { windowId: 1 });
  assert.equal((await f.cache.tabs(1)).length, 0);
  const moved = await f.cache.tabsState(2);
  assert.equal(moved.tabs[0].title, 'Before move');
  assert.notEqual(moved.structureToken, before.structureToken);
  f.update(1, { title: 'Before close' });
  f.native.splice(0, 1);
  f.api.tabs.onRemoved.emit(1, { windowId: 2 });
  f.api.tabs.onUpdated.emit(1, { title: 'Late closed tab' }, { windowId: 2 });
  const closed = await f.cache.tabsState(2);
  assert.equal(closed.tabs.length, 0);
  assert.notEqual(closed.structureToken, moved.structureToken);
  assert.equal(f.counts.copies, 0);
});

test('adapters without lifecycle events query each read and provide fresh tokens', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  delete f.api.tabs.onUpdated;
  const before = await f.cache.tabsState(1);
  f.native[0].title = 'Updated without events';
  const after = await f.cache.tabsState(1);
  assert.notEqual(after.structureToken, before.structureToken);
  assert.equal(after.tabs[0].title, 'Updated without events');
  assert.equal((await f.cache.tabs(1))[0].title, 'Updated without events');
  assert.equal(f.counts.queries.length, 3);
});

test('structural state validity is synchronous across metadata and native invalidation', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  assert.equal(f.cache.isTabsStateCurrent(1, undefined), false);
  const before = await f.cache.tabsState(1);
  assert(f.cache.isTabsStateCurrent(1, before.structureToken));
  f.update(1, { title: 'Metadata' });
  assert(f.cache.isTabsStateCurrent(1, before.structureToken));
  f.update(1, { url: 'https://example.test/navigation' });
  assert.equal(f.cache.isTabsStateCurrent(1, before.structureToken), false);
  const after = await f.cache.tabsState(1);
  assert(f.cache.isTabsStateCurrent(1, after.structureToken));
  assert.equal(f.cache.isTabsStateCurrent(1, before.structureToken), false);
});

test('disposing during a native read preserves its result without retaining cache entries', async () => {
  const f = fixture();
  const paused = pauseNextQuery(f.api);
  const reading = f.cache.tabsState(1);
  await paused.waiting;
  f.cache.dispose();
  paused.release();
  const state = await reading;
  assert.equal(state.tabs[0].title, 'Before');
  assert.equal((await f.cache.tabs(1))[0].title, 'Before');
  assert.deepEqual(f.cache.stats(), { memberships: 0, nativeLists: 0, ancillary: 0 });
});
