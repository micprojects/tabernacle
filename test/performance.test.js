import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createTreeIndex } from '../extension/src/tree-index.js';
import { captureTarget } from '../extension/src/tab-collection.js';
import {
  insertionOrder,
  sortTabs,
  resolveTabTree,
  tabSubtree,
  validGroups,
} from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture(count = 1000) {
  const tabs = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    windowId: i < count / 2 ? 1 : 2,
    index: i,
    title: `Tab ${i}`,
    url: `https://example.com/${i}`,
    active: i === 0,
  }));
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'g', name: 'Group', parentId: null }],
    tabs,
    memberships: Object.fromEntries(
      tabs.map((tab) => [tab.id, { groupId: 'g', treeId: `t${tab.id}`, ancestors: [] }]),
    ),
  });
  let calls = {};
  const queries = [];
  for (const category of ['tabs', 'sessions', 'contextualIdentities']) {
    for (const [method, fn] of Object.entries(api[category])) {
      if (typeof fn !== 'function') continue;
      api[category][method] = (...args) => {
        const key = `${category}.${method}`;
        calls[key] = (calls[key] || 0) + 1;
        if (key === 'tabs.query') queries.push(args[0]);
        return fn(...args);
      };
    }
  }
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  api.testing.setCreatedHandler((tab) => controller.created(tab).catch(() => {}));
  return {
    api,
    controller,
    notices,
    queries,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),

    reset() {
      calls = {};
      queries.length = 0;
      notices.length = 0;
    },

    calls: () => calls,
  };
}

test('warm snapshots and group toggles reuse metadata, native tabs, containers and history', async () => {
  const f = fixture();
  await f.send('snapshot');
  f.reset();
  await f.send('snapshot');
  await f.send('toggleGroup', { id: 'g' });
  for (const name of [
    'tabs.query',
    'sessions.getTabValue',
    'contextualIdentities.query',
    'sessions.getRecentlyClosed',
  ])
    assert.equal(f.calls()[name] || 0, 0, name);
  f.reset();
  const state = await f.send('activateTab', { id: 2 });
  assert.equal(state.tabs.find((tab) => tab.id === 2).active, true);
  assert.equal(f.calls()['sessions.getTabValue'] || 0, 0);
  assert.deepEqual(f.queries, []);
});

test('closing a reviewed inactive batch rebuilds the window only for its final reply', async (t) => {
  const f = fixture();
  t.after(() => f.controller.dispose());
  const before = await f.send('snapshot');
  const targets = before.tabs.slice(1, 21).map(captureTarget);
  f.reset();
  const after = await f.send('closeTabSet', { scope: { kind: 'window' }, targets });
  assert.deepEqual(
    after.batchResult.completed,
    targets.map((tab) => tab.id),
  );
  assert.deepEqual(after.batchResult.failed, []);
  assert.equal(after.tabs.length, before.tabs.length - targets.length);
  assert.equal(after.tabs.find((tab) => tab.active).id, 1);
  assert.equal(f.calls()['tabs.query'], 1);
  assert.equal(f.calls()['sessions.getWindowValue'], 1);
  assert.equal(f.calls()['tabs.remove'], targets.length);
});

test('duplicate batches bound native reads by matching keepers, not unrelated URL pairs', async (t) => {
  const f = fixture(400);
  t.after(() => f.controller.dispose());
  for (let id = 1; id <= 200; id++)
    await f.api.tabs.update(id, { url: `https://example.com/pair/${Math.floor((id - 1) / 2)}` });
  const before = await f.send('snapshot');
  const targets = before.tabs.filter((tab) => tab.id % 2 === 0).map(captureTarget);
  const keepers = before.tabs
    .filter((tab) => tab.id % 2 === 1)
    .map(captureTarget)
    .reverse();
  f.reset();
  const after = await f.send('closeDuplicateTabs', { scope: { kind: 'window' }, targets, keepers });
  assert.deepEqual(
    after.batchResult.completed,
    targets.map((tab) => tab.id),
  );
  assert.deepEqual(after.batchResult.skipped, []);
  assert.deepEqual(after.batchResult.failed, []);
  assert.deepEqual(
    after.tabs.map((tab) => tab.id),
    keepers.map((tab) => tab.id).reverse(),
  );
  assert((f.calls()['tabs.get'] || 0) <= targets.length * 8);
  assert.equal(f.calls()['tabs.remove'], targets.length);
  assert.equal((await f.api.tabs.query({ windowId: 2 })).length, 200);
});

test('native changes invalidate only their window; irrelevant updates do not notify sidebars', async () => {
  const f = fixture();
  await f.send('snapshot');
  f.reset();
  await f.api.tabs.update(900, { title: 'Other window changed' });
  await f.send('snapshot');
  assert.deepEqual(f.queries, []);
  assert(f.notices.every((notice) => notice.windowId === 2));
  const state = await f.send('snapshot', {}, 2);
  assert.equal(state.tabs.find((tab) => tab.id === 900).title, 'Other window changed');
  assert.deepEqual(f.queries, []);
  f.reset();
  await f.api.tabs.update(1, { status: 'loading' });
  assert.deepEqual(f.notices, []);
  await f.api.tabs.update(1, { status: 'complete' });
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].windowId, 1);
  assert.deepEqual(f.queries, []);
});

test('adding a tab to a large group uses a bounded number of membership writes', async () => {
  const f = fixture();
  await f.send('snapshot');
  f.reset();
  const state = await f.send('newTab', { groupId: 'g' });
  assert.equal(sortTabs(state.tabs).at(-1).id, state.createdTabId);
  assert((f.calls()['sessions.setTabValue'] || 0) <= 3);
  assert((f.calls()['sessions.getTabValue'] || 0) <= 2);
});

test('creation bursts share a view read and preserve native event order', async () => {
  const f = fixture();
  await f.send('enterGroup', { id: 'g' });
  f.reset();
  const added = await Promise.all(
    Array.from({ length: 100 }, () => f.api.tabs.create({ windowId: 1, active: false })),
  );
  const state = await f.send('snapshot');
  assert.deepEqual(
    sortTabs(state.tabs)
      .slice(-100)
      .map((tab) => tab.id),
    added.map((tab) => tab.id),
  );
  assert(added.every(({ id }) => state.tabs.find((tab) => tab.id === id)?.groupId === 'g'));
  assert(f.calls()['sessions.getWindowValue'] <= 3);
  assert(f.calls()['tabs.query'] <= 2);
  f.controller.dispose();
});

test('requests between creation bursts keep their position in the write queue', async () => {
  const f = fixture(10);
  await f.send('snapshot');
  const before = await Promise.all(
    Array.from({ length: 5 }, () => f.api.tabs.create({ windowId: 1, active: false })),
  );
  const navigation = f.send('enterGroup', { id: 'g' });
  const after = await Promise.all(
    Array.from({ length: 5 }, () => f.api.tabs.create({ windowId: 1, active: false })),
  );
  await navigation;
  const state = await f.send('snapshot');
  assert(before.every(({ id }) => state.tabs.find((tab) => tab.id === id)?.groupId === null));
  assert(after.every(({ id }) => state.tabs.find((tab) => tab.id === id)?.groupId === 'g'));
  f.controller.dispose();
});

test('failed creation placement does not abandon the remaining batch', async () => {
  const f = fixture(10);
  await f.send('enterGroup', { id: 'g' });
  const outcomes = [];
  f.api.testing.setCreatedHandler((tab) => {
    outcomes.push(
      f.controller.created(tab).then(
        () => null,
        (error) => error.message,
      ),
    );
  });
  const save = f.api.sessions.setTabValue;
  let failed = false;
  f.api.sessions.setTabValue = async (id, key, value) => {
    if (!failed && id > 10 && value.groupId === 'g') {
      failed = true;
      throw new Error('Placement failed');
    }
    return save(id, key, value);
  };
  const added = await Promise.all(
    Array.from({ length: 5 }, () => f.api.tabs.create({ windowId: 1, active: false })),
  );
  assert.deepEqual(await Promise.all(outcomes), ['Placement failed', null, null, null, null]);
  const state = await f.send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.id === added[0].id).groupId, null);
  assert(
    added.slice(1).every(({ id }) => state.tabs.find((tab) => tab.id === id)?.groupId === 'g'),
  );
  f.controller.dispose();
});

test('native creation still reveals collapsed ancestors and orders after pinned children', async () => {
  const f = fixture(10);
  await f.send('nestTab', { id: 2, parentTabId: 1 });
  await f.send('toggleTab', { id: 1 });
  await f.send('toggleTab', { id: 2 });
  const child = await f.api.tabs.create({ windowId: 1, openerTabId: 2, active: false });
  let state = await f.send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.id === child.id).parentTabId, 2);
  assert.equal(state.tabs.find((tab) => tab.id === 1).collapsed, false);
  assert.equal(state.tabs.find((tab) => tab.id === 2).collapsed, false);
  await f.api.tabs.update(child.id, { pinned: true });
  const sibling = await f.api.tabs.create({ windowId: 1, openerTabId: 2, active: false });
  state = await f.send('snapshot');
  assert.deepEqual(
    sortTabs(state.tabs.filter((tab) => tab.parentTabId === 2)).map((tab) => tab.id),
    [child.id, sibling.id],
  );
  f.controller.dispose();
});

test('cached resolved trees do not share mutable ancestry or mute state with callers', async () => {
  const f = fixture(10);
  await f.send('nestTab', { id: 2, parentTabId: 1 });
  await f.send('muteTab', { id: 2 });
  const first = await f.send('snapshot');
  const child = first.tabs.find((tab) => tab.id === 2);
  child.ancestors.length = 0;
  child.mutedInfo.muted = false;
  const second = (await f.send('snapshot')).tabs.find((tab) => tab.id === 2);
  assert.equal(second.parentTabId, 1);
  assert.equal(second.ancestors.length, 1);
  assert.equal(second.mutedInfo.muted, true);
  f.controller.dispose();
});

test('cached memberships survive native duplication, restore and cross-window moves', async () => {
  const f = fixture(10);
  await f.send('nestTab', { id: 2, parentTabId: 1 });
  const before = await f.send('snapshot');
  const original = before.tabs.find((tab) => tab.id === 1);
  const duplicate = await f.api.tabs.duplicate(1);
  let state = await f.send('snapshot');
  assert.notEqual(state.tabs.find((tab) => tab.id === duplicate.id).treeId, original.treeId);
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
  await f.api.testing.attach(1, 2);
  assert.equal((await f.send('snapshot')).tabs.find((tab) => tab.id === 2).parentTabId, null);
  await f.api.testing.attach(2, 2);
  assert.equal((await f.send('snapshot', {}, 2)).tabs.find((tab) => tab.id === 2).parentTabId, 1);
  await f.send('closeTab', { id: 1 }, 2);
  const restored = await f.api.testing.restore();
  state = await f.send('snapshot', {}, 2);
  assert.equal(state.tabs.find((tab) => tab.id === restored.id).treeId, original.treeId);
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, restored.id);
});

test('container and history caches refresh on their lifecycle events', async () => {
  const f = fixture(10);
  await f.send('snapshot');
  f.reset();
  f.api.contextualIdentities.onUpdated.emit({});
  await f.send('snapshot');
  assert.equal(f.calls()['contextualIdentities.query'], 1);
  assert.equal(f.calls()['sessions.getRecentlyClosed'] || 0, 0);
  await f.api.tabs.remove(2);
  assert.equal((await f.send('snapshot')).canUndoClose, true);
  assert.equal(f.calls()['sessions.getRecentlyClosed'], 1);
  await f.api.sessions.restore();
  assert.equal((await f.send('snapshot')).canUndoClose, false);
});

test('events during an asynchronous cache read cannot publish a stale cached result', async () => {
  const api = memoryBrowser({ events: true, tabs: [{ id: 1, windowId: 1, title: 'Before' }] });
  const query = api.tabs.query;
  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  let first = true;
  api.tabs.query = async (args) => {
    const result = await query(args);
    if (first) {
      first = false;
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return result;
  };
  const cache = createBrowserCache(api);
  const read = cache.tabs(1);
  await pending;
  await api.tabs.update(1, { title: 'After' });
  release();
  assert.equal((await read)[0].title, 'After');
  assert.equal((await cache.tabs(1))[0].title, 'After');
  cache.dispose();
});

test('failed membership writes leave the cached and persisted tree unchanged', async () => {
  const f = fixture(10);
  const before = await f.send('snapshot');
  f.api.sessions.setTabValue = async () => {
    throw new Error('Cannot save');
  };
  await assert.rejects(f.send('toggleTab', { id: 1 }), /Cannot save/);
  const after = await f.send('snapshot');
  assert.deepEqual(after.tabs, before.tabs);
});

for (const event of ['update', 'remove', 'attach']) {
  test(`${event} between a global read and window cache seeding cannot retain stale tabs`, async () => {
    const api = memoryBrowser({ events: true, tabs: [{ id: 1, windowId: 1, title: 'Before' }] });
    const cache = createBrowserCache(api);
    try {
      await cache.tabs();
      const reading = cache.tabs();
      let updated;
      // The cached read resolves first; the event arrives before tabs() resumes
      // and tries to populate its per-window caches from that global result.
      queueMicrotask(() => {
        updated =
          event === 'update'
            ? api.tabs.update(1, { title: 'After' })
            : event === 'remove'
              ? api.tabs.remove(1)
              : api.testing.attach(1, 2);
      });
      await reading;
      await updated;
      const current = await cache.tabs(1);
      if (event === 'update') assert.equal(current[0].title, 'After');
      else assert.deepEqual(current, []);
      if (event === 'attach') assert.equal((await cache.tabs(2))[0].id, 1);
    } finally {
      cache.dispose();
    }
  });
}

test('saved folder validation handles deep unordered hierarchies without recursion', () => {
  const groups = Array.from({ length: 25000 }, (_, i) => ({
    id: `g${i}`,
    name: 'Folder',
    parentId: i ? `g${i - 1}` : null,
  })).reverse();
  assert.equal(validGroups(groups), true);
  groups.at(-1).parentId = groups[0].id;
  assert.equal(validGroups(groups), false);
});

test('membership reads and writes keep caller-owned records out of the cache', async () => {
  const api = memoryBrowser({
    events: true,
    tabs: [{ id: 1, windowId: 1 }],
    memberships: { 1: { treeId: 'child', groupId: null, ancestors: ['parent'] } },
  });
  const cache = createBrowserCache(api);
  try {
    const read = await cache.membership(1);
    read.groupId = 'changed';
    read.ancestors.push('changed');
    assert.deepEqual(await cache.membership(1), {
      treeId: 'child',
      groupId: null,
      ancestors: ['parent'],
    });
    const saved = { treeId: 'child', groupId: 'saved', ancestors: ['other'] };
    await cache.saveMembership(1, saved);
    saved.ancestors.length = 0;
    assert.deepEqual((await cache.membership(1)).ancestors, ['other']);
    api.sessions.setTabValue = async () => {
      throw new Error('Cannot save');
    };
    await assert.rejects(cache.saveMembership(1, read), /Cannot save/);
    assert.equal((await cache.membership(1)).groupId, 'saved');
  } finally {
    cache.dispose();
  }
});

test('fractional ordering handles ends, ties and exhausted floating-point gaps', () => {
  assert.equal(insertionOrder([], 0), 0);
  assert(insertionOrder([{ index: 0 }], 0) < 0);
  assert(insertionOrder([{ index: 0 }], 1) > 0);
  assert.equal(insertionOrder([{ order: 2 }, { order: 4 }], 1), 3);
  assert.equal(insertionOrder([{ order: 2 }, { order: 2 }], 1), null);
  assert.equal(insertionOrder([{ order: 1 }, { order: 1 + Number.EPSILON }], 1), null);
});

test('tied sibling orders rebalance without changing the intended order', async () => {
  const f = fixture(10);
  for (const id of [1, 2]) f.api.testing.tabValues.get(id).order = 1;
  const state = await f.send('moveTab', { id: 3, groupId: 'g', beforeId: 2 });
  assert.deepEqual(
    sortTabs(state.tabs).map((tab) => tab.id),
    [1, 3, 2, 4, 5],
  );
  f.controller.dispose();
  const restarted = createController(f.api);
  const restored = await restarted.request({ type: 'snapshot', windowId: 1 });
  assert.deepEqual(
    sortTabs(restored.tabs).map((tab) => tab.id),
    [1, 3, 2, 4, 5],
  );
  restarted.dispose();
});

test('native index changes cannot move untouched neighbours around a fractional order', async () => {
  const f = fixture(10);
  await f.send('moveTab', { id: 3, groupId: 'g', beforeId: 2 });
  await f.api.tabs.move(1, { index: 10 });
  await f.api.tabs.move(2, { index: 0 });
  const state = await f.send('snapshot');
  assert.deepEqual(
    sortTabs(state.tabs).map((tab) => tab.id),
    [1, 3, 2, 4, 5],
  );
});

test('a path entering a corrupt cycle still leaves every tab reachable', () => {
  const tabs = resolveTabTree([
    { id: 1, treeId: 'a', ancestors: ['b'], windowId: 1, groupId: null },
    { id: 2, treeId: 'b', ancestors: ['c'], windowId: 1, groupId: null },
    { id: 3, treeId: 'c', ancestors: ['b'], windowId: 1, groupId: null },
  ]);
  const roots = tabs.filter((tab) => tab.parentTabId === null);
  assert.equal(roots.length, 1);
  assert.equal(tabSubtree(tabs, roots[0].id).length, 3);
});

test('tree summaries handle deep trees, search, pinned descendants and group audio', () => {
  const tabs = Array.from({ length: 5000 }, (_, i) => ({
    id: i,
    index: i,
    parentTabId: i ? i - 1 : null,
    groupId: 'child',
    title: i === 4999 ? 'Needle' : 'Tab',
    active: i === 4999,
    audible: i === 4999,
  }));
  const state = {
    tabs,
    groups: [
      { id: 'root', name: 'Root', parentId: null },
      { id: 'child', name: 'Child', parentId: 'root' },
    ],
  };
  let index = createTreeIndex(state, 'needle');
  assert.equal(index.tabStats.get(0).descendants, 4999);
  assert.equal(index.tabStats.get(0).descendantMatch, true);
  assert.equal(index.tabStats.get(0).active, true);
  assert.equal(index.audio.get(0), 1);
  assert.deepEqual(index.groupStats.get('root'), { count: 5000, audio: 1, match: true });
  tabs[1].pinned = true;
  index = createTreeIndex(state, 'needle');
  assert.equal(index.tabStats.get(0).descendants, 0);
  assert.equal(index.audio.get(0), 1);
  assert.equal(index.roots.get('child').length, 2);
});

test('metadata bursts reuse settled native lists without changing older snapshots or saved memberships', async () => {
  const f = fixture(1000);
  const before = await f.send('snapshot');
  const stored = structuredClone(f.api.testing.tabValues);
  f.reset();
  for (let i = 0; i < 100; i++)
    await f.api.tabs.update(i + 1, {
      title: `Live ${i}`,
      favIconUrl: `https://example.com/${i}.ico`,
      status: 'complete',
      audible: true,
      mutedInfo: { muted: i % 2 === 0, reason: 'user' },
      discarded: false,
    });
  const after = await f.send('snapshot');
  assert.equal(f.calls()['tabs.query'] || 0, 0);
  assert.equal(f.calls()['sessions.getTabValue'] || 0, 0);
  assert.equal(f.calls()['sessions.setTabValue'] || 0, 0);
  assert.deepEqual(f.api.testing.tabValues, stored);
  assert.equal(before.tabs[0].title, 'Tab 0');
  assert.equal(before.tabs[0].mutedInfo, undefined);
  for (let i = 0; i < 100; i++) {
    assert.equal(after.tabs[i].title, `Live ${i}`);
    assert.deepEqual(after.tabs[i].mutedInfo, { muted: i % 2 === 0, reason: 'user' });
    assert.equal(after.tabs[i].treeId, before.tabs[i].treeId);
    assert.deepEqual(after.tabs[i].ancestors, before.tabs[i].ancestors);
  }
  f.controller.dispose();
});

for (const properties of [
  { url: 'https://example.com/navigation' },
  { pinned: true },
  { hidden: true },
  { groupId: 42 },
  { cookieStoreId: 'firefox-container-2' },
  { title: 'Changed', futureProperty: true },
]) {
  test(`native ${Object.keys(properties).join('/')} changes keep the full query path`, async () => {
    const f = fixture(10);
    await f.send('snapshot');
    f.reset();
    await f.api.tabs.update(1, properties);
    await f.send('snapshot');
    assert.deepEqual(f.queries, [{ windowId: 1 }]);
    f.controller.dispose();
  });
}

test('metadata cache updates cannot resurrect removed or detached tabs', async () => {
  const api = memoryBrowser({ events: true, tabs: [{ id: 1, windowId: 1, title: 'Before' }] });
  const cache = createBrowserCache(api);
  try {
    await cache.tabs();
    await api.tabs.update(1, { title: 'Changed' });
    assert.equal((await cache.tabs(1))[0].title, 'Changed');
    assert.equal((await cache.tabs())[0].title, 'Changed');
    await api.testing.attach(1, 2);
    api.tabs.onUpdated.emit(1, { title: 'Late old window event' }, { windowId: 1 });
    assert.deepEqual(await cache.tabs(1), []);
    assert.equal((await cache.tabs(2))[0].title, 'Changed');
    await api.tabs.remove(1);
    api.tabs.onUpdated.emit(1, { title: 'Late closed tab event' }, { windowId: 2 });
    assert.deepEqual(await cache.tabs(2), []);
  } finally {
    cache.dispose();
  }
});

test('metadata events own their nested values and replace a cache entry during a warm read', async () => {
  const api = memoryBrowser({ events: true, tabs: [{ id: 1, windowId: 1, title: 'Before' }] });
  const cache = createBrowserCache(api);
  try {
    const before = await cache.tabs(1);
    const reading = cache.tabs(1);
    const properties = { mutedInfo: { muted: true }, title: 'After' };
    api.tabs.onUpdated.emit(1, properties, { windowId: 1 });
    properties.mutedInfo.muted = false;
    assert.equal((await reading)[0].title, 'After');
    assert.equal((await cache.tabs(1))[0].mutedInfo.muted, true);
    assert.equal(before[0].title, 'Before');
    assert.equal(before[0].mutedInfo, undefined);
  } finally {
    cache.dispose();
  }
});
