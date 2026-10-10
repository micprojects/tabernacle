import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { normalizeView } from '../extension/src/model.js';
import { recentItems, recentDay, recentTime } from '../extension/src/recent-history.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'research', name: 'Research', parentId: 'work' },
      { id: 'personal', name: 'Personal', parentId: null },
    ],
    tabs: [
      {
        id: 1,
        windowId: 1,
        index: 0,
        title: 'First',
        url: 'https://example.com/first',
        lastAccessed: 1000,
      },
      { id: 2, windowId: 1, index: 1, title: 'Second', active: true, lastAccessed: 2000 },
      { id: 3, windowId: 1, index: 2, title: 'Not viewed' },
      { id: 4, windowId: 2, title: 'Other window', lastAccessed: 3000 },
      { id: 5, windowId: 1, title: 'Private', incognito: true, lastAccessed: 4000 },
    ],
    memberships: { 1: { groupId: 'research' }, 2: { groupId: 'personal' } },
  });
  const controller = createController(api);
  return {
    api,
    controller,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),
  };
}

test('native tab views update once per tab, exclude other windows and become closed entries', async () => {
  const { send, api } = fixture();
  assert.deepEqual(
    recentItems(await send('snapshot')).map((item) => item.key),
    ['viewed:2', 'viewed:1'],
  );
  await api.tabs.update(1, { active: true });
  let items = recentItems(await send('snapshot'));
  assert.deepEqual(
    items.map((item) => item.key),
    ['viewed:1', 'viewed:2'],
  );
  await api.tabs.update(1, { active: true });
  assert.equal(recentItems(await send('snapshot'), 'viewed').length, 2);
  await send('closeTab', { id: 1 });
  items = recentItems(await send('snapshot'));
  assert.equal(
    items.some((item) => item.key === 'viewed:1'),
    false,
  );
  assert.equal(items.filter((item) => item.kind === 'closed' && item.title === 'First').length, 1);
});

test('folder visits record entry, persist per window, deduplicate, and use current names and paths', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const { send, api, controller } = fixture();
  await send('toggleGroup', { id: 'work' });
  assert.equal(recentItems(await send('snapshot'), 'folder').length, 0);
  await send('enterGroup', { id: 'work' });
  t.mock.timers.tick(1000);
  await send('enterGroup', { id: 'research' });
  t.mock.timers.tick(1000);
  await send('enterGroup', { id: 'research' });
  assert.equal(recentItems(await send('snapshot'), 'folder')[0].timestamp, 11_000);
  await send('enterGroup', { id: null });
  await send('enterGroup', { id: 'work' });
  await send('enterGroup', { id: null });
  let items = recentItems(await send('snapshot'), 'folder');
  assert.deepEqual(
    items.map((item) => [item.id, item.timestamp]),
    [
      ['work', 12_000],
      ['research', 11_000],
    ],
  );
  assert.equal(recentItems(await send('snapshot', {}, 2), 'folder').length, 0);
  await send('renameGroup', { id: 'work', name: 'Projects' });
  await send('moveGroup', { id: 'research', parentId: 'personal' });
  controller.dispose();
  const restarted = createController(api);
  const state = await restarted.request({ type: 'snapshot', windowId: 1 });
  items = recentItems(state, 'folder');
  assert.equal(items[0].title, 'Projects');
  assert.equal(items[1].detail, 'Personal');
  assert.deepEqual(state.view.recentFolders, api.testing.windowValues.get(1).recentFolders);
  restarted.dispose();
});

test('folder history is bounded and discards deleted, duplicate and malformed entries', () => {
  const groups = Array.from({ length: 110 }, (_, i) => ({
    id: `g${i}`,
    name: `Folder ${i}`,
    parentId: null,
  }));
  const view = normalizeView(
    { groups },
    {
      recentFolders: [
        null,
        {},
        { id: 'missing', enteredAt: 9000 },
        { id: 'g0', enteredAt: '500' },
        { id: 'g1', enteredAt: -1 },
        { id: 'g0', enteredAt: 7000 },
        ...groups.map(({ id }, i) => ({ id, enteredAt: i + 1 })),
      ],
    },
  );
  assert.equal(view.recentFolders.length, 100);
  assert.deepEqual(view.recentFolders[0], { id: 'g0', enteredAt: 7000 });
  assert.equal(new Set(view.recentFolders.map(({ id }) => id)).size, 100);
});

test('deleted folders disappear, and rejected entries do not add history', async () => {
  const { send, api } = fixture();
  await send('enterGroup', { id: 'work' });
  await send('removeGroup', { id: 'work', ...(await send('getGroupContents', { id: 'work' })) });
  assert.equal(recentItems(await send('snapshot'), 'folder').length, 0);
  await assert.rejects(send('enterGroup', { id: 'work' }), /no longer exists/);
  api.sessions.setWindowValue = async () => {
    throw new Error('Cannot save view');
  };
  await assert.rejects(send('enterGroup', { id: 'personal' }), /Cannot save view/);
  assert.equal(recentItems(await send('snapshot'), 'folder').length, 0);
});

test('recent tab activation reveals its folder without recording a manual folder entry', async () => {
  const { send } = fixture();
  await send('enterGroup', { id: 'personal' });
  await send('collapseAll', { collapsed: true });
  const state = await send('activateTab', { id: 1, reveal: true });
  assert.equal(state.tabs.find((tab) => tab.id === 1).active, true);
  assert.equal(state.view.scopeId, 'research');
  assert.equal(state.view.collapsed.includes('research'), false);
  assert.equal(state.view.collapsed.includes('work'), false);
  assert.deepEqual(
    recentItems(state, 'folder').map((item) => item.id),
    ['personal'],
  );
  await assert.rejects(send('activateTab', { id: 4, reveal: true }), /another window/);
});

test('timeline merges event times and searches titles, paths and URLs within each filter', () => {
  const state = {
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'research', name: 'Research', parentId: 'work' },
    ],
    tabs: [{ id: 1, title: 'Design notes', url: 'https://example.com/design', lastAccessed: 3000 }],
    view: { recentFolders: [{ id: 'research', enteredAt: 2000 }] },
    recentlyClosed: [
      { sessionId: 'closed', title: 'Older notes', url: 'https://example.org', closedAt: 1000 },
    ],
  };
  assert.deepEqual(
    recentItems(state).map((item) => item.kind),
    ['viewed', 'folder', 'closed'],
  );
  assert.equal(recentItems(state, 'folder', ' RESEARCH work ')[0].id, 'research');
  assert.equal(recentItems(state, 'all', 'example.org')[0].kind, 'closed');
  assert.equal(recentItems(state, 'closed', 'design').length, 0);
  assert.equal(recentItems(state, 'viewed', 'notes example.com')[0].id, 1);
});

test('day groups use local calendar dates and relative times handle unknown and future times', () => {
  const now = new Date(2026, 9, 10, 0, 10).getTime();
  assert.equal(recentDay(now - 5 * 60_000, now), 'Today');
  assert.equal(recentDay(now - 20 * 60_000, now), 'Yesterday');
  assert.notEqual(recentDay(new Date(2026, 9, 8).getTime(), now), 'Yesterday');
  assert.equal(recentDay(0, now), 'Earlier');
  assert.equal(recentTime(now + 1000, now), 'Just now');
  assert.equal(recentTime(now - 120_000, now), '2m');
  assert.equal(recentTime(now - 3_600_000, now), '1h');
  assert.equal(recentTime(now - 86_400_000, now), '1d');
});
