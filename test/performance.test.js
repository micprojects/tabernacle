import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createTreeIndex } from '../extension/src/tree-index.js';
import { insertionOrder, sortTabs, resolveTabTree, tabSubtree } from '../extension/src/model.js';
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
  assert.deepEqual(f.queries, [{ windowId: 1 }]);
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
  assert.deepEqual(f.queries, [{ windowId: 2 }]);
  f.reset();
  await f.api.tabs.update(1, { status: 'loading' });
  assert.deepEqual(f.notices, []);
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
