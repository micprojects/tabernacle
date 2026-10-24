import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeIndex, updateTreeQuery } from '../extension/src/tree/index.js';
import { projectTree } from '../extension/src/tree/projection.js';

function fixture() {
  return {
    groups: [
      { id: 'a', name: 'Alpha', parentId: null },
      { id: 'b', name: 'Nested', parentId: 'a' },
      { id: 'c', name: 'Empty', parentId: null },
    ],
    tabs: [
      { id: 1, groupId: 'a', title: 'Parent', collapsed: true },
      { id: 2, groupId: 'a', title: 'Needle', parentTabId: 1, active: true },
      { id: 3, groupId: 'b', title: 'Pin', pinned: true, audible: true },
      { id: 4, groupId: 'b', title: 'Promoted', parentTabId: 3 },
      { id: 5, groupId: null, title: 'Outside', audible: true },
      { id: 6, groupId: 'a', title: 'Leaf', parentTabId: 2 },
    ].map((tab, order) => ({ order, index: order, url: `https://example.test/${tab.id}`, ...tab })),
    view: { scopeId: null, collapsed: ['a'] },
    pins: [],
    folderPins: [],
  };
}

const summaries = (index) => ({
  ...index,
  folders: { ...index.folders, path: null, isWithin: null },
});
const describe = (projection) => ({
  close: projection.closeTabIds,
  filter: projection.filterTabIds,
  visible: projection.visibleRows.map((row) => row.key),
  rows: projection.logicalRows.map((row) => ({
    key: row.key,
    parent: row.parentKey,
    depth: row.depth,
    stats: row.stats,
    matches: row.matchesFilter,
    expanded: row.expanded,
    target: row.target,
    aria: row.aria,
  })),
});

test('query-only updates match fresh indexes and projections without changing topology or source', () => {
  const state = fixture();
  const before = structuredClone(state);
  const index = createTreeIndex(state);
  const structure = [index.tabs, index.children, index.roots, index.folders, index.audio];
  for (const scopeId of [null, 'a', 'b']) {
    for (const query of ['needle', 'alpha', 'empty', 'promoted', 'example.test/6', 'missing', '']) {
      updateTreeQuery(index, query);
      const fresh = createTreeIndex(state, query);
      assert.deepEqual(summaries(index), summaries(fresh), query);
      const scoped = { ...state, view: { ...state.view, scopeId } };
      assert.deepEqual(
        describe(projectTree(scoped, index, { query })),
        describe(projectTree(scoped, fresh, { query })),
      );
      [index.tabs, index.children, index.roots, index.folders, index.audio].forEach((value, i) =>
        assert.equal(value, structure[i]),
      );
    }
  }
  assert.deepEqual(state, before);
});

test('query updates handle deep branches iteratively and clear old descendant matches', () => {
  const state = {
    groups: [],
    tabs: Array.from({ length: 2000 }, (_, id) => ({
      id,
      title: id === 1999 ? 'Needle' : 'Other',
      parentTabId: id ? id - 1 : null,
      order: id,
    })),
  };
  const index = createTreeIndex(state);
  updateTreeQuery(index, 'needle');
  assert.equal(index.tabStats.get(0).descendantMatch, true);
  updateTreeQuery(index, 'absent');
  assert.deepEqual(index.tabStats, createTreeIndex(state, 'absent').tabStats);
});
