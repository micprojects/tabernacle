import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubtreeIds, isWithin, removeGroup } from '../extension/src/model.js';

test('subtree discovery preserves ancestry across arbitrary storage order and in-place moves', () => {
  const model = {
    opaque: { keep: true },
    groups: [
      { id: 'deep', name: 'Deep', parentId: 'child', opaque: [1, 2] },
      { id: 'other', name: 'Other', parentId: null, future: { setting: true } },
      { id: 'root', name: 'Root', parentId: null },
      { id: 'child', name: 'Child', parentId: 'root' },
      { id: 'sibling', name: 'Sibling', parentId: 'root' },
      { id: 'outside', name: 'Outside', parentId: 'other' },
    ],
  };
  for (const id of model.groups.map((group) => group.id))
    assert.deepEqual(
      new Set(groupSubtreeIds(model, id)),
      new Set(
        model.groups.filter((group) => isWithin(model, group.id, id)).map((group) => group.id),
      ),
    );
  assert.deepEqual([...groupSubtreeIds(model, 'missing')], []);
  model.groups.find((group) => group.id === 'child').parentId = 'other';
  assert.deepEqual(groupSubtreeIds(model, 'root'), new Set(['root', 'sibling']));
  const survivors = model.groups.filter((group) => !['root', 'sibling'].includes(group.id));
  const before = structuredClone(survivors);
  assert.equal(removeGroup(model, 'root'), null);
  assert.deepEqual(model.groups, before);
  assert(model.groups.every((group, i) => group === survivors[i]));
  assert.deepEqual(model.opaque, { keep: true });
  assert.equal(removeGroup(model, 'child'), 'other');
  assert.deepEqual(
    model.groups.map((group) => group.id),
    ['other', 'outside'],
  );
});

test('deep folder deletion uses bounded work without recursion', () => {
  const size = 1000;
  let reads = 0;
  const model = {
    groups: Array.from({ length: size }, (_, i) => ({
      get id() {
        reads++;
        return `g${i}`;
      },

      name: `Folder ${i}`,
      parentId: i ? `g${i - 1}` : null,
    })),
  };
  assert.equal(removeGroup(model, 'g0'), null);
  assert.equal(model.groups.length, 0);
  assert(reads < size * 20, `Deletion revisited folder identities ${reads} times`);
});

test('subtree traversal is finite for malformed cycles and never includes an absent root', () => {
  const model = {
    groups: [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'missing' },
      { id: 'd', name: 'D', parentId: null },
    ],
  };
  assert.deepEqual(groupSubtreeIds(model, 'a'), new Set(['a', 'b']));
  assert.deepEqual([...groupSubtreeIds(model, 'missing')], []);
  const before = structuredClone(model);
  assert.throws(() => removeGroup(model, 'missing'), /no longer exists/);
  assert.throws(() => removeGroup(model, null), /Choose a folder/);
  assert.deepEqual(model, before);
  assert.equal(removeGroup(model, 'a'), 'b');
  assert.deepEqual(
    model.groups.map((group) => group.id),
    ['c', 'd'],
  );
});
