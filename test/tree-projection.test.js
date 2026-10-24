import { createFullTreeRenderer } from '../extension/src/tree/full-renderer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeIndex } from '../extension/src/tree/index.js';
import { searchTabOrder } from '../extension/src/tab-collection.js';
import { domainResults } from '../extension/src/domain-filter.js';
import { projectTree } from '../extension/src/tree/projection.js';

function fixture() {
  const tab = (id, groupId, fields = {}) => ({
    id,
    treeId: `t${id}`,
    groupId,
    index: id,
    order: id,
    parentTabId: null,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    openedAt: 1700000000000 + id,
    lastAccessed: 1700000000000 - id,
    ...fields,
  });
  return {
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'nested', name: 'Target folder', parentId: 'work' },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      tab(1, 'work', { title: 'Parent', collapsed: true }),
      tab(2, 'work', { title: 'Target child', parentTabId: 1 }),
      tab(3, 'nested'),
      tab(4, 'nested', { title: 'Target article' }),
      tab(5, null),
      tab(10, 'work', { pinned: true }),
      tab(11, 'work', { parentTabId: 10 }),
    ],
    pins: [
      { kind: 'tab', id: 't10' },
      { kind: 'group', id: 'work' },
    ],
    folderPins: [{ id: 'work', name: 'Work', parentId: null }],
    view: { scopeId: null, collapsed: ['work'] },
  };
}

test('complete logical hierarchy is separate from visible navigation and action targets', () => {
  const state = fixture();
  const before = structuredClone(state);
  const index = createTreeIndex(state);
  const result = projectTree(state, index);
  assert.deepEqual(
    result.visibleRows.map((row) => row.key),
    ['group:work', 'group:other', 'new-tab:other', 'tab:5', 'new-tab:null'],
  );
  assert.deepEqual(result.filterTabIds, [3, 4, 1, 2, 11, 5]);
  assert(result.byKey.has('tab:2'));
  assert.equal(result.byKey.get('tab:2').visible, false);
  assert.equal(result.byKey.get('tab:2').parentKey, 'tab:1');
  assert.equal(result.byKey.get('tab:2').depth, 2);
  assert.equal(result.byKey.get('tab:11').parentKey, 'group:work');
  assert.equal(result.byKey.get('tab:11').tab.parentTabId, null);
  assert.equal(state.tabs.find((tab) => tab.id === 11).parentTabId, 10);
  assert.equal(result.byKey.get('tab:1').tab, index.roots.get('work')[0]);
  assert.deepEqual(result.byKey.get('new-child-tab:1').target, { kind: 'newChildTab', id: 1 });
  assert.deepEqual(
    result.pins.map((row) => row.key),
    ['tab:10', 'pin:group:work'],
  );
  assert.equal(result.source, state);
  assert.deepEqual(state, before);
});

for (const query of ['target', 'work', 'not present'])
  test(`search ${query} keeps authoritative collection order across collapsed branches`, () => {
    const state = fixture();
    const result = projectTree(state, createTreeIndex(state, query), { query });
    assert.deepEqual(result.filterTabIds, searchTabOrder(state, query));
    assert.deepEqual(
      result.visibleRows.filter((row) => row.kind === 'tab').map((row) => row.id),
      result.filterTabIds,
    );
    assert(!result.visibleRows.some((row) => row.kind === 'new-tab'));
    if (query === 'target') {
      assert.equal(result.byKey.get('tab:4').mode, 'tree');
      assert.equal(result.byKey.get('tab:1').expanded, true);
    }
  });

test('folder scope preserves local hierarchy without treating the scope fold as hidden content', () => {
  const state = fixture();
  state.view.scopeId = 'work';
  const result = projectTree(state, createTreeIndex(state));
  assert(!result.byKey.has('group:work'));
  assert.equal(result.byKey.get('group:nested').depth, 0);
  assert.equal(result.byKey.get('group:nested').visible, true);
  assert.equal(result.byKey.get('tab:1').visible, true);
  assert.equal(result.byKey.get('tab:2').visible, false);
  assert.deepEqual(result.filterTabIds, [3, 4, 1, 2, 11]);
  assert.deepEqual(result.byKey.get('new-tab:work').target, { kind: 'newTab', groupId: 'work' });
});

for (const sort of ['tree', 'title', 'newest', 'oldest', 'viewed', 'least-viewed'])
  test(`domain ${sort} projection preserves the domain authority and pin protection`, () => {
    const state = fixture();
    const index = createTreeIndex(state, 'tab');
    const result = projectTree(state, index, { domain: 'example.com', query: 'tab', sort });
    assert.deepEqual(
      result.filterTabIds,
      domainResults(index, 'example.com', 'tab', sort).map((tab) => tab.id),
    );
    assert(!result.closeTabIds.includes(10));
    assert(result.filterTabIds.includes(10));
    assert.equal(result.pins.length, 0);
    assert(
      result.visibleRows.every(
        (row) => row.depth === 0 && !row.disclosure && row.mode === 'domain',
      ),
    );
  });

function rendererFixture() {
  const document = { activeElement: null };
  const tree = { children: [], scrollTop: 0, ownerDocument: document };
  const pins = { children: [], ownerDocument: document };
  let released = 0;
  const renderer = createFullTreeRenderer({
    tree,
    pins,
    captureView: () => ({
      scrollTop: tree.scrollTop,
      focusedKey: document.activeElement?.key || null,
    }),

    restoreView: (saved) => {
      tree.scrollTop = saved.scrollTop;
      renderer.target(saved.focusedKey)?.focus();
    },

    reconcile: (parent, children) => {
      parent.children = children;
    },

    release: () => {
      released++;
    },

    renderRow(row, children) {
      const node = {
        key: row.key,
        dataset: { key: row.key },
        children,
        text: row.tab?.title || row.group?.name || row.label,

        scrollIntoView() {
          this.scrolled = true;
        },

        focus() {
          document.activeElement = this;
        },

        closest() {
          return this;
        },
      };
      return { node, target: node };
    },
  });
  return { tree, pins, document, renderer, released: () => released };
}

function mountedKeys(root) {
  const keys = [];
  const pending = [...root.children].reverse();
  while (pending.length) {
    const row = pending.pop();
    if (row.key) keys.push(row.key);
    for (let i = row.children.length - 1; i >= 0; i--) pending.push(row.children[i]);
  }
  return keys;
}

test('full renderer preserves nested row order, focus/scroll capture, suspension and disposal', () => {
  const state = fixture();
  const projection = projectTree(state, createTreeIndex(state, 'target'), { query: 'target' });
  const f = rendererFixture();
  assert.equal(f.renderer.update(projection), true);
  assert.deepEqual(
    mountedKeys(f.tree),
    projection.visibleRows.map((row) => row.key),
  );
  assert.equal(f.tree.children[0].key, 'group:work');
  assert.equal(f.tree.children[0].children[0].key, 'group:nested');
  f.tree.scrollTop = 123;
  assert.equal(f.renderer.ensureVisible('tab:2', { focus: true }), true);
  const saved = f.renderer.capture();
  assert.deepEqual(saved, { scrollTop: 123, focusedKey: 'tab:2' });
  f.renderer.suspend();
  assert.deepEqual(f.tree.children, []);
  assert.deepEqual(f.pins.children, []);
  assert.equal(f.renderer.ensureVisible('tab:2'), false);
  f.renderer.update(projection);
  f.tree.scrollTop = 0;
  f.renderer.restore(saved);
  assert.equal(f.tree.scrollTop, 123);
  assert.equal(f.document.activeElement.key, 'tab:2');
  f.renderer.dispose();
  f.renderer.dispose();
  assert.equal(f.released(), 2);
  assert.equal(f.renderer.update(projection), false);
});

test('full rendering mounts every visible result and handles deep trees without a call stack', () => {
  const state = {
    groups: [],
    tabs: Array.from({ length: 6000 }, (_, id) => ({
      id,
      parentTabId: id ? id - 1 : null,
      groupId: null,
      index: id,
      title: `Findable tab ${id}`,
    })),
    view: { scopeId: null, collapsed: [] },
    pins: [],
    folderPins: [],
  };
  const result = projectTree(state, createTreeIndex(state));
  const f = rendererFixture();
  f.renderer.update(result);
  assert.equal(result.filterTabIds.length, 6000);
  assert.equal(result.visibleRows.length, 12000);
  assert.deepEqual(
    mountedKeys(f.tree),
    result.visibleRows.map((row) => row.key),
  );
  assert.equal(f.renderer.ensureVisible('tab:5999'), true);
});

test('folded hierarchy remains index-backed without retaining hidden row descriptors', () => {
  const state = fixture();
  state.tabs = Array.from({ length: 60000 }, (_, i) => ({
    id: i + 1,
    treeId: 't' + (i + 1),
    groupId: 'work',
    parentTabId: null,
    index: i,
    title: 'Tab ' + i,
    url: 'https://example.com/' + i,
  }));
  state.pins = [];
  state.folderPins = [];
  const index = createTreeIndex(state);
  const result = projectTree(state, index);
  assert.equal(result.hierarchy, index);
  assert.equal(result.materializedRows, 4);
  assert.equal(result.materializedByKey.size, 4);
  assert.equal(result.materializedByKey.get('tab:60000'), undefined);
  assert.equal(result.visibleRows.length, 4);
  assert.equal(result.byKey.get('tab:60000').visible, false);
  assert.equal(result.filterTabIds.length, 60000);
  assert.equal(result.materializedRows, 4);
  const next = { ...state, generation: 'next' };
  result.source = next;
  assert.equal(result.source, next);
});

test('inspection metadata stays complete without per-row metadata objects or empty child arrays', () => {
  const state = fixture();
  state.view.collapsed = [];
  state.tabs[0].collapsed = false;
  const result = projectTree(state, createTreeIndex(state));
  const parent = result.materializedByKey.get('tab:1');
  const child = result.materializedByKey.get('tab:2');
  const leaf = result.materializedByKey.get('tab:5');
  const action = result.materializedByKey.get('new-child-tab:1');
  const folderAction = result.materializedByKey.get('new-tab:work');
  const rootAction = result.materializedByKey.get('new-tab:null');
  assert.deepEqual(parent.aria, { role: 'treeitem', level: 2, expanded: true, selected: false });
  assert.deepEqual(child.aria, { role: 'treeitem', level: 3, selected: false });
  assert.deepEqual(action.aria, { role: 'treeitem', level: 3 });
  assert.deepEqual(action.target, { kind: 'newChildTab', id: 1 });
  assert.deepEqual(action.drop, { kind: 'tab', id: 1 });
  assert.equal(action.label, 'New child tab of Parent');
  assert.deepEqual(folderAction.target, { kind: 'newTab', groupId: 'work' });
  assert.deepEqual(folderAction.drop, { kind: 'inside', id: 'work' });
  assert.equal(folderAction.label, 'New tab in Work');
  assert.equal(rootAction.label, 'New tab');
  assert.equal(child.children, leaf.children);
  assert.equal(child.children, action.children);
  assert(Object.isFrozen(child.children));
  assert.throws(() => child.children.push(leaf), TypeError);
  assert.notEqual(parent.children, child.children);
  assert(parent.children.includes(child));
  for (const row of result.visibleRows) {
    assert(!Object.hasOwn(row, 'aria'));
    assert(!Object.hasOwn(row, 'target'));
    assert(!Object.hasOwn(row, 'drop'));
    assert(!Object.hasOwn(row, 'label'));
    assert.equal(result.visibleKeys.has(row.key), true);
  }
  assert.equal(result.visibleKeys.has('tab:999999'), false);
  assert.equal(result.visibleKeys.has('tab:10'), false);
  child.tab = { ...child.tab, active: true };
  assert.equal(child.aria.selected, true);
});
