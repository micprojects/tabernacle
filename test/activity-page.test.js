import test from 'node:test';
import assert from 'node:assert/strict';
import { activityItems, filterActivity, activityDay } from '../extension/src/activity-data.js';
import { normalizeView, VIEW_KEY } from '../extension/src/model.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { recentItems } from '../extension/src/recent-history.js';

const groups = [
  { id: 'work', name: 'Work', parentId: null },
  { id: 'design', name: 'Design', parentId: 'work' },
];

test('expansions are window-local, persisted, deduplicated, and leave the old panel unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const api = memoryBrowser({
    groups,
    tabs: [
      { id: 1, windowId: 1 },
      { id: 2, windowId: 2 },
    ],
  });
  const controller = createController(api);
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  await send('toggleGroup', { id: 'work' }); // Collapsing is not activity.
  assert.equal(activityItems(await send('snapshot')).length, 0);
  await send('toggleGroup', { id: 'work' });
  let snapshot = await send('snapshot');
  assert.equal(activityItems(snapshot)[0].event, 'Expanded');
  assert.equal(recentItems(snapshot, 'folder').length, 0);
  assert.equal(activityItems(await send('snapshot', {}, 2)).length, 0);
  t.mock.timers.tick(1000);
  await send('enterGroup', { id: 'work' });
  snapshot = await send('snapshot');
  const combined = activityItems(snapshot);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].event, 'Entered');
  assert.equal(combined[0].expandedAt, 10000);
  assert.equal(activityItems(snapshot, { folderEvent: 'expanded' })[0].timestamp, 10000);
  assert.deepEqual(api.testing.windowValues.get(1).recentExpandedFolders, [
    { id: 'work', expandedAt: 10000 },
  ]);
  controller.dispose();
  const restarted = createController(api);
  assert.equal(
    activityItems(await restarted.request({ type: 'snapshot', windowId: 1 }))[0].expandedAt,
    10000,
  );
  restarted.dispose();
});

test('explicit expand-all records only collapsed folders; failed writes do not record activity', async () => {
  const api = memoryBrowser({ groups, tabs: [{ id: 1, windowId: 1 }] });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  await send('toggleGroup', { id: 'design' });
  let snapshot = await send('collapseTree', { scopeId: 'work', collapsed: false });
  assert.deepEqual(
    snapshot.view.recentExpandedFolders.map(({ id }) => id),
    ['design'],
  );
  await send('collapseAll', { collapsed: true });
  snapshot = await send('collapseAll', { collapsed: false });
  assert.equal(snapshot.view.recentExpandedFolders.length, 2);
  await api.sessions.setWindowValue(1, VIEW_KEY, { collapsed: ['work'] });
  api.sessions.setWindowValue = async () => {
    throw new Error('Cannot save');
  };
  await assert.rejects(send('toggleGroup', { id: 'work' }), /Cannot save/);
  assert.equal((await send('snapshot')).view.recentExpandedFolders, undefined);
  controller.dispose();
});

test('expansion records discard invalid, deleted and duplicate IDs and stay bounded', () => {
  const many = Array.from({ length: 110 }, (_, i) => ({ id: `g${i}`, parentId: null }));
  const normalized = normalizeView(
    { groups: many },
    {
      recentExpandedFolders: [
        null,
        {},
        { id: 'missing', expandedAt: 1000 },
        { id: 'g1', expandedAt: -1 },
        { id: 'g2', expandedAt: '2' },
        { id: 'g0', expandedAt: 500 },
        ...many.map(({ id }, i) => ({ id, expandedAt: i + 1 })),
      ],
    },
  );
  assert.equal(normalized.recentExpandedFolders.length, 100);
  assert.deepEqual(normalized.recentExpandedFolders[0], { id: 'g0', expandedAt: 500 });
  assert.equal(new Set(normalized.recentExpandedFolders.map(({ id }) => id)).size, 100);
});

test('page excludes itself and private tabs, searches folder paths, and uses local calendar boundaries', () => {
  const now = new Date(2026, 9, 10, 0, 10).getTime();
  const pageUrl = 'moz-extension://test/activity.html';
  const items = activityItems(
    {
      groups,
      view: {},
      tabs: [
        {
          id: 1,
          title: 'CSS notes',
          groupId: 'design',
          url: 'https://example.org',
          lastAccessed: now - 1200000,
        },
        { id: 2, title: 'Private', incognito: true, lastAccessed: now },
        {
          id: 3,
          title: 'Recent activity',
          url: `${pageUrl}?layout=detail#closed`,
          lastAccessed: now,
        },
      ],
      recentlyClosed: [
        { sessionId: 'page', url: pageUrl, closedAt: now },
        { sessionId: 'closed', title: 'Closed', closedAt: now },
      ],
    },
    { pageUrl },
  );
  assert.equal(items.length, 2);
  assert.equal(filterActivity(items, { query: 'css work design' }).length, 1);
  assert.equal(filterActivity(items, { period: 'today', now })[0].kind, 'closed');
  assert.equal(filterActivity(items, { period: 'yesterday', now })[0].kind, 'viewed');
  assert.equal(activityDay(now - 1200000, now), 'Yesterday');
});
