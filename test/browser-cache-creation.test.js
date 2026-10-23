import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser, memoryEvent } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, title: 'First', url: 'https://first.test/' },
      { id: 2, windowId: 2, index: 0, active: true, title: 'Other', url: 'https://other.test/' },
    ],
  });
  api.tabs.onHighlighted = memoryEvent();
  let queries = 0;
  const query = api.tabs.query;
  api.tabs.query = (...args) => {
    queries++;
    return query(...args);
  };
  const cache = createBrowserCache(api);
  return { api, cache, query, queries: () => queries };
}

test('inactive appends share one immutable native array per consumed burst', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabsState(1);
  const other = await f.cache.tabsState(2);
  await f.api.tabs.update(1, { title: 'Changed', mutedInfo: { muted: true } });
  for (let i = 1; i <= 25; i++)
    await f.api.tabs.create({ windowId: 1, index: i, active: false, url: `https://new.test/${i}` });
  assert.equal(f.cache.isTabsStateCurrent(1, before.structureToken), false);
  assert.equal(f.cache.isTabsStateCurrent(2, other.structureToken), true);
  const after = await f.cache.tabsState(1);
  assert.deepEqual(after.tabs, await f.query({ windowId: 1 }));
  assert.equal(f.queries(), 2);
  assert.equal(before.tabs.length, 1);
  assert.equal(before.tabs[0].title, 'First');
  assert.equal(before.positions.size, 1);
  assert.equal(after.positions.size, 26);
  for (const [i, tab] of after.tabs.entries()) assert.equal(after.positions.get(tab.id), i);
  assert.equal((await f.cache.tabsState(1)).tabs, after.tabs);
});

test('append during a warm read reaches that read and leaves previous readers unchanged', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await f.cache.tabs(1);
  const reading = f.cache.tabs(1);
  await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  assert.deepEqual(await reading, await f.query({ windowId: 1 }));
  assert.equal(before.length, 1);
  assert.equal(f.queries(), 1);
});

test('appended rows use native fields even when the creation event contains different values', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  await f.cache.tabs(1);
  const emit = f.api.tabs.onCreated.emit;
  f.api.tabs.onCreated.emit = (tab) => emit({ ...tab, width: 729, height: 600 });
  await f.api.tabs.create({ windowId: 1, index: 1, active: false, width: 0, height: 0 });
  assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
  assert.equal(f.queries(), 1);
});

for (const change of ['append', 'navigation'])
  test(`${change} during an added-tab read cannot expose an incomplete or stale snapshot`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    const before = await f.cache.tabs(1);
    const tab = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
    const get = f.api.tabs.get;
    let release, entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let first = true;
    f.api.tabs.get = async (id) => {
      const value = await get(id);
      if (first) {
        first = false;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return value;
    };
    const reading = f.cache.tabs(1);
    await started;
    if (change === 'append') await f.api.tabs.create({ windowId: 1, index: 2, active: false });
    else await f.api.tabs.update(tab.id, { url: 'https://changed.test/' });
    release();
    assert.deepEqual(await reading, await f.query({ windowId: 1 }));
    assert.equal(before.length, 1);
  });

for (const properties of [
  { active: true },
  { highlighted: true },
  { pinned: true },
  { index: 0 },
  { index: 50 },
  { incognito: true },
])
  test(`creation fallback: ${JSON.stringify(properties)}`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    await f.cache.tabs(1);
    await f.api.tabs.create({ windowId: 1, index: 1, active: false, ...properties });
    assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
    assert.equal(f.queries(), 2);
  });

for (const event of ['activation', 'highlight', 'navigation', 'move', 'remove', 'detach'])
  test(`${event} after an unconsumed append preserves authoritative native state`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    await f.cache.tabs(1);
    const tab = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
    if (event === 'activation') await f.api.tabs.update(1, { active: true });
    if (event === 'highlight') f.api.tabs.onHighlighted.emit({ windowId: 1, tabIds: [1] });
    if (event === 'navigation') await f.api.tabs.update(tab.id, { url: 'https://changed.test/' });
    if (event === 'move') await f.api.tabs.move(tab.id, { index: 0 });
    if (event === 'remove') await f.api.tabs.remove(tab.id);
    if (event === 'detach') await f.api.testing.attach(tab.id, 2);
    assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
    assert.equal(f.queries(), 2);
  });

test('creation during an in-flight native query discards that read, including after failure', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  f.api.tabs.query = async (args) => {
    const rows = await f.query(args);
    if (first) {
      first = false;
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return rows;
  };
  const reading = f.cache.tabs(1);
  await started;
  await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  release();
  assert.deepEqual(await reading, await f.query({ windowId: 1 }));
  f.cache.invalidateTabs(1);
  f.api.tabs.query = async () => {
    throw Error('read failed');
  };
  await assert.rejects(f.cache.tabs(1), /read failed/);
  await f.api.tabs.create({ windowId: 1, index: 2, active: false });
  f.api.tabs.query = f.query;
  assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
});

test('global reads include appended windows and window removal releases appended memberships', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  await f.cache.tabs();
  const tab = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  assert.deepEqual(await f.cache.tabs(), await f.query({}));
  const later = await f.api.tabs.create({ windowId: 1, index: 2, active: false });
  await f.cache.membership(later.id);
  assert.equal(f.cache.stats().memberships, 1);
  f.api.windows.onRemoved.emit(1);
  assert.equal(f.cache.stats().memberships, 0);
  assert.equal(tab.windowId, 1);
});

test('controller appends revalidate a native move during awaited organisation writes', async (t) => {
  const f = fixture();
  f.cache.dispose();
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  await controller.request({ type: 'snapshot', windowId: 1 });
  const added = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  const save = f.api.sessions.setTabValue;
  let moved = false;
  f.api.sessions.setTabValue = async (id, key, value) => {
    await save(id, key, value);
    if (id === added.id && !moved) {
      moved = true;
      await f.api.testing.attach(id, 2);
    }
  };
  await assert.rejects(controller.created(added), /closed or moved/);
  const first = await controller.request({ type: 'snapshot', windowId: 1 });
  const second = await controller.request({ type: 'snapshot', windowId: 2 });
  assert(!first.tabs.some((tab) => tab.id === added.id));
  assert(second.tabs.some((tab) => tab.id === added.id));
  assert.equal(new Set([...first.tabs, ...second.tabs].map((tab) => tab.treeId)).size, 3);
});

test('serial appends reuse each required native check without another get or window query', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  let gets = 0;
  const get = f.api.tabs.get;
  f.api.tabs.get = (...args) => {
    gets++;
    return get(...args);
  };
  const initial = await f.cache.tabs(1);
  for (let i = 1; i <= 100; i++) {
    const tab = await f.api.tabs.create({
      windowId: 1,
      index: i,
      active: false,
      mutedInfo: { muted: true },
    });
    const checked = await f.cache.createdTab(tab.id, 1);
    checked.mutedInfo.muted = false;
    assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
  }
  assert.equal(initial.length, 1);
  assert.equal(gets, 100);
  assert.equal(f.queries(), 1);
});

test('large parallel bursts use one window query instead of per-tab reads', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  await f.cache.tabs(1);
  let gets = 0;
  const get = f.api.tabs.get;
  f.api.tabs.get = (...args) => {
    gets++;
    return get(...args);
  };
  for (let i = 1; i <= 100; i++) await f.api.tabs.create({ windowId: 1, index: i, active: false });
  assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
  assert.equal(gets, 0);
  assert.equal(f.queries(), 2);
});

test('concurrent append reads remain isolated between two windows', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  const before = await Promise.all([f.cache.tabsState(1), f.cache.tabsState(2)]);
  const added = [];
  for (const index of [1, 2])
    for (const windowId of [1, 2])
      added.push(await f.api.tabs.create({ windowId, index, active: false }));
  await Promise.all(added.map((tab) => f.cache.createdTab(tab.id, tab.windowId)));
  const after = await Promise.all([f.cache.tabsState(1), f.cache.tabsState(2)]);
  for (const [i, windowId] of [1, 2].entries()) {
    assert.deepEqual(after[i].tabs, await f.query({ windowId }));
    assert.equal(before[i].tabs.length, 1);
    assert.equal(before[i].positions.size, 1);
    assert.equal(after[i].positions.size, 3);
  }
  assert.equal(f.queries(), 2);
});

test('failed added-tab reads fall back to authoritative query without dropping records', async (t) => {
  const f = fixture();
  t.after(() => f.cache.dispose());
  await f.cache.tabs(1);
  for (let i = 1; i <= 3; i++) await f.api.tabs.create({ windowId: 1, index: i, active: false });
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) => {
    if (id === 4) throw Error('temporary read failure');
    return get(id);
  };
  assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
  assert.equal(f.queries(), 2);
});

for (const when of ['during', 'after'])
  test(`new-tab metadata ${when} its native check invalidates reuse`, async (t) => {
    const f = fixture();
    t.after(() => f.cache.dispose());
    await f.cache.tabs(1);
    const tab = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
    const get = f.api.tabs.get;
    let release, started;
    const entering = new Promise((resolve) => {
      started = resolve;
    });
    f.api.tabs.get = async (id) => {
      const value = await get(id);
      started();
      if (when === 'during')
        await new Promise((resolve) => {
          release = resolve;
        });
      return value;
    };
    const checked = f.cache.createdTab(tab.id, 1);
    await entering;
    if (when === 'after') await checked;
    await f.api.tabs.update(tab.id, { title: 'New title' });
    if (when === 'during') release();
    await checked;
    assert.deepEqual(await f.cache.tabs(1), await f.query({ windowId: 1 }));
    assert.equal(f.queries(), 2);
  });

test('disposal during added-tab reads cannot repopulate caches', async () => {
  const f = fixture();
  await f.cache.tabs(1);
  await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  const get = f.api.tabs.get;
  let release, started;
  const entering = new Promise((resolve) => {
    started = resolve;
  });
  f.api.tabs.get = async (id) => {
    const value = await get(id);
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return value;
  };
  const reading = f.cache.tabs(1);
  await entering;
  f.cache.dispose();
  release();
  assert.deepEqual(await reading, await f.query({ windowId: 1 }));
  assert.deepEqual(f.cache.stats(), { memberships: 0, nativeLists: 0, ancillary: 0 });
});

test('disposal after an append read is invalidated cannot expose its discarded result', async () => {
  const f = fixture();
  await f.cache.tabs(1);
  const tab = await f.api.tabs.create({ windowId: 1, index: 1, active: false });
  const reading = f.cache.tabs(1);
  await f.api.tabs.update(tab.id, { url: 'https://changed.test/' });
  f.cache.dispose();
  assert.deepEqual(await reading, await f.query({ windowId: 1 }));
  assert.deepEqual(f.cache.stats(), { memberships: 0, nativeLists: 0, ancillary: 0 });
});
