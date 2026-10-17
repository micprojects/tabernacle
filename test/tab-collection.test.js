import test from 'node:test';
import assert from 'node:assert/strict';
import {
  savedSearchResults,
  folderCollection,
  searchTabOrder,
  sourceUrl,
  captureTarget,
  duplicateGroups,
  suggestedDuplicates,
  viewedAge,
} from '../extension/src/tab-collection.js';
import { createTreeIndex } from '../extension/src/tree-index.js';
import { domainResults } from '../extension/src/domain-filter.js';
import { listDomains } from '../extension/src/domains.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { closeFallback } from '../extension/src/close-selection.js';

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
  return { api, send };
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

test('batch reports partial failure and undo covers only saved members', async () => {
  const { api, send } = fixture();
  const before = await send('snapshot');
  const write = api.sessions.setTabValue;
  api.sessions.setTabValue = async (id, ...args) => {
    if (id === 2) throw new Error('Disk full');
    return write(id, ...args);
  };
  const result = await send('saveTabsForLater', {
    scope: { kind: 'window' },
    targets: before.tabs.map(captureTarget),
  });
  assert.deepEqual(result.batchResult.completed, [1, 3, 4]);
  assert.equal(result.batchResult.failed[0].id, 2);
  assert.equal(result.batchResult.undo.length, 3);
  assert.equal(result.tabs.find((tab) => tab.id === 2).savedForLaterAt, undefined);
});

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

test('YouTube duplicate batches retain their full reviewed set while excluding changed companions', async () => {
  for (const changed of [false, true]) {
    const { api, send } = fixture();
    for (const id of [1, 2])
      await api.tabs.update(id, { url: `https://www.youtube.com/watch?v=jNQXAC9IVRw&t=${id}` });
    const state = await send('snapshot');
    if (changed) await api.tabs.remove(2);
    const next = await send('saveTabsForLater', {
      scope: { kind: 'domain', domain: 'youtube.com', youtubeFilter: 'duplicates' },
      targets: state.tabs.filter((tab) => tab.id <= 2).map(captureTarget),
    });
    assert.deepEqual(next.batchResult.completed, changed ? [] : [1, 2]);
    assert.deepEqual(next.batchResult.skipped, changed ? [1, 2] : []);
  }
});

test('YouTube progress and Later filters are revalidated without reading pages', async () => {
  const { api, send } = fixture();
  await api.tabs.update(1, { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  let state = await send('snapshot');
  const request = {
    scope: { kind: 'domain', domain: 'youtube.com', youtubeFilter: 'progress' },
    targets: [captureTarget(state.tabs[0])],
  };
  let next = await send('saveTabsForLater', request);
  assert.deepEqual(next.batchResult.skipped, [1]);
  const getValue = api.sessions.getTabValue;
  const observation = {
    treeId: state.tabs[0].treeId,
    videoId: 'jNQXAC9IVRw',
    duration: 20,
    position: 10,
  };
  api.sessions.getTabValue = (id, key) =>
    key === 'tabernacle.youtube.v1'
      ? Promise.resolve(id === 1 ? observation : undefined)
      : getValue(id, key);
  next = await send('saveTabsForLater', request);
  assert.deepEqual(next.batchResult.completed, [1]);
  state = next;
  next = await send('closeDuplicateTabs', {
    scope: { kind: 'later', category: 'articles' },
    targets: [captureTarget(state.tabs[0])],
    keepers: [],
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
