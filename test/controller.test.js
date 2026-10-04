import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import {
  MODEL_KEY,
  TAB_KEY,
  VIEW_KEY,
  isWithin,
  groupPath,
  sortTabs,
} from '../extension/src/model.js';

function fixture() {
  const groups = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'design', name: 'Design', parentId: 'work' },
    { id: 'personal', name: 'Personal', parentId: null },
  ];
  const tabs = [
    { id: 1, index: 0, windowId: 1, title: 'A', active: true, groupId: -1 },
    { id: 2, index: 1, windowId: 1, title: 'B', groupId: -1 },
    { id: 3, index: 2, windowId: 1, title: 'C', groupId: -1 },
    { id: 4, index: 0, windowId: 2, title: 'Other window', groupId: -1 },
  ];
  const api = memoryBrowser({
    groups,
    tabs,
    memberships: {
      1: { groupId: 'design' },
      2: { groupId: 'work' },
      3: { groupId: null },
      4: { groupId: 'design' },
    },
  });
  const controller = createController(api);
  api.testing.setCreatedHandler((tab) => {
    controller.created(tab).catch(() => {});
  });
  return {
    api,
    controller,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),
  };
}

test('nested scope includes descendants and excludes unrelated tabs', async () => {
  const { send } = fixture();
  const state = await send('enterGroup', { id: 'work' });
  assert.equal(state.view.scopeId, 'work');
  assert.deepEqual(
    state.tabs.filter((tab) => isWithin(state, tab.groupId, 'work')).map((tab) => tab.id),
    [1, 2],
  );
  assert.deepEqual(
    groupPath(state, 'design').map((group) => group.name),
    ['Work', 'Design'],
  );
});
test('rejects moving a group into itself or a descendant without corrupting the tree', async () => {
  const { send } = fixture();
  await assert.rejects(send('moveGroup', { id: 'work', parentId: 'design' }), /cannot go inside/);
  await assert.rejects(send('moveGroup', { id: 'work', parentId: 'work' }), /cannot go inside/);
  assert.equal((await send('snapshot')).groups.find((group) => group.id === 'work').parentId, null);
});
test('deleting a group closes its tabs across windows and returns views to its parent', async () => {
  const { send } = fixture();
  await send('enterGroup', { id: 'design' });
  await send('enterGroup', { id: 'design' }, 2);
  await send('removeGroup', {
    id: 'design',
    ...(await send('getGroupContents', { id: 'design' })),
  });
  assert.deepEqual(
    (await send('snapshot')).tabs.map((tab) => tab.id),
    [2, 3],
  );
  const other = await send('snapshot', {}, 2);
  assert.equal(other.tabs.length, 0);
  assert.equal(other.view.scopeId, 'work');
  await send('removeGroup', { id: 'work', ...(await send('getGroupContents', { id: 'work' })) });
  const state = await send('snapshot');
  assert.equal(state.tabs.length, 1);
  assert(state.tabs.every((tab) => tab.groupId === null));
});
test('deleting a parent removes child groups and closes their tabs', async () => {
  const { send } = fixture();
  await send('removeGroup', { id: 'work', ...(await send('getGroupContents', { id: 'work' })) });
  const state = await send('snapshot');
  assert.deepEqual(
    state.groups.map((group) => group.id),
    ['personal'],
  );
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [3],
  );
});
test('session memberships and view survive a background restart', async () => {
  const { send, api } = fixture();
  await send('enterGroup', { id: 'design' });
  await send('toggleGroup', { id: 'personal' });
  const restarted = createController(api);
  const state = await restarted.request({ type: 'snapshot', windowId: 1 });
  assert.equal(state.view.scopeId, 'design');
  assert(state.view.collapsed.includes('personal'));
  assert.equal(state.tabs[0].groupId, 'design');
});
test('closed/restored tabs keep membership despite changed Firefox tab IDs', async () => {
  const { send, api } = fixture();
  await send('closeTab', { id: 1 });
  const restored = await api.testing.restore();
  const state = await send('snapshot');
  assert.notEqual(restored.id, 1);
  assert.equal(state.tabs.find((tab) => tab.id === restored.id).groupId, 'design');
});
test('closing a group includes subgroups and pins, keeps groups and other windows, and supports undo', async () => {
  const { send, api } = fixture();
  await send('pinTab', { id: 2 });
  await send('collapseAll', { collapsed: true });
  const before = await send('snapshot');
  const state = await send('closeGroupTabs', { id: 'work', tabIds: [1, 2, 3, 4] });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [3],
  );
  assert.deepEqual(state.groups, before.groups);
  assert.deepEqual(state.view, before.view);
  assert.equal((await api.tabs.get(4)).title, 'Other window');
  assert.equal(state.canUndoClose, true);
  const restored = await send('undoCloseTab');
  const pin = restored.tabs.find((tab) => tab.id === restored.restoredTabId);
  assert.equal(pin.groupId, 'work');
  assert.equal(pin.pinned, true);
  const child = await send('undoCloseTab');
  assert.equal(child.tabs.find((tab) => tab.id === child.restoredTabId).groupId, 'design');
});
test('group close excludes new tabs and confirmed tabs moved outside its group or window', async () => {
  const { send, api } = fixture();
  await send('snapshot');
  await send('moveTab', { id: 1, groupId: 'personal' });
  await api.testing.attach(2, 2);
  const created = await send('newTab', { groupId: 'design' });
  const before = await api.tabs.query({});
  const state = await send('closeGroupTabs', { id: 'work', tabIds: [1, 2] });
  assert.deepEqual(await api.tabs.query({}), before);
  assert(state.tabs.some((tab) => tab.id === created.createdTabId));
});
test('group close rejects invalid targets and confirmation data without closing tabs', async () => {
  const { send, api } = fixture();
  for (const id of [null, undefined, 'missing'])
    await assert.rejects(send('closeGroupTabs', { id, tabIds: [1, 2, 3] }), /group/);
  for (const tabIds of [undefined, null, 'all', [1, '2']])
    await assert.rejects(send('closeGroupTabs', { id: 'work', tabIds }), /tabs to close/);
  await send('closeGroupTabs', { id: 'personal', tabIds: [1, 2] });
  await send('closeGroupTabs', { id: 'work', tabIds: [] });
  assert.equal((await api.tabs.query({})).length, 4);
});
test('failed group closes surface Firefox errors and can retry after a partial close', async () => {
  const { send, api } = fixture();
  const remove = api.tabs.remove;
  api.tabs.remove = async (ids) => {
    await remove(ids[0]);
    throw new Error('Firefox could not close the remaining tabs.');
  };
  await assert.rejects(
    send('closeGroupTabs', { id: 'work', tabIds: [1, 2] }),
    /Firefox could not close/,
  );
  assert.deepEqual(
    (await send('snapshot')).tabs.map((tab) => tab.id),
    [2, 3],
  );
  api.tabs.remove = remove;
  const state = await send('closeGroupTabs', { id: 'work', tabIds: [1, 2] });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [3],
  );
  assert.equal(state.groups.length, 3);
});
test('restored tabs from a deleted group fall back to Home', async () => {
  const { send } = fixture();
  await send('closeTab', { id: 1 });
  await send('removeGroup', {
    id: 'design',
    ...(await send('getGroupContents', { id: 'design' })),
  });
  const restored = await send('undoCloseTab');
  assert.equal(restored.tabs.find((tab) => tab.id === restored.restoredTabId).groupId, null);
});
test('undo close restores the latest tab in this window and reveals its saved group', async () => {
  const { send, api } = fixture();
  assert.equal((await send('snapshot')).canUndoClose, false);
  await send('closeTab', { id: 1 });
  await send('closeTab', { id: 2 });
  await send('closeTab', { id: 4 }, 2);
  // A newer closed window must not be restored by a tab-only action.
  const recent = api.sessions.getRecentlyClosed;
  api.sessions.getRecentlyClosed = async () => [
    { window: { sessionId: 'closed-window' } },
    ...(await recent()),
  ];
  await send('enterGroup', { id: 'personal' });
  await send('collapseAll', { collapsed: true });
  let state = await send('undoCloseTab');
  let restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.equal(restored.title, 'B');
  assert.equal(restored.groupId, 'work');
  assert.equal(restored.active, true);
  assert.equal(state.view.scopeId, 'work');
  assert(!state.view.collapsed.includes('work'));
  assert.equal(state.canUndoClose, true);
  state = await send('undoCloseTab');
  restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.equal(restored.title, 'A');
  assert.equal(restored.groupId, 'design');
  assert(!state.view.collapsed.includes('design'));
  assert.equal(state.canUndoClose, false);
  await assert.rejects(send('undoCloseTab'), /No recently closed tabs in this window/);
  assert.equal((await send('snapshot', {}, 2)).canUndoClose, true);
});
test('undo restores tree identity, containers and deleted-group fallback across a restart', async () => {
  const { send, api } = fixture();
  await send('nestTab', { id: 2, parentTabId: 1 });
  await send('toggleTab', { id: 1 });
  await api.tabs.update(2, { cookieStoreId: 'firefox-container-1' });
  const before = (await send('snapshot')).tabs.find((tab) => tab.id === 2);
  await send('closeTab', { id: 2 });
  const restarted = createController(api);
  let state = await restarted.request({ type: 'undoCloseTab', windowId: 1 });
  const restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.equal(restored.parentTabId, 1);
  assert.equal(restored.treeId, before.treeId);
  assert.equal(restored.cookieStoreId, before.cookieStoreId);
  assert.equal(state.tabs.find((tab) => tab.id === 1).collapsed, false);
  await send('closeTab', { id: restored.id });
  await send('removeGroup', {
    id: 'design',
    ...(await send('getGroupContents', { id: 'design' })),
  });
  await send('enterGroup', { id: 'personal' });
  state = await send('undoCloseTab');
  assert.equal(state.tabs.find((tab) => tab.id === state.restoredTabId).groupId, null);
  assert.equal(state.view.scopeId, null);
});
test('unavailable session history keeps the sidebar usable; restore failures preserve history', async () => {
  const { send, api } = fixture();
  const recent = api.sessions.getRecentlyClosed;
  api.sessions.getRecentlyClosed = async () => {
    throw new Error('Session access denied');
  };
  assert.equal((await send('snapshot')).canUndoClose, false);
  await assert.rejects(send('undoCloseTab'), /Session access denied/);
  api.sessions.getRecentlyClosed = recent;
  await send('closeTab', { id: 1 });
  api.sessions.restore = async () => {
    throw new Error('Restore failed');
  };
  await assert.rejects(send('undoCloseTab'), /Restore failed/);
  assert.equal((await send('snapshot')).canUndoClose, true);
});
test('new browser tabs inherit scope; tabs opened from links inherit opener group', async () => {
  const { send, api } = fixture();
  await send('enterGroup', { id: 'personal' });
  const blank = await api.tabs.create({ windowId: 1 });
  const link = await api.tabs.create({ windowId: 1, openerTabId: 1 });
  const state = await send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.id === blank.id).groupId, 'personal');
  assert.equal(state.tabs.find((tab) => tab.id === link.id).groupId, 'design');
});
test('explicit new-tab target wins over the current scope and event race', async () => {
  const { send } = fixture();
  await send('enterGroup', { id: 'personal' });
  await send('newTab', { groupId: 'design' });
  const state = await send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.title === 'New tab').groupId, 'design');
});
test('entering a group activates a member, while an empty group creates no tabs', async () => {
  const { send } = fixture();
  await send('enterGroup', { id: 'personal' });
  let state = await send('snapshot');
  assert.equal(state.tabs.length, 3);
  await send('activateTab', { id: 3 });
  state = await send('enterGroup', { id: 'design' });
  assert.equal(state.tabs.find((tab) => tab.active).id, 1);
});
test('moving a tab changes only membership/order and enforces the current window', async () => {
  const { send } = fixture();
  await send('moveTab', { id: 3, groupId: 'design', beforeId: 1 });
  const state = await send('snapshot');
  assert.deepEqual(
    sortTabs(state.tabs.filter((tab) => tab.groupId === 'design')).map((tab) => tab.id),
    [3, 1],
  );
  await assert.rejects(send('moveTab', { id: 4, groupId: 'personal' }), /another window/);
  assert.equal(state.tabs.length, 3);
});
test('moving a real tab to another window retains its group', async () => {
  const { api, send } = fixture();
  await api.testing.attach(1, 2);
  const state = await send('snapshot', {}, 2);
  assert.equal(state.tabs.find((tab) => tab.id === 1).groupId, 'design');
});
test('concurrent windows serialize group changes without lost updates', async () => {
  const { send, api } = fixture();
  await Promise.all([
    send('createGroup', { name: 'First' }),
    send('createGroup', { name: 'Second' }, 2),
  ]);
  const groups = api.testing.saved[MODEL_KEY].groups;
  assert(groups.some((g) => g.name === 'First'));
  assert(groups.some((g) => g.name === 'Second'));
  await assert.rejects(send('createGroup', { name: '   ' }), /name/);
  assert.equal((await send('snapshot')).groups.length, 5);
});
test('views are window-local, and corrupt scopes safely fall back to the root', async () => {
  const { send, api } = fixture();
  await send('enterGroup', { id: 'design' });
  assert.equal((await send('snapshot', {}, 2)).view.scopeId, null);
  await api.sessions.setWindowValue(1, VIEW_KEY, {
    scopeId: 'deleted',
    collapsed: ['deleted', 'work'],
  });
  const state = await send('snapshot');
  assert.equal(state.view.scopeId, null);
  assert.deepEqual(state.view.collapsed, ['work']);
});
test('invalid ordering destination does not move a tab out of its group', async () => {
  const { send, api } = fixture();
  await assert.rejects(
    send('moveTab', { id: 1, groupId: 'personal', beforeId: 999 }),
    /destination tab/,
  );
  assert.equal((await api.sessions.getTabValue(1, TAB_KEY)).groupId, 'design');
});

for (const [type, args] of [
  ['createGroup', { name: 'Unsaved' }],
  ['renameGroup', { id: 'design', name: 'Unsaved' }],
  ['moveGroup', { id: 'design', parentId: 'personal' }],
  ['removeGroup', { id: 'work' }],
]) {
  test(`failed ${type} storage writes do not leak into later model saves`, async () => {
    const { send, api } = fixture();
    const before = await send('snapshot');
    const confirmation = type === 'removeGroup' ? await send('getGroupContents', args) : {};
    const save = api.storage.local.set;
    api.storage.local.set = async () => {
      throw new Error('Storage unavailable');
    };
    await assert.rejects(send(type, { ...args, ...confirmation }), /Storage unavailable/);
    const after = await send('snapshot');
    assert.deepEqual(after.groups, before.groups);
    assert.deepEqual(api.testing.saved[MODEL_KEY].groups, before.groups);
    api.storage.local.set = save;
    const committed = await send('createGroup', { name: 'Saved' });
    const restarted = createController(api);
    const restored = await restarted.request({ type: 'snapshot', windowId: 1 });
    assert.deepEqual(restored.groups, committed.groups);
    assert.deepEqual(restored.groups.slice(0, -1), before.groups);
  });
}

test('null saved views fall back to Home', async () => {
  const { send, api } = fixture();
  await api.sessions.setWindowValue(1, VIEW_KEY, null);
  assert.deepEqual((await send('snapshot')).view, { scopeId: null, collapsed: [] });
});

test('private windows reject requests and do not assign created tabs', async () => {
  const { send, api, controller } = fixture();
  api.testing.windows.set(3, { id: 3, incognito: true });
  const tab = await api.tabs.create({ windowId: 3, incognito: true });
  await controller.created(tab);
  await assert.rejects(send('snapshot', {}, 3), /private windows/);
  assert.equal(await api.sessions.getTabValue(tab.id, TAB_KEY), undefined);
  assert(!(await send('snapshot')).tabs.some((item) => item.id === tab.id));
});
