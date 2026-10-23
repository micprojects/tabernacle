import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMove, moveSource } from '../extension/src/move-plan.js';

const state = {
  groups: [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'child', name: 'Child', parentId: 'work' },
  ],
  tabs: [
    {
      id: 1,
      treeId: 'a',
      title: 'Parent',
      groupId: 'work',
      parentTabId: null,
      ancestors: [],
      order: 0,
    },
    {
      id: 2,
      treeId: 'b',
      title: 'Child',
      groupId: 'work',
      parentTabId: 1,
      ancestors: ['a'],
      order: 0,
    },
    {
      id: 3,
      treeId: 'c',
      title: 'Other',
      groupId: null,
      parentTabId: null,
      ancestors: [],
      order: 0,
    },
    {
      id: 4,
      treeId: 'd',
      title: 'Pin',
      pinned: true,
      groupId: null,
      parentTabId: null,
      ancestors: [],
      order: 1,
    },
  ],
  pins: [
    { kind: 'tab', id: 'd' },
    { kind: 'group', id: 'work' },
  ],
};
const tab = (id) => moveSource(state, 'tab', id);

test('a tab on either folder edge always previews insertion inside the folder', () => {
  for (const position of ['before', 'inside', 'after']) {
    const plan = resolveMove(state, tab(3), { kind: 'group', id: 'work', position });
    assert.deepEqual(plan.destination, {
      kind: 'tree',
      groupId: 'work',
      parentTabId: null,
      beforeId: null,
    });
    assert.match(plan.label, /into Home \/ Work/);
  }
});

test('after a parent means after its entire subtree, never between its children', () => {
  const plan = resolveMove(state, tab(3), { kind: 'tab', id: 1, position: 'after' });
  assert.equal(plan.destination.parentTabId, null);
  assert.equal(plan.destination.beforeId, null);
  assert.match(plan.label, /after Parent/);
});

test('cycles and folders beneath tabs are rejected before commit', () => {
  assert.throws(
    () => resolveMove(state, tab(1), { kind: 'tab', id: 2, position: 'inside' }),
    /children/,
  );
  assert.throws(
    () => resolveMove(state, moveSource(state, 'group', 'work'), { kind: 'group', id: 'child' }),
    /subfolders/,
  );
  assert.throws(
    () =>
      resolveMove(state, moveSource(state, 'group', 'work'), {
        kind: 'tab',
        id: 1,
        position: 'inside',
      }),
    /Folders cannot/,
  );
});

test('pin transitions are explicit and only change the source pin state', () => {
  const unpin = resolveMove(state, tab(4), { kind: 'group', id: 'work' });
  assert.equal(unpin.pinned, false);
  assert.match(unpin.label, /Unpin and move/);
  const pin = resolveMove(state, tab(1), { kind: 'pins', before: null });
  assert.equal(pin.pinned, true);
  assert.equal(pin.count, 1);
  assert.match(pin.label, /Pin/);
});

test('an unchanged slot is a no-op and source identity is checked', () => {
  assert.equal(resolveMove(state, tab(3), { kind: 'tree', groupId: null }).noOp, true);
  assert.throws(
    () => resolveMove(state, { ...tab(3), treeId: 'stale' }, { kind: 'group', id: 'work' }),
    /changed/,
  );
});

test('placement checks ignore titles but detect moved anchors', () => {
  const intent = { kind: 'tab', id: 1, position: 'before' };
  const before = resolveMove(state, tab(3), intent).expected;
  const renamed = structuredClone(state);
  renamed.tabs[0].title = 'New title';
  assert.equal(resolveMove(renamed, tab(3), intent).expected, before);
  renamed.tabs[0].order = 100;
  assert.notEqual(resolveMove(renamed, tab(3), intent).expected, before);
});

test('container and pin previews describe the exact insertion boundary', () => {
  const before = resolveMove(state, tab(3), { kind: 'tree', groupId: 'work', beforeId: 1 });
  assert.match(before.label, /before Parent/);
  const last = resolveMove(state, tab(3), { kind: 'tree', groupId: 'work' });
  assert.match(last.label, /at the end/);
  const pin = resolveMove(state, tab(3), { kind: 'pins', before: { kind: 'group', id: 'work' } });
  assert.match(pin.label, /before Work/);
});

test('folder plans bound folder reads with many tabs and preserve descendant counts', () => {
  let reads = 0;
  const count = 1000;
  const groups = Array.from({ length: count }, (_, i) => ({
    get id() {
      reads++;
      return `g${i}`;
    },

    name: `Folder ${i}`,
    parentId: i % 500 ? `g${i - (i % 500)}` : null,
  }));
  const current = {
    groups,
    tabs: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      groupId: `g${i}`,
      pinned: i % 7 === 0,
      ...(i % 10 === 0 ? { savedForLaterAt: 1000 } : {}),
    })),
  };
  const plan = resolveMove(current, { kind: 'group', id: 'g0' }, { kind: 'group', id: 'g500' });
  assert.equal(plan.count, 450);
  assert.deepEqual(plan.destination, { kind: 'folder', parentId: 'g500', beforeId: null });
  assert.match(plan.label, /into Home \/ Folder 500/);
  assert(reads < count * 30, `Expected linear folder reads, observed ${reads}`);
});

test('folder plans refresh counts, paths, siblings and cycle checks after in-place edits', () => {
  const current = structuredClone(state);
  current.tabs.push(
    { id: 5, groupId: 'child', pinned: true },
    { id: 6, groupId: 'child', savedForLaterAt: 1000 },
  );
  const source = { kind: 'group', id: 'work' };
  const before = resolveMove(current, source, { kind: 'folder', parentId: null });
  assert.equal(before.count, 3);
  assert.equal(before.noOp, true);
  assert.throws(() => resolveMove(current, source, { kind: 'group', id: 'child' }), /subfolders/);
  current.groups[1].parentId = null;
  current.groups[1].name = 'Independent';
  const after = resolveMove(current, source, { kind: 'group', id: 'child' });
  assert.equal(after.count, 2);
  assert.equal(after.noOp, false);
  assert.match(after.label, /into Home \/ Independent/);
  assert.notEqual(after.expected, before.expected);
  current.groups.reverse();
  const reordered = resolveMove(current, source, { kind: 'folder', parentId: null });
  assert.equal(reordered.noOp, true);
  assert.notEqual(reordered.expected, before.expected);
});
