import test from 'node:test';
import assert from 'node:assert/strict';
import {
  savedSearchResults,
  folderCollection,
  inCollection,
  searchTabOrder,
  sourceUrl,
  captureTarget,
  duplicateGroups,
  suggestedDuplicates,
  viewedAge,
} from '../extension/src/tab-collection.js';
import { createTreeIndex } from '../extension/src/tree/index.js';
import { domainResults } from '../extension/src/domain-filter.js';
import { listDomains } from '../extension/src/domains.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { closeFallback } from '../extension/src/close-selection.js';
import { createFolderIndex } from '../extension/src/folder-index.js';
import { isWithin } from '../extension/src/model.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'child', name: 'Child', parentId: 'work' },
    ],
    tabs: [1, 2, 3, 4, 5].map((id) => ({
      id,
      index: id,
      windowId: id === 5 ? 2 : 1,
      url: `https://example.com/${id < 3 ? 'same' : id}`,
      title: `Page ${id}`,
      active: id === 4,
      cookieStoreId: 'firefox-default',
    })),
    memberships: Object.fromEntries(
      [1, 2, 3, 4, 5].map((id) => [
        id,
        {
          treeId: `tree-${id}`,
          groupId: id === 3 ? 'child' : 'work',
          ancestors: id === 3 ? ['tree-1'] : [],
          order: id * 1024,
        },
      ]),
    ),
  });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  return { api, send, controller };
}

test('saved search follows folder scope and source URLs, with its own order and no tree counts', async () => {
  const { send } = fixture();
  await send('saveForLater', { id: 1 });
  const state = await send('saveForLater', { id: 3 });
  state.tabs.find((tab) => tab.id === 3).url =
    'about:reader?url=https%3A%2F%2Fexample.com%2Farticle%23section';
  assert.deepEqual(
    savedSearchResults(state, 'example.com', 'work').map((tab) => tab.id),
    [3, 1],
  );
  assert.deepEqual(
    savedSearchResults(state, 'example.com', 'child').map((tab) => tab.id),
    [3],
  );
  assert.deepEqual(
    savedSearchResults(state, 'section', null).map((tab) => tab.id),
    [3],
  );
  assert.deepEqual(savedSearchResults(state, '', null), []);
  assert.equal(createTreeIndex(state).tabs.length, 2);
  assert.deepEqual(searchTabOrder(state, 'Page', null), [2, 4, 3, 1]);
});

test('least viewed keeps unknown dates last and ties in tree order', async () => {
  const state = await fixture().send('snapshot');
  for (const tab of state.tabs) tab.lastAccessed = { 1: 200, 2: 100, 3: 100 }[tab.id];
  assert.deepEqual(
    domainResults(createTreeIndex(state), 'example.com', '', 'least-viewed').map((tab) => tab.id),
    [3, 2, 1, 4],
  );
  assert.equal(viewedAge(undefined), '');
  assert.equal(viewedAge(1000, 1000 + 86400000), 'Last viewed 1 day ago');
  assert.equal(viewedAge(2000, 1000), 'Viewed today');
});

test('pinned domains include one child-host tab and disappear only at zero', () => {
  const tabs = [{ id: 1, url: 'https://sub.example.com/a' }];
  assert.deepEqual(listDomains(tabs), []);
  assert.equal(listDomains(tabs, ['example.com'])[0].count, 1);
  assert.deepEqual(listDomains([], ['example.com']), []);
});

test('duplicate identities retain all URL components and container boundaries', () => {
  const urls = [
    'https://example.com/a?x=1#one',
    'about:reader?url=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%23one',
    'https://example.com/a?x=1#two',
    'https://example.com/a?x=2#one',
    'about:blank',
  ];
  const tabs = urls.map((url, id) => ({ id, url }));
  tabs.push({ id: 6, url: urls[0], cookieStoreId: 'firefox-container-1' });
  assert.deepEqual(
    duplicateGroups(tabs).map((group) => group.map((tab) => tab.id)),
    [[0, 1]],
  );
  assert.equal(sourceUrl(tabs[1]), urls[0]);
});

test('suggestions preserve protected copies and choose recent or native-order keepers', () => {
  const tabs = [
    { id: 1, index: 0, lastAccessed: 5 },
    { id: 2, index: 1, lastAccessed: 10 },
    { id: 3, index: 2 },
  ];
  assert.deepEqual(suggestedDuplicates(tabs), [1, 3]);
  assert.deepEqual(
    suggestedDuplicates(tabs.map((tab) => ({ ...tab, lastAccessed: undefined }))),
    [2, 3],
  );
  assert.deepEqual(
    suggestedDuplicates(
      tabs.map((tab) => ({ ...tab, pinned: tab.id === 1, audible: tab.id === 3 })),
    ),
    [2],
  );
  assert.deepEqual(suggestedDuplicates(tabs.map((tab) => ({ ...tab, active: true }))), []);
});

test('batch saves retain displayed order, native state and guarded undo', async () => {
  const { api, send } = fixture();
  await api.tabs.update(1, { pinned: true });
  const before = await send('snapshot');
  const native = await api.tabs.query({ windowId: 1 });
  const targets = [3, 1, 2].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id)));
  const saved = await send('saveTabsForLater', { scope: { kind: 'folder', id: 'work' }, targets });
  assert.deepEqual(saved.batchResult.completed, [3, 1, 2]);
  assert.deepEqual(
    savedSearchResults(saved, 'Page', null).map((tab) => tab.id),
    [3, 1, 2],
  );
  assert.deepEqual(await api.tabs.query({ windowId: 1 }), native);
  await send('returnFromLater', { id: 1 });
  await send('saveForLater', { id: 1 });
  const undone = await send('undoSaveTabsForLater', { targets: saved.batchResult.undo });
  assert.deepEqual(undone.batchResult.completed, [3, 2]);
  assert.deepEqual(undone.batchResult.skipped, [1]);
  assert(undone.tabs.find((tab) => tab.id === 1).savedForLaterAt);
});

test('batch skips navigation, folder moves, changed saved membership and foreign windows', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const targets = before.tabs.map(captureTarget);
  await api.tabs.update(1, { url: 'https://example.com/new' });
  await send('saveForLater', { id: 2 });
  await send('moveTab', { id: 3, groupId: null });
  await api.testing.attach(4, 2);
  const result = await send('closeTabSet', {
    scope: { kind: 'domain', domain: 'example.com' },
    targets,
  });
  assert.deepEqual(result.batchResult.completed, []);
  assert.deepEqual(result.batchResult.skipped, [1, 2, 3, 4]);
});

for (const kind of ['window', 'folder']) {
  test(`batch reports partial failure and undo covers only saved members (${kind} scope)`, async () => {
    const { api, send } = fixture();
    const before = await send('snapshot');
    const write = api.sessions.setTabValue;
    api.sessions.setTabValue = async (id, ...args) => {
      if (id === 2) throw new Error('Disk full');
      return write(id, ...args);
    };
    const result = await send('saveTabsForLater', {
      scope: { kind, id: 'work' },
      targets: before.tabs.map(captureTarget),
    });
    assert.deepEqual(result.batchResult.completed, [1, 3, 4]);
    assert.equal(result.batchResult.failed[0].id, 2);
    assert.equal(result.batchResult.undo.length, 3);
    assert.equal(result.tabs.find((tab) => tab.id === 2).savedForLaterAt, undefined);
  });
}

test('duplicate close requires a surviving reviewed keeper and preserves descendants', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const targets = [captureTarget(before.tabs.find((tab) => tab.id === 1))];
  const keepers = [captureTarget(before.tabs.find((tab) => tab.id === 2))];
  await api.tabs.update(2, { url: 'https://example.com/changed' });
  const skipped = await send('closeDuplicateTabs', { scope: { kind: 'window' }, targets, keepers });
  assert.deepEqual(skipped.batchResult.skipped, [1]);
  await api.tabs.update(2, { url: 'https://example.com/same' });
  const closed = await send('closeDuplicateTabs', { scope: { kind: 'window' }, targets, keepers });
  assert.deepEqual(closed.batchResult.completed, [1]);
  assert(closed.tabs.some((tab) => tab.id === 3));
});

test('search close chooses a saved match without jumping to an unrelated native successor', async () => {
  const { send } = fixture();
  const before = await send('saveForLater', { id: 3 });
  const after = structuredClone(before);
  after.tabs = after.tabs.filter((tab) => tab.id !== 2);
  after.tabs.forEach((tab) => {
    tab.active = tab.id === 4;
  });
  after.tabs.find((tab) => tab.id === 4).title = 'Unrelated';
  before.tabs.find((tab) => tab.id === 4).title = 'Unrelated';
  before.tabs.find((tab) => tab.id === 1).title = 'Unrelated';
  after.tabs.find((tab) => tab.id === 1).title = 'Unrelated';
  assert.equal(
    closeFallback(before, after, 2, { search: true, query: 'Page', scopeId: null, tabIds: [3] }),
    3,
  );
});

test('nested pins count a remaining child only once regardless of pin order', () => {
  const tabs = [{ url: 'https://child.sub.example.com/page' }];
  for (const pins of [
    ['sub.example.com', 'example.com'],
    ['example.com', 'sub.example.com'],
  ])
    assert.deepEqual(
      listDomains(tabs, pins).map(({ domain, count }) => [domain, count]),
      [
        ['example.com', 1],
        ['sub.example.com', 1],
      ],
    );
});

test('returned Reader View tabs match the same source query in ordinary search', async () => {
  const { api, send } = fixture();
  await api.tabs.update(1, { url: 'about:reader?url=https%3A%2F%2Fexample.com%2Fstory%23part' });
  let state = await send('saveForLater', { id: 1 });
  assert.deepEqual(searchTabOrder(state, 'example.com/story#part', null), [1]);
  state = await send('returnFromLater', { id: 1 });
  assert.deepEqual(searchTabOrder(state, 'example.com/story#part', null), [1]);
  assert.deepEqual(
    domainResults(createTreeIndex(state), 'example.com', 'story#part').map((tab) => tab.id),
    [1],
  );
});

test('reviewed keepers that close or change saved membership never permit closure', async () => {
  for (const change of ['close', 'save']) {
    const { api, send } = fixture();
    const state = await send('snapshot');
    const target = state.tabs.find((tab) => tab.id === 1);
    const keeper = state.tabs.find((tab) => tab.id === 2);
    if (change === 'close') await api.tabs.remove(2);
    else await send('saveForLater', { id: 2 });
    const next = await send('closeDuplicateTabs', {
      scope: { kind: 'window' },
      targets: [captureTarget(target)],
      keepers: [captureTarget(keeper)],
    });
    assert.deepEqual(next.batchResult.skipped, [1]);
    assert(next.tabs.some((tab) => tab.id === 1));
  }
});

test('native navigation during keeper validation skips the target', async () => {
  const { api, send } = fixture();
  const state = await send('snapshot');
  const get = api.tabs.get;
  api.tabs.get = async (id) => {
    if (id === 2) await api.tabs.update(1, { url: 'https://example.com/changed' });
    return get(id);
  };
  const next = await send('closeDuplicateTabs', {
    scope: { kind: 'window' },
    targets: [captureTarget(state.tabs[0])],
    keepers: [captureTarget(state.tabs[1])],
  });
  assert.deepEqual(next.batchResult.skipped, [1]);
});

test('indexed keepers retain Reader View identity and container boundaries', async (t) => {
  const { api, send, controller } = fixture();
  t.after(() => controller.dispose());
  await api.tabs.update(2, {
    url: 'about:reader?url=https%3A%2F%2Fexample.com%2Fsame',
  });
  await api.tabs.update(3, {
    url: 'https://example.com/same',
    cookieStoreId: 'firefox-container-1',
  });
  const before = await send('snapshot');
  const get = api.tabs.get;
  const reads = [];
  api.tabs.get = (...args) => {
    reads.push(args[0]);
    return get(...args);
  };
  const after = await send('closeDuplicateTabs', {
    scope: { kind: 'window' },
    targets: [captureTarget(before.tabs.find((tab) => tab.id === 1))],
    keepers: [3, 2].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id))),
  });
  assert.deepEqual(after.batchResult.completed, [1]);
  assert(!reads.includes(3), 'An unrelated container must not be read as a possible keeper');
  assert(reads.filter((id) => id === 2).length >= 2, 'Matching keeper must be revalidated');
  assert(after.tabs.some((tab) => tab.id === 2));
  assert(after.tabs.some((tab) => tab.id === 3));
});

for (const change of ['navigate', 'close', 'attach', 'read-failure']) {
  test(`indexed keepers are checked again before closing (${change})`, async (t) => {
    const { api, send, controller } = fixture();
    t.after(() => controller.dispose());
    const before = await send('snapshot');
    const get = api.tabs.get;
    let reads = 0;
    api.tabs.get = async (id) => {
      if (id === 2 && ++reads === 2) {
        if (change === 'navigate') await api.tabs.update(2, { url: 'https://example.com/changed' });
        else if (change === 'close') await api.tabs.remove(2);
        else if (change === 'attach') await api.testing.attach(2, 2);
        else throw new Error('Keeper lookup failed');
      }
      return get(id);
    };
    const after = await send('closeDuplicateTabs', {
      scope: { kind: 'window' },
      targets: [captureTarget(before.tabs.find((tab) => tab.id === 1))],
      keepers: [captureTarget(before.tabs.find((tab) => tab.id === 2))],
    });
    assert.deepEqual(after.batchResult.completed, []);
    assert(after.tabs.some((tab) => tab.id === 1));
    if (change === 'read-failure')
      assert.deepEqual(
        after.batchResult.failed.map(({ id }) => id),
        [1],
      );
    else assert.deepEqual(after.batchResult.skipped, [1]);
  });
}

test('indexed keepers try remaining reviewed matches and never select a closing copy', async (t) => {
  const { api, send, controller } = fixture();
  t.after(() => controller.dispose());
  await api.tabs.update(3, { url: 'https://example.com/same' });
  const before = await send('snapshot');
  await api.tabs.update(2, { url: 'https://example.com/changed' });
  const after = await send('closeDuplicateTabs', {
    scope: { kind: 'window' },
    targets: [captureTarget(before.tabs.find((tab) => tab.id === 1))],
    keepers: [1, 2, 3].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id))),
  });
  assert.deepEqual(after.batchResult.completed, [1]);
  assert(after.tabs.some((tab) => tab.id === 3));
});

test('duplicate cleanup retries partial failure after restart with fresh keeper checks', async (t) => {
  const { api, send, controller } = fixture();
  await api.tabs.update(3, { url: 'https://example.com/same' });
  const before = await send('snapshot');
  const targets = [1, 3].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id)));
  const keepers = [captureTarget(before.tabs.find((tab) => tab.id === 2))];
  const remove = api.tabs.remove;
  api.tabs.remove = async (id) => {
    if (id === 3) throw new Error('Native close failed');
    return remove(id);
  };
  const partial = await send('closeDuplicateTabs', { scope: { kind: 'window' }, targets, keepers });
  assert.deepEqual(partial.batchResult.completed, [1]);
  assert.deepEqual(
    partial.batchResult.failed.map(({ id }) => id),
    [3],
  );
  await controller.dispose();
  api.tabs.remove = remove;
  const restarted = createController(api);
  t.after(() => restarted.dispose());
  const retried = await restarted.request({
    type: 'closeDuplicateTabs',
    windowId: 1,
    scope: { kind: 'window' },
    targets,
    keepers,
  });
  assert.deepEqual(retried.batchResult.completed, [3]);
  assert.deepEqual(retried.batchResult.skipped, [1]);
  assert.deepEqual(retried.batchResult.failed, []);
  assert.deepEqual(retried.groups, before.groups);
  assert.equal(retried.tabs.find((tab) => tab.id === 2).treeId, keepers[0].treeId);
  assert.equal((await api.tabs.get(5)).windowId, 2);
});

test('a title change that leaves the domain query is skipped', async () => {
  const { api, send } = fixture();
  const state = await send('snapshot');
  await api.tabs.update(1, { title: 'Renamed' });
  const next = await send('closeTabSet', {
    scope: { kind: 'domain', domain: 'example.com', query: 'Page 1' },
    targets: [captureTarget(state.tabs[0])],
  });
  assert.deepEqual(next.batchResult.skipped, [1]);
});

test('folder collections include descendant pins and saved items in a deterministic order', async () => {
  const { api, send } = fixture();
  await api.tabs.update(2, { pinned: true });
  const state = await send('saveForLater', { id: 4 });
  assert.deepEqual(
    folderCollection(state, 'work').map((tab) => tab.id),
    [2, 3, 1, 4],
  );
  assert.deepEqual(
    folderCollection(state, 'child').map((tab) => tab.id),
    [3],
  );
});

test('folder collection and saved search do linear folder reads and preserve scope boundaries', () => {
  let reads = 0;
  const groups = Array.from({ length: 1000 }, (_, i) => ({
    id: `g${i}`,
    name: `Group ${i}`,
    parentId: i % 10 ? `g${i - (i % 10)}` : null,
  }));
  const state = {
    groups: new Proxy(groups, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
    tabs: groups.map((group, i) => ({
      id: i + 1,
      index: i,
      groupId: group.id,
      title: `Needle ${i}`,
      savedForLaterAt: i % 2 ? 1000 - i : null,
    })),
    view: { scopeId: 'g990', collapsed: [] },
  };
  assert.deepEqual(
    folderCollection(state, 'g990').map((tab) => tab.id),
    [993, 995, 997, 999, 991, 992, 994, 996, 998, 1000],
  );
  assert(reads <= groups.length * 5, `Expected linear folder reads, got ${reads}`);
  reads = 0;
  assert.deepEqual(
    savedSearchResults(state, 'Needle').map((tab) => tab.id),
    [992, 994, 996, 998, 1000],
  );
  assert(reads <= groups.length * 3, `Expected linear folder reads, got ${reads}`);

  const folders = createFolderIndex(state);
  for (const scopeId of [null, 'g0', 'g990', 'g999', 'missing']) {
    const scope = { kind: 'folder', id: scopeId };
    for (const tab of [...state.tabs, { groupId: null }, { groupId: 'missing' }])
      assert.equal(
        inCollection(state, tab, scope, folders),
        isWithin({ groups }, tab.groupId, scopeId),
      );
  }
  reads = 0;
  assert.equal(savedSearchResults(state, 'Needle', null).length, 500);
  assert.deepEqual(savedSearchResults(state, '   '), []);
  assert.equal(reads, 0, 'Root and empty searches do not need a folder index');

  groups[999].parentId = 'g0';
  assert.deepEqual(
    savedSearchResults(state, 'Needle').map((tab) => tab.id),
    [992, 994, 996, 998],
  );
  assert(!folderCollection(state, 'g990').some((tab) => tab.id === 1000));
  state.groups = groups.filter((group) => group.id !== 'g990');
  assert.deepEqual(savedSearchResults(state, 'Needle'), []);
  assert.deepEqual(folderCollection(state, 'g990'), []);
});

test('folder batches rebuild scope after a folder move and revalidate duplicate keepers', async (t) => {
  const { send, controller } = fixture();
  t.after(() => controller.dispose());
  const before = await send('snapshot');
  const target = captureTarget(before.tabs.find((tab) => tab.id === 3));
  await send('moveGroup', { id: 'child', parentId: null });
  const skipped = await send('saveTabsForLater', {
    scope: { kind: 'folder', id: 'work' },
    targets: [target],
  });
  assert.deepEqual(skipped.batchResult.skipped, [3]);
  assert.equal(skipped.tabs.find((tab) => tab.id === 3).savedForLaterAt, undefined);
  await send('moveGroup', { id: 'child', parentId: 'work' });
  const saved = await send('saveTabsForLater', {
    scope: { kind: 'folder', id: 'work' },
    targets: [target],
  });
  assert.deepEqual(saved.batchResult.completed, [3]);
  const current = await send('moveTab', { id: 2, groupId: 'child' });
  const targets = [captureTarget(current.tabs.find((tab) => tab.id === 1))];
  const keepers = [captureTarget(current.tabs.find((tab) => tab.id === 2))];
  await send('moveGroup', { id: 'child', parentId: null });
  const closed = await send('closeDuplicateTabs', {
    scope: { kind: 'folder', id: 'work' },
    targets,
    keepers,
  });
  assert.deepEqual(closed.batchResult.skipped, [1]);
  assert(closed.tabs.some((tab) => tab.id === 1));
});

test('a failed close after moving windows is failed, not reported as closed', async () => {
  const { api, send } = fixture();
  const state = await send('snapshot');
  api.tabs.remove = async (id) => {
    await api.testing.attach(id, 2);
    throw new Error('Moved during close');
  };
  const next = await send('closeTabSet', {
    scope: { kind: 'window' },
    targets: [captureTarget(state.tabs[0])],
  });
  assert.deepEqual(next.batchResult.completed, []);
  assert.deepEqual(
    next.batchResult.failed.map(({ id }) => id),
    [1],
  );
  assert.equal((await api.tabs.get(1)).windowId, 2);
});

test('a browser error after confirmed removal still reports the completed close', async () => {
  const { api, send } = fixture();
  const state = await send('snapshot');
  const remove = api.tabs.remove;
  api.tabs.remove = async (id) => {
    await remove(id);
    throw new Error('Post-close failure');
  };
  const next = await send('closeTabSet', {
    scope: { kind: 'window' },
    targets: [captureTarget(state.tabs[0])],
  });
  assert.deepEqual(next.batchResult.completed, [1]);
  assert.deepEqual(next.batchResult.failed, []);
});

for (const kind of ['window', 'folder']) {
  test(`a partially closed batch can be retried after restart without losing surviving placement (${kind} scope)`, async (t) => {
    const { api, send, controller } = fixture();
    const before = await send('snapshot');
    const targets = [1, 2, 3].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id)));
    const remove = api.tabs.remove;
    api.tabs.remove = async (id) => {
      if (id === 2) throw new Error('Native removal failed');
      await remove(id);
      if (id === 1) throw new Error('Response lost after removal');
    };
    const partial = await send('closeTabSet', { scope: { kind, id: 'work' }, targets });
    assert.deepEqual(partial.batchResult.completed, [1, 3]);
    assert.deepEqual(
      partial.batchResult.failed.map(({ id }) => id),
      [2],
    );
    assert.deepEqual(partial.groups, before.groups);
    assert.equal(partial.tabs.find((tab) => tab.id === 2).groupId, 'work');
    assert.equal((await api.tabs.get(5)).windowId, 2);
    await controller.dispose();
    api.tabs.remove = remove;
    const restarted = createController(api);
    t.after(() => restarted.dispose());
    const retried = await restarted.request({
      type: 'closeTabSet',
      windowId: 1,
      scope: { kind, id: 'work' },
      targets,
    });
    assert.deepEqual(retried.batchResult.completed, [2]);
    assert.deepEqual(retried.batchResult.skipped, [1, 3]);
    assert.deepEqual(retried.batchResult.failed, []);
    assert.deepEqual(retried.groups, before.groups);
    assert.equal((await api.tabs.get(5)).windowId, 2);
  });
}

for (const failQuery of [false, true]) {
  test(`a failed live close lookup preserves the target (fallback query fails: ${failQuery})`, async (t) => {
    const { api, send, controller } = fixture();
    t.after(() => controller.dispose());
    const before = await send('snapshot');
    const targets = [1, 2, 3].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id)));
    const get = api.tabs.get;
    const query = api.tabs.query;
    let reads = 0;
    let rejectQuery = false;
    api.tabs.get = async (id) => {
      if (id === 2 && ++reads === 3) {
        rejectQuery = failQuery;
        throw new Error('Native lookup failed');
      }
      return get(id);
    };
    api.tabs.query = async (...args) => {
      if (rejectQuery) {
        rejectQuery = false;
        throw new Error('Native query failed');
      }
      return query(...args);
    };
    const after = await send('closeTabSet', { scope: { kind: 'window' }, targets });
    assert.deepEqual(after.batchResult.completed, [1, 3]);
    assert.deepEqual(
      after.batchResult.failed.map(({ id }) => id),
      [2],
    );
    assert.deepEqual(after.batchResult.skipped, []);
    assert.equal(after.tabs.find((tab) => tab.id === 2).treeId, 'tree-2');
    assert.equal(after.tabs.find((tab) => tab.id === 2).groupId, 'work');
    assert.equal((await api.tabs.get(5)).windowId, 2);
  });
}

test('Later searches are revalidated before batch writes', async () => {
  const { api, send } = fixture();
  await api.tabs.update(1, { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  const state = await send('saveForLater', { id: 1 });
  const next = await send('closeDuplicateTabs', {
    scope: { kind: 'later', query: 'no matching title' },
    targets: [captureTarget(state.tabs[0])],
    keepers: [],
  });
  assert.deepEqual(next.batchResult.skipped, [1]);
});
