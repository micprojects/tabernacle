import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeIndex } from '../extension/src/tree/index.js';
import { projectTree, createDomainTreeProjector } from '../extension/src/tree/projection.js';

function fixture() {
  const tab = (id, groupId, fields = {}) => ({
    id,
    treeId: `t${id}`,
    groupId,
    index: id,
    order: id,
    parentTabId: null,
    title: `Alpha ${id}`,
    url: `https://example.test/${id}`,
    openedAt: 100 + id,
    lastAccessed: 200 - id,
    ...fields,
  });
  return {
    groups: [
      { id: 'work', name: 'Alpha work', parentId: null },
      { id: 'nested', name: 'Nested', parentId: 'work' },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      tab(1, 'work', { collapsed: true }),
      tab(2, 'work', { parentTabId: 1, title: 'Beta', url: 'https://sub.example.test/two' }),
      tab(3, 'nested', { pinned: true, openedAt: 0 }),
      tab(4, 'nested', { savedForLaterAt: 1 }),
      tab(5, 'other', {
        title: 'Reader',
        url: 'about:reader?url=https%3A%2F%2Fwww.example.test%2Freader',
      }),
      tab(6, null, { url: 'https://other.test/' }),
      tab(7, 'nested', { parentTabId: 3 }),
      tab(8, null, { url: 'about:blank' }),
      tab(9, null, { url: 'not a URL' }),
    ],
    pins: [{ kind: 'tab', id: 't3' }],
    folderPins: [],
    view: { scopeId: 'work', collapsed: ['work'] },
  };
}

const inspect = (projection) => ({
  domainTabs: projection.domainTabs,
  visible: projection.visibleRows.map((row) => row.key),
  matching: projection.matchingRows.map((row) => row.key),
  filterTargets: projection.filterTabIds,
  closeTargets: projection.closeTabIds,
  logical: projection.logicalRows.map((row) => ({
    key: row.key,
    mode: row.mode,
    depth: row.depth,
    parentKey: row.parentKey,
    visible: row.visible,
    matchesFilter: row.matchesFilter,
    expanded: row.expanded,
    disclosure: row.disclosure,
    stats: row.stats,
    aria: row.aria,
    target: row.target,
    label: row.label,
  })),
});
const options = { domain: 'example.test', sort: 'tree' };

test('cached domain collections preserve projection and target semantics for every query and sort', () => {
  const state = fixture();
  const before = structuredClone(state);
  const cache = createDomainTreeProjector();
  for (const domain of ['example.test', 'sub.example.test', 'other.test']) {
    for (const sort of ['newest', 'oldest', 'viewed', 'least-viewed', 'title', 'tree', 'invalid']) {
      for (const query of ['', 'alpha', 'beta', 'missing', 'READER', '/two']) {
        const settings = { query, sort, domain };
        assert.deepEqual(
          inspect(cache.project(state, settings)),
          inspect(projectTree(state, createTreeIndex(state, query), settings)),
          `${domain}/${query}/${sort}`,
        );
      }
    }
  }
  assert.deepEqual(state, before);
});

test('queries share only the read-only collection and index, not mutable projection records', () => {
  const state = fixture();
  const cache = createDomainTreeProjector();
  const first = cache.project(state, { ...options, query: 'alpha' });
  const before = inspect(first);
  const second = cache.project(state, { ...options, query: 'beta' });
  assert.equal(second.index, first.index);
  assert.equal(second.domainTabs, first.domainTabs);
  assert(Object.isFrozen(second.domainTabs));
  assert.throws(() => second.domainTabs.push(state.tabs[0]), TypeError);
  assert.notEqual(second.roots[0], first.roots[0]);
  assert.notDeepEqual(second.filterTabIds, first.filterTabIds);
  assert.deepEqual(inspect(first), before);
  assert(
    [...first.index.tabStats.values()].every((stats) => !stats.match && !stats.descendantMatch),
  );
});

test('domain and sort changes replace one collection while reusing the current state index', () => {
  const state = fixture();
  const cache = createDomainTreeProjector();
  const first = cache.project(state, options);
  const other = cache.project(state, { ...options, domain: 'other.test' });
  assert.equal(other.index, first.index);
  assert.deepEqual(other.filterTabIds, [6]);
  const returned = cache.project(state, options);
  assert.notEqual(returned.domainTabs, first.domainTabs, 'No history of domain collections');
  assert.equal(returned.index, first.index);
  const sorted = cache.project(state, { ...options, sort: 'oldest' });
  assert.equal(sorted.index, first.index);
  assert.notEqual(sorted.domainTabs, returned.domainTabs);
  assert.throws(() => cache.project(state, {}), /domain is required/);
});

test('new snapshots refresh membership, topology and metadata without modifying older projections', () => {
  const state = fixture();
  const cache = createDomainTreeProjector();
  const first = cache.project(state, options);
  const before = inspect(first);
  const next = structuredClone(state);
  next.tabs[1] = {
    ...next.tabs[1],
    title: 'Changed',
    url: 'https://other.test/',
    groupId: 'other',
    parentTabId: null,
    audible: true,
  };
  next.groups[0].name = 'Renamed';
  const second = cache.project(next, options);
  assert.notEqual(second.index, first.index);
  assert.equal(second.index.byId.get(2), next.tabs[1]);
  assert.equal(second.index.groupStats.get('other').audio, 1);
  assert.equal(second.filterTabIds.includes(2), false);
  assert.equal(second.index.groups.get('work').name, 'Renamed');
  assert.deepEqual(inspect(first), before);
  assert.notEqual(
    cache.project(state, options).index,
    first.index,
    'No history of snapshot indexes',
  );
});

test('clearing releases the entry and supports explicit in-place source changes', () => {
  const state = fixture();
  const cache = createDomainTreeProjector();
  const first = cache.project(state, options);
  state.tabs.push({ ...state.tabs[0], id: 10, treeId: 't10', index: 10, audible: true });
  cache.clear();
  cache.clear();
  const second = cache.project(state, options);
  assert.notEqual(second.index, first.index);
  assert(second.filterTabIds.includes(10));
  assert(!first.filterTabIds.includes(10));
  assert.equal(second.index.groupStats.get('work').audio, 1);
});

test('failed index or collection construction never publishes a partial entry and remains retryable', () => {
  const state = fixture();
  const cache = createDomainTreeProjector();
  const first = cache.project(state, options);
  let failed = true;
  const unreadable = {
    ...state,

    get tabs() {
      if (failed) throw new Error('Index read failed');
      return state.tabs.slice(1);
    },
  };
  assert.throws(() => cache.project(unreadable, options), /Index read failed/);
  assert.equal(cache.project(state, options).domainTabs, first.domainTabs);
  failed = false;
  const recovered = cache.project(unreadable, options);
  assert.equal(recovered.filterTabIds.includes(1), false);

  let unreadableUrl = true;
  const next = {
    ...state,
    tabs: [
      {
        ...state.tabs[0],
        url: {
          startsWith() {
            if (unreadableUrl) throw new Error('Collection read failed');
            return false;
          },

          toString() {
            return 'https://example.test/retry';
          },
        },
      },
    ],
  };
  assert.throws(() => cache.project(next, options), /Collection read failed/);
  assert.equal(cache.project(unreadable, options).domainTabs, recovered.domainTabs);
  unreadableUrl = false;
  assert.deepEqual(cache.project(next, options).filterTabIds, [1]);
});
