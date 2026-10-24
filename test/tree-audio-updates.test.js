import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeIndex, updateTreeAudio } from '../extension/src/tree/index.js';

function fixture() {
  return {
    groups: [
      { id: 'a', name: 'A', parentId: null },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: null },
    ],
    tabs: [
      { id: 1, groupId: 'b' },
      { id: 2, groupId: 'b', parentTabId: 1, audible: true },
      { id: 3, groupId: 'b', parentTabId: 2, audible: true, mutedInfo: { muted: true } },
      { id: 4, groupId: 'b', parentTabId: 1, pinned: true, audible: true },
      { id: 5, groupId: 'b', parentTabId: 4 },
      { id: 6, groupId: 'c', audible: true },
    ].map((tab, order) => ({ order, title: String(tab.id), ...tab })),
  };
}

const playing = (tab) => Boolean(tab.audible && !tab.mutedInfo?.muted);
const summaries = (index) => ({
  tabs: [...index.audio],
  groups: [...index.groupStats].map(([id, stats]) => [id, stats.audio]),
});

test('audio totals ignore sibling order while visible rows keep their declared order', () => {
  const state = fixture();
  state.tabs = [
    state.tabs[4],
    state.tabs[2],
    state.tabs[5],
    state.tabs[3],
    state.tabs[1],
    state.tabs[0],
  ];
  const original = structuredClone(state);
  const index = createTreeIndex(state);
  assert.deepEqual(
    [...index.audio].sort(([a], [b]) => a - b),
    [
      [1, 2],
      [2, 1],
      [3, 0],
      [4, 1],
      [5, 0],
      [6, 1],
    ],
  );
  assert.deepEqual(
    [...index.groupStats].map(([id, stats]) => [id, stats.audio]),
    [
      ['a', 2],
      ['b', 2],
      ['c', 1],
    ],
  );
  assert.deepEqual(
    index.roots.get('b').map((tab) => tab.id),
    [1, 5],
  );
  assert.deepEqual(
    index.children.get(1).map((tab) => tab.id),
    [2],
  );
  assert.deepEqual(state, original);

  const silent = createTreeIndex({
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab, mutedInfo: { muted: true } })),
  });
  assert([...silent.audio.values()].every((count) => count === 0));
  assert([...silent.groupStats.values()].every((stats) => stats.audio === 0));
  assert.deepEqual(
    silent.roots.get('b').map((tab) => tab.id),
    [1, 5],
  );
});

test('audio deltas match full summaries for nested tabs, pins, muted states and separate folders', () => {
  let state = fixture();
  const index = createTreeIndex(state);
  const children = index.children;
  for (const patches of [
    [[2, { audible: false }]],
    [[3, { mutedInfo: { muted: false } }]],
    [
      [1, { audible: true }],
      [4, { mutedInfo: { muted: true } }],
    ],
    [
      [1, { mutedInfo: { muted: true } }],
      [5, { audible: true }],
    ],
    [[6, { mutedInfo: { muted: true } }]],
    [
      [3, { audible: false }],
      [4, { mutedInfo: { muted: false } }],
    ],
    [[2, { audible: true, mutedInfo: { muted: true } }]],
    [[2, { mutedInfo: { muted: false } }]],
  ]) {
    const byId = new Map(patches);
    const changes = [];
    state = {
      ...state,
      tabs: state.tabs.map((before) => {
        if (!byId.has(before.id)) return before;
        const tab = { ...before, ...byId.get(before.id) };
        changes.push({ tab, wasPlaying: playing(before) });
        return tab;
      }),
    };
    assert(updateTreeAudio(index, changes));
    assert.deepEqual(summaries(index), summaries(createTreeIndex(state)));
    assert.equal(index.children, children, 'Topology remains owned by the existing view');
    for (const { tab } of changes) index.byId.set(tab.id, tab);
  }
});

test('opposite changes preserve shared ancestor counts without touching source records', () => {
  const state = fixture();
  const original = structuredClone(state);
  for (const tab of state.tabs) Object.freeze(tab);
  const index = createTreeIndex(state);
  const affected = updateTreeAudio(index, [
    { tab: { ...state.tabs[1], audible: false }, wasPlaying: true },
    { tab: { ...state.tabs[4], audible: true }, wasPlaying: false },
  ]);
  assert(affected);
  assert(!affected.tabs.has(1));
  assert.equal(affected.groups.size, 0);
  assert.deepEqual(state, original);
});

for (const fault of [
  'missing tab',
  'missing ancestor summary',
  'tab cycle',
  'folder cycle',
  'invalid count',
]) {
  test(`audio summary ${fault} rejects the entire update without partial publication`, () => {
    const index = createTreeIndex(fixture());
    if (fault === 'missing tab') index.audio.delete(2);
    if (fault === 'missing ancestor summary') index.audio.delete(1);
    if (fault === 'tab cycle') index.byId.get(1).parentTabId = 2;
    if (fault === 'folder cycle') index.folders.parents.set('a', 'b');
    if (fault === 'invalid count') index.groupStats.get('a').audio = 0;
    const before = summaries(index);
    assert.equal(
      updateTreeAudio(index, [
        { tab: { id: 2, groupId: 'b', parentTabId: 1, audible: false }, wasPlaying: true },
      ]),
      null,
    );
    assert.deepEqual(summaries(index), before);
  });
}

test('deep audio paths are iterative and include pinned ancestors', () => {
  const state = {
    groups: [],
    tabs: Array.from({ length: 31 }, (_, i) => ({
      id: i + 1,
      parentTabId: i || null,
      order: i,
      pinned: i === 10,
    })),
  };
  const index = createTreeIndex(state);
  const last = { ...state.tabs[30], audible: true };
  const affected = updateTreeAudio(index, [{ tab: last, wasPlaying: false }]);
  assert.equal(affected.tabs.size, 31);
  assert([...index.audio.values()].every((count) => count === 1));
  assert.deepEqual(
    summaries(index),
    summaries(createTreeIndex({ ...state, tabs: [...state.tabs.slice(0, -1), last] })),
  );
});
