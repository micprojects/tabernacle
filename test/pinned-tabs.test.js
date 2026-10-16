import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { pinMoveMessage } from './helpers/pin-move.js';

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
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });

  const message = async (id, beforeId = null) => {
    const state = await send('snapshot');
    const ref = (id) => ({ kind: 'tab', id: state.tabs.find((tab) => tab.id === id).treeId });
    return pinMoveMessage(state, ref(id), beforeId === null ? null : ref(beforeId));
  };

  return {
    api,
    send,
    message,
    movePin: async (id, beforeId) => send('moveItem', await message(id, beforeId)),
  };
}

const order = (state) =>
  state.tabs
    .filter((tab) => tab.pinned)
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);

test('pins move in both directions and to the end using native order, retaining their trees and selection', async () => {
  const { api, send, movePin } = fixture();
  const before = await send('snapshot');
  const saved = structuredClone(api.testing.tabValues);
  const otherWindow = await api.tabs.query({ windowId: 2 });
  assert.deepEqual(order(await movePin(3, 1)), [3, 1, 2]);
  assert.deepEqual(order(await movePin(3, 2)), [1, 3, 2]);
  const moved = await movePin(1);
  assert.equal(moved.moveResult.committed, true);
  assert.equal(moved.moveResult.revealError, undefined);
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
  const { api, send, movePin } = fixture();
  await send('snapshot');
  api.tabs.move = async () => assert.fail('The order is already correct');
  for (const [id, beforeId] of [
    [1, 1],
    [1, 2],
    [3, null],
  ]) {
    const state = await movePin(id, beforeId);
    assert.deepEqual(order(state), [1, 2, 3]);
    assert.equal(state.moveResult.committed, true);
    assert.equal(state.moveResult.label, 'Already in this position.');
  }
});

test('invalid and other-window pin moves are rejected by the controller, and unpinning invalidates prepared moves', async () => {
  const { api, send, message } = fixture();
  const before = await send('snapshot');
  const planned = await message(3, 1);
  // Send invalid messages to the controller itself, rather than only testing
  // the client-side planner's validation.
  for (const invalid of [
    { source: { kind: 'tab', id: 5, treeId: 'other-window' } },
    { source: { kind: 'tab', id: 999, treeId: 'missing' } },
    { source: { ...planned.source, treeId: 'replaced' } },
    ...['child', 'other-window', 'missing'].map((id) => ({
      destination: { kind: 'pins', before: { kind: 'tab', id } },
    })),
  ]) {
    await assert.rejects(send('moveItem', { ...planned, ...invalid }));
    assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  }
  const destination = await message(1, 3);
  await api.tabs.update(3, { pinned: false });
  const unpinned = await send('snapshot');
  await assert.rejects(send('moveItem', destination), /destination/);
  await assert.rejects(send('moveItem', planned), /source or destination has moved/);
  assert.deepEqual((await send('snapshot')).tabs, unpinned.tabs);
});

test('native move errors and silent failures are reported without changing saved tab organisation', async () => {
  const { api, send, message } = fixture();
  const before = await send('snapshot');
  const planned = await message(3, 1);
  const move = api.tabs.move;
  api.tabs.move = async () => {
    throw new Error('Move refused');
  };
  await assert.rejects(send('moveItem', planned), /Move refused/);
  api.tabs.move = async () => [];
  await assert.rejects(send('moveItem', planned), /could not move/);
  assert.deepEqual((await send('snapshot')).tabs, before.tabs);
  api.tabs.move = move;
  const moved = await send('moveItem', planned);
  assert.deepEqual(order(moved), [3, 1, 2]);
  assert.equal(moved.moveResult.operationId, planned.operationId);
  api.tabs.move = async () => assert.fail('A committed operation must not move twice');
  assert.deepEqual(order(await send('moveItem', planned)), [3, 1, 2]);
});
