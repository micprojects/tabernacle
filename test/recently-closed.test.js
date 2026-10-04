import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'First', url: 'https://example.com/first' },
      { id: 2, windowId: 1, index: 1, title: 'Second', url: 'https://example.com/second' },
      { id: 3, windowId: 1, index: 2, title: 'Keep open', active: true },
      { id: 4, windowId: 2, index: 0, title: 'Other window' },
    ],
    memberships: { 1: { groupId: 'work' } },
  });
  const controller = createController(api);
  return { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) };
}

test('recently closed tabs are ordered by closure time and exclude windows and private tabs', async () => {
  const { api, send } = fixture();
  api.sessions.getRecentlyClosed = async () => [
    { lastModified: 1000, tab: { sessionId: 'older', windowId: 1, title: 'Older' } },
    { lastModified: 5000, window: { sessionId: 'window', tabs: [] } },
    { lastModified: 4000, tab: { sessionId: 'private', windowId: 1, incognito: true } },
    { lastModified: 3000, tab: { sessionId: 'other', windowId: 2 } },
    { lastModified: 2500, tab: { windowId: 1 } },
    {
      lastModified: 2000,
      tab: { sessionId: 'newer', windowId: 1, url: 'https://example.com', favIconUrl: 'icon.png' },
    },
  ];
  const state = await send('snapshot');
  assert.deepEqual(state.recentlyClosed, [
    {
      sessionId: 'newer',
      title: 'https://example.com',
      url: 'https://example.com',
      favIconUrl: 'icon.png',
      closedAt: 2000,
    },
    { sessionId: 'older', title: 'Older', url: '', favIconUrl: undefined, closedAt: 1000 },
  ]);
  assert.equal(state.canUndoClose, true);
});

test('restoring a selected older tab keeps the newest entry and restores its saved group', async () => {
  const { api, send } = fixture();
  const original = (await send('snapshot')).tabs.find((tab) => tab.id === 1);
  await api.tabs.remove(1);
  await api.tabs.remove(2);
  const before = await send('snapshot');
  assert.deepEqual(
    before.recentlyClosed.map((tab) => tab.title),
    ['Second', 'First'],
  );
  const sessionId = before.recentlyClosed[1].sessionId;
  await send('collapseAll', { collapsed: true });
  const state = await send('restoreClosedTab', { sessionId });
  const restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.equal(restored.title, 'First');
  assert.equal(restored.active, true);
  assert.equal(restored.groupId, 'work');
  assert.equal(restored.treeId, original.treeId);
  assert.equal(state.view.scopeId, null);
  assert.equal(state.view.collapsed.includes('work'), false);
  assert.deepEqual(
    state.recentlyClosed.map((tab) => tab.title),
    ['Second'],
  );
  await assert.rejects(send('restoreClosedTab', { sessionId }), /no longer available/);
  assert.equal((await send('undoCloseTab')).canUndoClose, false);
});

test('restore rejects stale or foreign session IDs and never falls back to restoring a window', async () => {
  const { api, send } = fixture();
  await api.tabs.remove(1);
  await api.tabs.remove(4);
  const state = await send('snapshot');
  const stale = state.recentlyClosed[0].sessionId;
  const history = await api.sessions.getRecentlyClosed();
  const other = history.find(({ tab }) => tab.windowId === 2).tab.sessionId;
  // Simulate history changing before its lifecycle notification arrives.
  api.sessions.getRecentlyClosed = async () => [
    { window: { sessionId: 'closed-window' }, lastModified: Date.now() },
    ...history.filter(({ tab }) => tab.sessionId !== stale),
  ];
  let calls = 0;
  api.sessions.restore = async () => calls++;
  for (const sessionId of [undefined, null, '', stale, other, 'closed-window'])
    await assert.rejects(send('restoreClosedTab', { sessionId }), /no longer available/);
  assert.equal(calls, 0);
});

test('history errors leave open tabs usable and restore failures preserve the selected entry', async () => {
  const { api, send } = fixture();
  await api.tabs.remove(1);
  const sessionId = (await send('snapshot')).recentlyClosed[0].sessionId;
  api.sessions.restore = async () => {
    throw new Error('Firefox refused restore');
  };
  await assert.rejects(send('restoreClosedTab', { sessionId }), /Firefox refused restore/);
  assert.equal((await send('snapshot')).recentlyClosed[0].sessionId, sessionId);
  api.sessions.getRecentlyClosed = async () => {
    throw new Error('Session access denied');
  };
  api.sessions.onChanged.emit();
  const state = await send('snapshot');
  assert.equal(state.tabs.length, 2);
  assert.equal(state.canUndoClose, false);
  assert.deepEqual(state.recentlyClosed, []);
  assert.equal(state.recentlyClosedError, 'Session access denied');
});
