import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { TAB_KEY, isSavedForLater } from '../extension/src/model.js';
import { createTreeIndex } from '../extension/src/tree-index.js';
import { listDomains } from '../extension/src/domains.js';
import { domainResults } from '../extension/src/domain-filter.js';
import { laterResults } from '../extension/src/later.js';
import { closeFallback } from '../extension/src/close-selection.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      {
        id: 1,
        index: 0,
        windowId: 1,
        title: 'Parent',
        url: 'https://example.com/blog/parent',
        active: true,
        cookieStoreId: 'firefox-container-1',
      },
      { id: 2, index: 1, windowId: 1, title: 'Child', url: 'https://example.com/blog/child' },
      {
        id: 3,
        index: 2,
        windowId: 1,
        title: 'Grandchild',
        url: 'https://example.com/blog/grandchild',
      },
      { id: 4, index: 0, windowId: 2, title: 'Other window', url: 'https://example.com/' },
    ],
    memberships: {
      1: { treeId: 'parent', groupId: 'work', order: 100, ancestors: [], collapsed: true },
      2: { treeId: 'child', groupId: 'work', order: 200, ancestors: ['parent'] },
      3: { treeId: 'grandchild', groupId: 'work', order: 300, ancestors: ['child', 'parent'] },
    },
    containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', colorCode: '#00f' }],
  });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  return { api, controller, send };
}

test('saving a parent preserves native state and placement, promotes children, and restores the tree', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const native = await api.tabs.get(1);
  const saved = await send('saveForLater', { id: 1 });
  assert(isSavedForLater(saved.tabs.find((tab) => tab.id === 1)));
  assert.deepEqual(await api.tabs.get(1), native);
  assert.equal(saved.tabs.find((tab) => tab.id === 2).parentTabId, null);
  assert.equal(saved.tabs.find((tab) => tab.id === 3).parentTabId, 2);
  assert.equal(createTreeIndex(saved).groupStats.get('work').count, 2);
  assert.deepEqual(
    domainResults(createTreeIndex(saved), 'example.com').map((tab) => tab.id),
    [2, 3],
  );
  assert.equal(listDomains(saved.tabs)[0].count, 2);
  assert.deepEqual(
    (await send('saveForLater', { id: 1 })).tabs,
    saved.tabs,
    'Saving again is idempotent',
  );
  const returned = await send('returnFromLater', { id: 1 });
  assert.deepEqual(returned.tabs, before.tabs);
});

test('saving a middle tab keeps children under the nearest unsaved ancestor', async () => {
  const { send } = fixture();
  const saved = await send('saveForLater', { id: 2 });
  assert.equal(saved.tabs.find((tab) => tab.id === 3).parentTabId, 1);
  await send('saveForLater', { id: 1 });
  const returned = await send('returnFromLater', { id: 2 });
  assert.equal(returned.tabs.find((tab) => tab.id === 2).parentTabId, null);
  assert.equal(returned.tabs.find((tab) => tab.id === 3).parentTabId, 2);
});

test('saves within one clock tick retain most-recent-added order', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const { send } = fixture();
  await send('saveForLater', { id: 1 });
  await send('saveForLater', { id: 3 });
  const next = await send('saveForLater', { id: 2 });
  assert.deepEqual(
    laterResults(next.tabs).map((tab) => tab.id),
    [2, 3, 1],
  );
});

test('saved queue survives controller restarts and closed-tab restoration', async () => {
  const { api, controller, send } = fixture();
  const saved = await send('saveForLater', { id: 1 });
  const time = saved.tabs[0].savedForLaterAt;
  controller.dispose();
  const restarted = createController(api);
  const request = (type, args = {}) => restarted.request({ type, windowId: 1, ...args });
  assert.equal((await request('snapshot')).tabs[0].savedForLaterAt, time);
  await request('closeTab', { id: 1 });
  const restored = await request('undoCloseTab');
  assert.equal(
    restored.tabs.find((tab) => tab.id === restored.restoredTabId).savedForLaterAt,
    time,
  );
  assert.equal(restored.tabs.find((tab) => tab.id === 2).parentTabId, null);
});

test('saved pins leave the sidebar strip and retain native pinning and placement on return', async () => {
  const { send } = fixture();
  const pinned = await send('pinTab', { id: 1 });
  const saved = await send('saveForLater', { id: 1 });
  assert.equal(saved.tabs[0].pinned, true);
  assert.equal(saved.pins.length, 0);
  assert.deepEqual((await send('returnFromLater', { id: 1 })).pins, pinned.pins);
});

test('a failed membership write keeps the previous queue and tree intact', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const write = api.sessions.setTabValue;
  api.sessions.setTabValue = async () => {
    throw new Error('Disk full');
  };
  await assert.rejects(send('saveForLater', { id: 1 }), /Disk full/);
  assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  api.sessions.setTabValue = write;
  await send('saveForLater', { id: 1 });
  api.sessions.setTabValue = async () => {
    throw new Error('Disk full');
  };
  await assert.rejects(send('returnFromLater', { id: 1 }), /Disk full/);
  assert(isSavedForLater((await send('snapshot')).tabs[0]));
});

test('folder close and deletion preserve saved tabs; deleted destinations fall back to Home', async () => {
  const { send } = fixture();
  await send('saveForLater', { id: 1 });
  const contents = await send('getGroupContents', { id: 'work' });
  assert.deepEqual(contents.tabIds, [2, 3]);
  await send('closeGroupTabs', { id: 'work', tabIds: [1, 2, 3] });
  const after = await send('removeGroup', { id: 'work', groupIds: ['work'], tabIds: [] });
  assert.equal(after.tabs.length, 1);
  assert(isSavedForLater(after.tabs[0]));
  const returned = await send('returnFromLater', { id: 1 });
  assert.equal(returned.tabs[0].groupId, null);
});

test('saved tabs are excluded from folder moves and cannot become invisible move targets', async () => {
  const { send } = fixture();
  await send('saveForLater', { id: 1 });
  await assert.rejects(send('moveTab', { id: 1, groupId: null }), /Return this tab/);
  await assert.rejects(send('nestTab', { id: 2, parentTabId: 1 }), /parent tab has moved/);
  const moved = await send('moveGroupContents', { id: 'work', groupId: null });
  assert.equal(moved.tabs[0].groupId, 'work');
  assert.equal(moved.tabs[1].groupId, null);
});

test('duplicates are ordinary tabs while the source stays saved', async () => {
  const { send } = fixture();
  await send('saveForLater', { id: 1 });
  const next = await send('duplicateTab', { id: 1 });
  assert.deepEqual(
    next.tabs.filter(isSavedForLater).map((tab) => tab.id),
    [1],
  );
  assert.equal(next.tabs.length, 4);
});

test('saving is window scoped and does not affect children or newly opened links', async () => {
  const { api, controller, send } = fixture();
  await assert.rejects(send('saveForLater', { id: 4 }), /another window/);
  await send('saveForLater', { id: 1 });
  const child = await api.tabs.create({
    windowId: 1,
    openerTabId: 1,
    url: 'https://example.com/new',
    active: false,
  });
  await controller.created(child);
  const next = await send('snapshot');
  assert(!isSavedForLater(next.tabs.find((tab) => tab.id === child.id)));
  assert.equal(next.tabs.find((tab) => tab.id === child.id).parentTabId, null);
  assert.equal(
    (await controller.request({ type: 'snapshot', windowId: 2 })).tabs.filter(isSavedForLater)
      .length,
    0,
  );
  const stored = await api.sessions.getTabValue(1, TAB_KEY);
  assert.equal(stored.groupId, 'work');
  assert.equal(stored.order, 100);
});

test('queue ordering uses added time, searches titles and URLs, and retains duplicate URLs', () => {
  const tabs = [
    { id: 1, savedForLaterAt: 100, title: 'First', url: 'https://example.com/blog/post' },
    { id: 2, savedForLaterAt: 300, title: 'Copy', url: 'https://example.com/blog/post' },
    { id: 3, savedForLaterAt: 200, title: 'Video', url: 'https://youtu.be/abcdefghijk' },
    { id: 4, title: 'Not saved', url: 'https://example.com/blog/post' },
    { id: 5, savedForLaterAt: -1 },
  ];
  assert.deepEqual(
    laterResults(tabs).map((tab) => tab.id),
    [2, 3, 1],
  );
  assert.deepEqual(
    laterResults(tabs, { query: 'EXAMPLE', sort: 'oldest' }).map((tab) => tab.id),
    [1, 2],
  );
  assert.deepEqual(
    laterResults(tabs, { query: 'copy' }).map((tab) => tab.id),
    [2],
  );
  tabs[2].articlePreview = { title: 'Obsolete preview', byline: 'Old author' };
  assert.deepEqual(laterResults(tabs, { query: 'Old author' }), []);
});

test('closing a saved active tab selects the nearest matching saved neighbour', () => {
  const before = {
    groups: [],
    view: { scopeId: null, collapsed: [] },
    tabs: [
      { id: 1, savedForLaterAt: 300, url: 'https://x.test/blog/one' },
      { id: 2, savedForLaterAt: 200, url: 'https://x.test/blog/two', active: true },
      { id: 3, savedForLaterAt: 100, url: 'https://x.test/blog/three' },
      { id: 4, groupId: null, parentTabId: null },
    ],
  };
  const after = {
    ...before,
    tabs: before.tabs
      .filter((tab) => tab.id !== 2)
      .map((tab) => ({ ...tab, active: tab.id === 4 })),
  };
  assert.equal(closeFallback(before, after, 2, { later: true, query: 'blog/' }), 1);
  assert.equal(closeFallback(before, after, 2, { later: true, query: 'missing' }), null);
});
