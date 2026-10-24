import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, TAB_KEY, VIEW_KEY } from '../extension/src/model.js';
import { createTreeIndex } from '../extension/src/tree/index.js';
import { listDomains } from '../extension/src/domains.js';
import { searchTabOrder } from '../extension/src/tab-collection.js';

async function fixture(t) {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'later', name: 'Later', parentId: 'work' },
    ],
    tabs: [1, 2, 3, 4].map((id) => ({
      id,
      index: id - 1,
      windowId: id === 4 ? 2 : 1,
      title: `Article ${id}`,
      url: `https://example.test/${id}`,
      pinned: id === 3,
      cookieStoreId: 'firefox-container-1',
    })),
    containers: [{ cookieStoreId: 'firefox-container-1', name: 'Work', colorCode: '#00f' }],
  });
  const model = api.testing.saved[MODEL_KEY];
  model.opaque = { retained: ['unknown', 42] };
  model.newTab = { enabled: true, showLater: true, showFolders: false };
  model.folderPins = [{ id: 'later', action: 'open' }];
  for (const id of [1, 2, 3, 4])
    // Seed raw records: the preview constructor uses the current serializer.
    await api.sessions.setTabValue(id, TAB_KEY, {
      treeId: `article-${id}`,
      groupId: 'later',
      ancestors: id === 2 ? ['article-1'] : [],
      order: id * 1024,
      openedAt: 1700000000000 + id,
      collapsed: id === 1,
      savedForLaterAt: 1700000100000 + id,
      opaque: { retained: id },
    });
  await api.sessions.setWindowValue(1, VIEW_KEY, { scopeId: 'work', collapsed: ['later'] });
  let controller;

  const restart = () => {
    controller?.dispose();
    controller = createController(api);
    api.testing.setCreatedHandler((tab) => controller.created(tab));
  };

  restart();
  t.after(() => controller.dispose());
  return {
    api,
    restart,
    send: (type = 'snapshot', args = {}) => controller.request({ type, windowId: 1, ...args }),
  };
}

test('retired Later markers expose existing tabs, trees, pins and ordinary Later folders without writing', async (t) => {
  const { api, restart, send } = await fixture(t);
  const native = await api.tabs.query({});
  const raw = await Promise.all(native.map((tab) => api.sessions.getTabValue(tab.id, TAB_KEY)));
  const model = structuredClone(api.testing.saved);
  let writes = 0;
  const write = api.sessions.setTabValue;
  api.sessions.setTabValue = (...args) => {
    writes++;
    return write(...args);
  };
  for (let pass = 0; pass < 2; pass++) {
    const state = await send();
    const index = createTreeIndex(state);
    assert.deepEqual(
      index.tabs.map((tab) => tab.id),
      [1, 2],
    );
    assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
    assert(state.pins.some((pin) => pin.kind === 'tab' && pin.id === 'article-3'));
    assert(state.folderPins.some((pin) => pin.id === 'later'));
    assert.equal(index.groupStats.get('later').count, 2);
    assert.equal(listDomains(state.tabs)[0].count, 3);
    assert.deepEqual(searchTabOrder(state, 'Article'), [1, 2]);
    assert.equal(state.view.scopeId, 'work');
    assert.deepEqual(state.view.collapsed, ['later']);
    const second = await send('snapshot', { windowId: 2 });
    assert.deepEqual(
      second.tabs.map((tab) => tab.id),
      [4],
    );
    assert([...state.tabs, ...second.tabs].every((tab) => !Object.hasOwn(tab, 'savedForLaterAt')));
    const settings = await send('getSettings');
    assert.equal(settings.newTab.showFolders, false);
    assert.equal(Object.hasOwn(settings.newTab, 'showLater'), false);
    restart();
  }
  assert.equal(writes, 0);
  assert.deepEqual(await api.tabs.query({}), native);
  assert.deepEqual(
    await Promise.all(native.map((tab) => api.sessions.getTabValue(tab.id, TAB_KEY))),
    raw,
  );
  assert.deepEqual(api.testing.saved, model);
  for (const type of [
    'saveForLater',
    'returnFromLater',
    'saveTabsForLater',
    'undoSaveTabsForLater',
  ])
    await assert.rejects(send(type, { id: 1, targets: [] }), /Unknown Tabernacle action/);
});

test('retired membership cleanup preserves unknown fields across partial saves, write failure, restart and retry', async (t) => {
  const { api, restart, send } = await fixture(t);
  const before = await api.sessions.getTabValue(2, TAB_KEY);
  await send('toggleTab', { id: 1 });
  const first = await api.sessions.getTabValue(1, TAB_KEY);
  assert.equal(Object.hasOwn(first, 'savedForLaterAt'), false);
  assert.deepEqual(first.opaque, { retained: 1 });
  const write = api.sessions.setTabValue;
  api.sessions.setTabValue = async (id, ...args) => {
    if (id === 2) throw new Error('Membership write failed');
    return write(id, ...args);
  };
  await assert.rejects(send('toggleTab', { id: 2 }), /Membership write failed/);
  assert.deepEqual(await api.sessions.getTabValue(2, TAB_KEY), before);
  restart();
  assert.equal((await send()).tabs.find((tab) => tab.id === 2).parentTabId, 1);
  api.sessions.setTabValue = write;
  await send('toggleTab', { id: 2 });
  const { savedForLaterAt, ...expected } = before;
  assert.deepEqual(await api.sessions.getTabValue(2, TAB_KEY), { ...expected, collapsed: true });
  assert.equal((await api.sessions.getTabValue(4, TAB_KEY)).savedForLaterAt, 1700000100004);
  restart();
  const state = await send();
  assert.equal(state.tabs.find((tab) => tab.id === 2).collapsed, true);
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
});

test('failed legacy membership reads never reset records and closed sessions restore into the tree', async (t) => {
  const { api, restart, send } = await fixture(t);
  const before = await api.sessions.getTabValue(1, TAB_KEY);
  const read = api.sessions.getTabValue;
  api.sessions.getTabValue = async (id, key) => {
    if (id === 1) throw new Error('Membership read failed');
    return read(id, key);
  };
  await assert.rejects(send(), /Membership read failed/);
  assert.deepEqual(await read(1, TAB_KEY), before);
  api.sessions.getTabValue = read;
  await api.tabs.remove(1);
  restart();
  assert.equal((await send()).tabs.find((tab) => tab.id === 2).parentTabId, null);
  const state = await send('undoCloseTab');
  const parent = state.tabs.find((tab) => tab.treeId === 'article-1');
  assert.equal(parent.groupId, 'later');
  assert.equal(parent.cookieStoreId, 'firefox-container-1');
  assert.equal(parent.collapsed, true);
  assert.equal(parent.order, before.order);
  assert.equal(Object.hasOwn(parent, 'savedForLaterAt'), false);
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, parent.id);
  const restored = await read(parent.id, TAB_KEY);
  assert.deepEqual(restored.opaque, before.opaque);
  assert.deepEqual(restored.ancestors, before.ancestors);
});
