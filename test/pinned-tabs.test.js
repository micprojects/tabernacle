import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, index: 0, windowId: 1, pinned: true },
      { id: 2, index: 1, windowId: 1, pinned: true, active: true },
      { id: 3, index: 2, windowId: 1, pinned: true },
      { id: 4, index: 3, windowId: 1, pinned: false },
      { id: 5, index: 0, windowId: 2, pinned: true },
    ],
    memberships: {
      1: { groupId: 'work', treeId: 'parent', ancestors: [], collapsed: true },
      2: { groupId: null, treeId: 'second', ancestors: [] },
      3: { groupId: 'work', treeId: 'third', ancestors: [] },
      4: { groupId: 'work', treeId: 'child', ancestors: ['parent'] },
      5: { groupId: null, treeId: 'other-window', ancestors: [] },
    },
  });
  const controller = createController(api);
  return {
    api,
    send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }),
  };
}

const order = (state) =>
  state.tabs
    .filter((tab) => tab.pinned)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);

test('pins move in both directions and to the end using native order, retaining their trees and selection', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const saved = structuredClone(api.testing.tabValues);
  const otherWindow = await api.tabs.query({ windowId: 2 });
  assert.deepEqual(order(await send('movePinnedTab', { id: 3, beforeId: 1 })), [3, 1, 2]);
  assert.deepEqual(order(await send('movePinnedTab', { id: 3, beforeId: 2 })), [1, 3, 2]);
  const moved = await send('movePinnedTab', { id: 1, beforeId: null });
  assert.deepEqual(order(moved), [3, 2, 1]);
  assert.equal(moved.tabs.find((tab) => tab.active).id, 2);
  assert.deepEqual(
    moved.tabs.find((tab) => tab.id === 4),
    before.tabs.find((tab) => tab.id === 4),
  );
  assert.deepEqual(moved.view, before.view);
  assert.deepEqual(api.testing.tabValues, saved);
  assert.deepEqual(await api.tabs.query({ windowId: 2 }), otherWindow);
  const restarted = createController(api);
  assert.deepEqual(order(await restarted.request({ type: 'snapshot', windowId: 1 })), [3, 2, 1]);
});

test('self drops and drops into the current position do not issue browser moves', async () => {
  const { api, send } = fixture();
  await send('snapshot');
  api.tabs.move = async () => assert.fail('The order is already correct');
  for (const args of [
    { id: 1, beforeId: 1 },
    { id: 1, beforeId: 2 },
    { id: 3, beforeId: null },
  ])
    assert.deepEqual(order(await send('movePinnedTab', args)), [1, 2, 3]);
});

test('stale, unpinned and other-window sources or destinations cannot alter pinned order', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  for (const args of [
    { id: 4, beforeId: 1 },
    { id: 5, beforeId: 1 },
    { id: 1, beforeId: 4 },
    { id: 1, beforeId: 5 },
    { id: 1, beforeId: 999 },
    { id: 999, beforeId: 1 },
  ]) {
    await assert.rejects(send('movePinnedTab', args));
    assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  }
  await api.tabs.update(3, { pinned: false });
  await assert.rejects(send('movePinnedTab', { id: 1, beforeId: 3 }), /destination/);
  await assert.rejects(send('movePinnedTab', { id: 3, beforeId: 1 }), /no longer pinned/);
});

test('native move errors and silent failures are reported without changing saved tab organisation', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const move = api.tabs.move;
  api.tabs.move = async () => {
    throw new Error('Move refused');
  };
  await assert.rejects(send('movePinnedTab', { id: 3, beforeId: 1 }), /Move refused/);
  api.tabs.move = async () => [];
  await assert.rejects(send('movePinnedTab', { id: 3, beforeId: 1 }), /could not move/);
  assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  api.tabs.move = move;
  assert.deepEqual(order(await send('movePinnedTab', { id: 3, beforeId: 1 })), [3, 1, 2]);
});
