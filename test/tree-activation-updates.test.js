import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeIndex, updateTreeActivation } from '../extension/src/tree/index.js';

test('activation patches match fresh indexes across ancestors, pin promotion and multiple changes', () => {
  let state = {
    groups: [{ id: 'a', name: 'A', parentId: null }],
    tabs: [
      { id: 1, groupId: 'a', collapsed: true },
      { id: 2, groupId: 'a', parentTabId: 1, active: true },
      { id: 3, groupId: 'a', parentTabId: 2 },
      { id: 4, groupId: 'a', parentTabId: 1, pinned: true },
      { id: 5, groupId: 'a', parentTabId: 4 },
      { id: 6, groupId: null },
    ].map((tab, order) => ({ title: String(tab.id), order, ...tab })),
  };
  const index = createTreeIndex(state);
  const structure = index.children;
  for (const activeIds of [[3], [4], [5], [1, 3], [3], [6], [], [2]]) {
    const changes = [];
    state = {
      ...state,
      tabs: state.tabs.map((before) => {
        const tab = { ...before, active: activeIds.includes(before.id) };
        if (Boolean(before.active) !== tab.active) changes.push({ tab });
        return tab;
      }),
    };
    const affected = updateTreeActivation(index, changes);
    assert(affected instanceof Set);
    assert.deepEqual(index.tabStats, createTreeIndex(state).tabStats);
    assert.equal(index.children, structure);
    for (const { tab } of changes) {
      assert(affected.has(tab.id));
      index.byId.set(tab.id, tab);
    }
  }
});

test('invalid activation paths do not partially publish changes', () => {
  const index = createTreeIndex({
    groups: [],
    tabs: [
      { id: 1, active: true },
      { id: 2, parentTabId: 1 },
    ],
  });
  const before = structuredClone(index.tabStats);
  assert.equal(updateTreeActivation(index, [{ tab: { id: 99, active: true } }]), null);
  index.byId.get(1).parentTabId = 2;
  assert.equal(updateTreeActivation(index, [{ tab: { id: 2, active: true } }]), null);
  assert.deepEqual(index.tabStats, before);
});

test('activation reaches every ancestor in a deep chain without recursive calls', () => {
  const state = {
    groups: [],
    tabs: Array.from({ length: 2000 }, (_, id) => ({ id, parentTabId: id ? id - 1 : null })),
  };
  const index = createTreeIndex(state);
  const tab = { ...state.tabs.at(-1), active: true };
  assert.equal(updateTreeActivation(index, [{ tab }]).size, 2000);
  assert([...index.tabStats.values()].every((stats) => stats.active));
  index.byId.set(tab.id, tab);
  assert.equal(updateTreeActivation(index, [{ tab: { ...tab, active: false } }]).size, 2000);
  assert([...index.tabStats.values()].every((stats) => !stats.active));
});
