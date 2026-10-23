import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolderIndex } from '../extension/src/folder-index.js';
import { folderAppearance } from '../extension/src/folder-appearance.js';
import { groupContainer, groupPath, isWithin } from '../extension/src/model.js';
import { createTreeIndex } from '../extension/src/tree/index.js';

function fixture() {
  return {
    containers: [
      { cookieStoreId: 'blue', colorCode: '#123456' },
      { cookieStoreId: 'red', colorCode: '#ff0000' },
    ],
    groups: [
      { id: 'leaf', name: 'Leaf', parentId: 'child', appearance: { icon: 'book' } },
      { id: 'other', name: 'Other', parentId: null, defaultCookieStoreId: 'red' },
      {
        id: 'root',
        name: 'Root',
        parentId: null,
        defaultCookieStoreId: 'blue',
        appearance: { color: 'purple', icon: 'heart' },
      },
      { id: 'child', name: 'Child', parentId: 'root', defaultCookieStoreId: 'firefox-default' },
      {
        id: 'missing-container',
        name: 'Missing',
        parentId: 'root',
        defaultCookieStoreId: 'gone',
        appearance: { color: 'bad' },
      },
    ],
    tabs: [],
  };
}

test('indexed paths, descendants, containers and appearance preserve existing semantics', () => {
  const state = fixture();
  const index = createFolderIndex(state);
  for (const group of state.groups) {
    assert.deepEqual(index.path(group.id), groupPath(state, group.id));
    const details = index.details.get(group.id);
    assert.equal(details.source?.defaultCookieStoreId, groupContainer(state, group.id));
    assert.deepEqual(details.appearance, folderAppearance(group, details.container, state));
    for (const ancestor of [null, 'unknown', ...state.groups.map((item) => item.id)])
      assert.equal(index.isWithin(group.id, ancestor), isWithin(state, group.id, ancestor));
  }
  assert.deepEqual(
    index.children.get(null).map((g) => g.id),
    ['other', 'root'],
  );
  assert.equal(index.details.get('leaf').appearance.icon, 'book');
  assert.equal(index.details.get('child').appearance.icon, undefined);
});

test('rebuilding after in-place edits and moves refreshes inherited defaults and colours', () => {
  const state = fixture();
  const before = createFolderIndex(state);
  state.groups.find((g) => g.id === 'child').parentId = 'other';
  const after = createFolderIndex(state);
  assert.notEqual(
    before.details.get('leaf').appearance.color,
    after.details.get('leaf').appearance.color,
  );
  assert.equal(after.details.get('leaf').appearance.color, undefined);
  delete state.groups.find((g) => g.id === 'child').defaultCookieStoreId;
  assert.equal(createFolderIndex(state).details.get('leaf').appearance.color, '#ff0000');
});

test('deep trees are indexed and summarised iteratively without repeated parent scans', () => {
  let reads = 0;
  const groups = Array.from({ length: 10000 }, (_, i) => ({
    id: `g${i}`,
    name: `Folder ${i}`,

    get parentId() {
      reads++;
      return i ? `g${i - 1}` : null;
    },

    ...(i ? {} : { appearance: { color: 'blue' }, defaultCookieStoreId: 'blue' }),
  }));
  const index = createTreeIndex(
    { groups, tabs: [{ id: 1, title: 'needle', groupId: 'g9999' }] },
    'needle',
  );
  assert.equal(index.groupStats.get('g0').count, 1);
  assert.equal(index.groupStats.get('g0').match, true);
  assert.equal(index.folders.path('g9999').length, 10000);
  assert.equal(index.folders.details.get('g9999').source.id, 'g0');
  assert.equal(index.folders.isWithin('g9999', 'g5000'), true);
  assert(reads <= groups.length * 2, `Expected linear parent reads, got ${reads}`);
});

test('malformed cycles and missing parents remain finite and expose every folder once', () => {
  const index = createFolderIndex({
    groups: [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'orphan', parentId: 'missing' },
    ],
  });
  assert.equal(new Set(index.order.map((g) => g.id)).size, 3);
  for (const group of index.order) assert(index.path(group.id).length <= 3);
});
