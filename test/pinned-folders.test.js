import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, VIEW_KEY } from '../extension/src/model.js';
import {
  normalizeFolderPins,
  normalizePinLayout,
  reconcilePins,
} from '../extension/src/pinned-items.js';
import { exportFolderBackup } from '../extension/src/folder-backup.js';
import { memoryBrowser } from '../preview/browser.js';

const group = (id) => ({ kind: 'group', id });
const tab = (id) => ({ kind: 'tab', id });
const order = (state) => state.pins.map((item) => `${item.kind}:${item.id}`);

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'design', name: 'Design', parentId: 'work' },
      { id: 'other', name: 'Other', parentId: null },
      { id: 'empty', name: 'Empty', parentId: null },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, pinned: true, active: true },
      { id: 2, windowId: 1, index: 1, pinned: true },
      { id: 3, windowId: 1, index: 2, lastAccessed: 100 },
      { id: 4, windowId: 2, index: 0, pinned: true, active: true },
      { id: 5, windowId: 2, index: 1, pinned: true },
    ],
    memberships: {
      1: { treeId: 'a', groupId: null },
      2: { treeId: 'b', groupId: 'other' },
      3: { treeId: 'c', groupId: 'design' },
      4: { treeId: 'd', groupId: null },
      5: { treeId: 'e', groupId: null },
    },
  });
  let controller = createController(api);
  return {
    api,
    send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }),

    restart() {
      controller.dispose();
      controller = createController(api);
    },
  };
}

test('folder pins share preferences and order while windows keep independent mixed positions', async () => {
  const { send, restart } = fixture();
  assert.deepEqual((await send('snapshot')).folderPins, []);
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('setGroupPin', { id: 'other', action: 'reveal' });
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:work',
    'group:other',
  ]);
  await send('movePinnedItem', { item: group('work'), before: tab('b') });
  assert.deepEqual(order(await send('snapshot')), ['tab:a', 'group:work', 'tab:b', 'group:other']);
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:work',
    'group:other',
  ]);
  await send('movePinnedItem', { item: group('other'), before: tab('a') });
  assert.deepEqual(order(await send('snapshot')), ['group:other', 'tab:a', 'group:work', 'tab:b']);
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:other',
    'group:work',
  ]);
  await send('setGroupPin', { id: 'work', action: 'reveal', windowId: 2 });
  assert.deepEqual((await send('snapshot')).folderPins, [
    { id: 'other', action: 'reveal' },
    { id: 'work', action: 'reveal' },
  ]);
  restart();
  assert.deepEqual(order(await send('snapshot')), ['group:other', 'tab:a', 'group:work', 'tab:b']);
});

test('mixed tab moves use Firefox ordering; native moves refill tab slots without moving folders', async () => {
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('movePinnedItem', { item: group('work'), before: tab('b') });
  const membership = structuredClone(api.testing.tabValues);
  await send('movePinnedItem', { item: tab('b'), before: tab('a') });
  assert.deepEqual(order(await send('snapshot')), ['tab:b', 'tab:a', 'group:work']);
  await send('movePinnedItem', { item: group('work'), before: tab('a') });
  await api.tabs.move(1, { index: 0 });
  const state = await send('snapshot');
  assert.deepEqual(order(state), ['tab:a', 'group:work', 'tab:b']);
  assert.equal(state.tabs.find((tab) => tab.active).id, 1);
  assert.deepEqual(api.testing.tabValues, membership);
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:work',
  ]);
});

test('reorder followed by removal preserves slots even when another sidebar never refreshes', async () => {
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('setGroupPin', { id: 'other', action: 'open' });
  await send('movePinnedItem', { windowId: 2, item: group('work'), before: tab('d') });
  await send('movePinnedItem', { item: group('other'), before: group('work') });
  // No snapshot in window 2 between changing shared order and removing a pin.
  await send('setGroupPin', { id: 'other', action: null });
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:work',
  ]);
  await send('setGroupPin', { id: 'work', action: null });
  await send('setGroupPin', { id: 'work', action: 'reveal' });
  assert.deepEqual(api.testing.windowValues.get(2).pinLayout.at(-1), group('work'));
});

test('reveal expands only the path, keeps the active tab, and records only deliberate target expansion', async () => {
  const { send } = fixture();
  await send('enterGroup', { id: 'other' });
  await send('collapseAll', { collapsed: true });
  const before = await send('snapshot');
  const state = await send('revealGroup', { id: 'design' });
  assert.equal(state.view.scopeId, null);
  assert.deepEqual(state.view.collapsed, ['other', 'empty']);
  assert.equal(state.tabs.find((tab) => tab.active).id, before.tabs.find((tab) => tab.active).id);
  assert.deepEqual(state.view.recentFolders, before.view.recentFolders);
  assert.deepEqual(
    state.view.recentExpandedFolders.map((item) => item.id),
    ['design'],
  );
  assert.deepEqual((await send('revealGroup', { id: 'design' })).view, state.view);
  await send('enterGroup', { id: 'work' });
  assert.equal((await send('revealGroup', { id: 'design' })).view.scopeId, 'work');
  assert.equal((await send('revealGroup', { id: 'work' })).view.scopeId, null);
  await send('enterGroup', { id: 'empty' });
  assert.equal((await send('revealGroup', { id: 'empty' })).view.scopeId, null);
});

test('renames, moves and appearance preserve shortcuts; unpin/repin appends in every window', async () => {
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'design', action: 'reveal' });
  await send('setGroupPin', { id: 'other', action: 'open' });
  await send('snapshot', { windowId: 2 });
  await send('movePinnedItem', { item: group('design'), before: tab('a') });
  await send('renameGroup', { id: 'design', name: 'Ideas' });
  await send('moveGroup', { id: 'design', parentId: 'other' });
  await send('setGroupAppearance', { id: 'design', appearance: { icon: 'book', color: 'purple' } });
  assert.equal((await send('snapshot')).folderPins[0].id, 'design');
  await send('setGroupPin', { id: 'design', action: null });
  assert(!api.testing.windowValues.get(2).pinLayout.some((item) => item.id === 'design'));
  await send('setGroupPin', { id: 'design', action: 'open' });
  assert.deepEqual(order(await send('snapshot', { windowId: 2 })), [
    'tab:d',
    'tab:e',
    'group:other',
    'group:design',
  ]);
  await send('removeGroup', { id: 'other', ...(await send('getGroupContents', { id: 'other' })) });
  assert.deepEqual((await send('snapshot')).folderPins, []);
  assert(!(await send('snapshot', { windowId: 2 })).pins.some((item) => item.kind === 'group'));
});

test('restored tabs with new native IDs keep saved mixed slots, including incremental restoration', async () => {
  const { send, api, restart } = fixture();
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('movePinnedItem', { item: group('work'), before: tab('b') });
  const savedView = structuredClone(api.testing.windowValues.get(1));
  const savedTab = structuredClone(api.testing.tabValues.get(2));
  await api.tabs.remove(2);
  restart();
  await api.sessions.setWindowValue(1, VIEW_KEY, savedView);
  assert.deepEqual(order(await send('snapshot')), ['tab:a', 'group:work']);
  const restored = await api.tabs.create({ windowId: 1, index: 1, pinned: true });
  await api.sessions.setTabValue(restored.id, 'tabernacle.membership.v1', savedTab);
  restart();
  assert.deepEqual(order(await send('snapshot')), ['tab:a', 'group:work', 'tab:b']);
});

test('closed/unpinned/duplicated/transferred tabs reconcile without duplicate pins', async () => {
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('movePinnedItem', { item: group('work'), before: tab('b') });
  const duplicate = await api.tabs.duplicate(2);
  let state = await send('snapshot');
  assert.equal(new Set(state.pins.map((item) => item.id)).size, state.pins.length);
  assert.notEqual(state.tabs.find((tab) => tab.id === duplicate.id).treeId, 'b');
  await api.tabs.update(duplicate.id, { pinned: false });
  await api.testing.attach(2, 2);
  assert(!order(await send('snapshot')).includes('tab:b'));
  assert(order(await send('snapshot', { windowId: 2 })).includes('tab:b'));
  await api.tabs.remove(1);
  state = await send('snapshot');
  assert.deepEqual(order(state), ['group:work']);
  assert(!state.view.pinLayout.some((item) => item.id === 'a'));
});

test('stale requests and failed native/storage writes do not invent a successful reorder', async () => {
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'work', action: 'open' });
  const before = order(await send('snapshot'));
  for (const args of [
    { item: group('missing') },
    { item: tab('d') },
    { item: tab('a'), before: group('other') },
    { item: tab('a'), before: tab('missing') },
  ])
    await assert.rejects(send('movePinnedItem', args));
  await assert.rejects(send('setGroupPin', { id: 'missing', action: 'open' }));
  await assert.rejects(send('setGroupPin', { id: 'work', action: 'bad' }));
  await assert.rejects(send('revealGroup', { id: 'missing' }));
  const move = api.tabs.move;
  api.tabs.move = async () => [];
  await assert.rejects(
    send('movePinnedItem', { item: tab('b'), before: tab('a') }),
    /could not move/,
  );
  assert.deepEqual(order(await send('snapshot')), before);
  api.tabs.move = move;
  const save = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Cannot save pins');
  };
  await assert.rejects(send('setGroupPin', { id: 'other', action: 'open' }), /Cannot save/);
  assert.deepEqual(order(await send('snapshot')), before);
  api.storage.local.set = save;
  const viewSave = api.sessions.setWindowValue;
  api.sessions.setWindowValue = async () => {
    throw new Error('Cannot save layout');
  };
  await assert.rejects(
    send('movePinnedItem', { item: group('work'), before: tab('a') }),
    /Cannot save/,
  );
  api.sessions.setWindowValue = viewSave;
  assert.deepEqual(order(await send('snapshot')), before);
});

test('legacy/malformed data normalizes and folder exports omit pin preferences', async () => {
  const folders = [{ id: 'work' }];
  assert.deepEqual(
    normalizeFolderPins(folders, [
      null,
      { id: 'missing' },
      { id: 'work', action: 'bad' },
      { id: 'work', action: 'reveal' },
    ]),
    [{ id: 'work', action: 'open' }],
  );
  assert.deepEqual(normalizePinLayout([null, tab('a'), tab('a'), { kind: 'invalid', id: 'x' }]), [
    tab('a'),
  ]);
  assert.deepEqual(reconcilePins([], [], []).items, []);
  const { send, api } = fixture();
  await send('setGroupPin', { id: 'work', action: 'reveal' });
  const model = (await api.storage.local.get(MODEL_KEY))[MODEL_KEY];
  const backup = exportFolderBackup(model.groups, []);
  assert.equal(backup.version, 1);
  assert.equal(backup.folderPins, undefined);
  assert(backup.folders.every((folder) => !Object.hasOwn(folder, 'pinLayout')));
});
