import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY, TAB_KEY, sortTabs } from '../extension/src/model.js';

async function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'outer', name: 'Outer', parentId: null },
      { id: 'source', name: 'Source', parentId: 'outer' },
      { id: 'child', name: 'Child', parentId: 'source' },
      { id: 'deep', name: 'Deep', parentId: 'child' },
      { id: 'target', name: 'Target', parentId: null },
      { id: 'existing', name: 'Existing', parentId: 'target' },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'Parent', active: true },
      {
        id: 2,
        windowId: 1,
        index: 1,
        title: 'Nested',
        pinned: true,
        cookieStoreId: 'firefox-container-1',
      },
      { id: 3, windowId: 1, index: 2, title: 'Child group' },
      { id: 4, windowId: 2, index: 0, title: 'Deep other window' },
      { id: 5, windowId: 2, index: 1, title: 'Direct other window' },
      { id: 6, windowId: 1, index: 3, title: 'Destination' },
      { id: 7, windowId: 1, index: 4, title: 'Home' },
    ],
    memberships: {
      1: { groupId: 'source', treeId: 'one', ancestors: [], collapsed: true },
      2: { groupId: 'source', treeId: 'two', ancestors: ['one'] },
      3: { groupId: 'child' },
      4: { groupId: 'deep' },
      5: { groupId: 'source' },
      6: { groupId: 'target' },
      7: { groupId: null },
    },
  });
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  await send('snapshot');
  return { api, send, notices, controller };
}

test('deletion counts and closes the whole subtree, including pins and other windows, and persists views', async () => {
  const { api, send, controller } = await fixture();
  await send('enterGroup', { id: 'child' });
  await send('enterGroup', { id: 'deep' }, 2);
  await send('collapseAll', { collapsed: true });
  const contents = await send('getGroupContents', { id: 'source' });
  assert.deepEqual(contents, {
    groupIds: ['source', 'child', 'deep'],
    tabIds: [1, 2, 3, 4, 5],
    pinnedCount: 1,
    windowCount: 2,
  });
  const result = await send('removeGroup', { id: 'source', ...contents });
  assert.deepEqual(
    result.groups.map((g) => g.id),
    ['outer', 'target', 'existing'],
  );
  assert.deepEqual(
    (await api.tabs.query({})).map((tab) => tab.id),
    [6, 7],
  );
  assert.equal(result.view.scopeId, 'outer');
  assert.deepEqual(result.view.collapsed, ['outer', 'target', 'existing']);
  assert.equal((await send('snapshot', {}, 2)).view.scopeId, 'outer');
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual(
    (await restarted.request({ type: 'snapshot', windowId: 1 })).groups,
    result.groups,
  );
  restarted.dispose();
});

test('deletion rejects missing confirmation and newly added contents without closing any tabs', async () => {
  for (const addition of ['tab', 'group']) {
    const { api, send } = await fixture();
    await assert.rejects(send('removeGroup', { id: 'source' }), /Confirm/);
    for (const id of [null, 'missing'])
      await assert.rejects(send('getGroupContents', { id }), /folder/);
    const contents = await send('getGroupContents', { id: 'source' });
    if (addition === 'tab') await send('newTab', { groupId: 'deep' });
    else await send('createGroup', { name: 'New child', parentId: 'child' });
    const before = await api.tabs.query({});
    await assert.rejects(send('removeGroup', { id: 'source', ...contents }), /contents changed/);
    assert.deepEqual(await api.tabs.query({}), before);
    assert((await send('snapshot')).groups.some((g) => g.id === 'source'));
  }
});

test('deletion excludes tabs and subgroups moved out since confirmation', async () => {
  const { api, send } = await fixture();
  const contents = await send('getGroupContents', { id: 'source' });
  await send('moveTab', { id: 1, groupId: 'target' });
  await send('moveGroup', { id: 'child', parentId: 'target' });
  const state = await send('removeGroup', { id: 'source', ...contents });
  assert(state.groups.some((g) => g.id === 'deep'));
  assert.deepEqual(
    (await api.tabs.query({})).map((tab) => tab.id),
    [1, 2, 3, 4, 6, 7],
  );
});

test('a partial or refused close keeps the groups and supports retrying deletion', async () => {
  for (const failure of ['partial', 'refused']) {
    const { api, send } = await fixture();
    const contents = await send('getGroupContents', { id: 'source' });
    const remove = api.tabs.remove;
    api.tabs.remove = async (ids) => {
      if (failure === 'partial') {
        await remove(ids[0]);
        throw new Error('Close failed');
      }
    };
    await assert.rejects(
      send('removeGroup', { id: 'source', ...contents }),
      /Close failed|still open/,
    );
    assert((await send('snapshot')).groups.some((g) => g.id === 'deep'));
    api.tabs.remove = remove;
    await send('removeGroup', { id: 'source', ...contents });
    assert.deepEqual(
      (await api.tabs.query({})).map((tab) => tab.id),
      [6, 7],
    );
  }
});

test('moving contents appends tabs and subgroups, preserving trees, containers, pins, windows and views', async () => {
  const { api, send, notices, controller } = await fixture();
  await send('enterGroup', { id: 'deep' }, 2);
  const before = await api.tabs.query({});
  const deepMembership = await api.sessions.getTabValue(4, TAB_KEY);
  const state = await send('moveGroupContents', { id: 'source', groupId: 'target' });
  assert.deepEqual(await api.tabs.query({}), before);
  assert.deepEqual(await api.sessions.getTabValue(4, TAB_KEY), deepMembership);
  assert.deepEqual(
    state.groups.filter((g) => g.parentId === 'target').map((g) => g.id),
    ['existing', 'child'],
  );
  assert.equal(state.groups.find((g) => g.id === 'deep').parentId, 'child');
  assert(state.groups.some((g) => g.id === 'source'));
  assert(!state.tabs.some((tab) => tab.groupId === 'source'));
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
  assert.equal(state.tabs.find((tab) => tab.id === 1).collapsed, true);
  assert.deepEqual(
    sortTabs(state.tabs.filter((tab) => tab.groupId === 'target')).map((tab) => tab.id),
    [6, 1, 2],
  );
  const other = await send('snapshot', {}, 2);
  assert.equal(other.tabs.find((tab) => tab.id === 5).groupId, 'target');
  assert.equal(other.view.scopeId, 'deep');
  assert.equal(notices.at(-1).windowId, undefined);
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual(
    (await restarted.request({ type: 'snapshot', windowId: 1 })).groups,
    state.groups,
  );
  restarted.dispose();
});

test('contents can move to the parent or Home and invalid destinations change nothing', async () => {
  const { api, send } = await fixture();
  const before = await send('snapshot');
  for (const groupId of ['source', 'child', 'deep', 'missing'])
    await assert.rejects(
      send('moveGroupContents', { id: 'source', groupId }),
      /destination|exists/,
    );
  await assert.rejects(
    send('moveGroupContents', { id: null, groupId: 'target' }),
    /Choose a folder/,
  );
  assert.deepEqual((await send('snapshot')).groups, before.groups);
  assert.equal((await api.sessions.getTabValue(1, TAB_KEY)).groupId, 'source');
  await send('moveGroupContents', { id: 'source', groupId: 'outer' });
  const state = await send('moveGroupContents', { id: 'outer', groupId: null });
  assert.equal(state.groups.find((g) => g.id === 'child').parentId, null);
  assert.equal(state.tabs.find((tab) => tab.id === 1).groupId, null);
});

test('failed content moves restore memberships and preserve the hierarchy', async () => {
  for (const failure of ['membership', 'model']) {
    const { api, send } = await fixture();
    const before = structuredClone(api.testing.saved[MODEL_KEY]);
    const memberships = structuredClone(api.testing.tabValues);
    const setTab = api.sessions.setTabValue;
    const setModel = api.storage.local.set;
    let writes = 0;
    api.sessions.setTabValue = async (...args) => {
      if (failure === 'membership' && ++writes === 2) throw new Error('Session save failed');
      return setTab(...args);
    };
    api.storage.local.set = async (...args) => {
      if (failure === 'model') throw new Error('Model save failed');
      return setModel(...args);
    };
    await assert.rejects(
      send('moveGroupContents', { id: 'source', groupId: 'target' }),
      /save failed/,
    );
    assert.deepEqual(api.testing.saved[MODEL_KEY], before);
    assert.deepEqual(api.testing.tabValues, memberships);
    api.sessions.setTabValue = setTab;
    api.storage.local.set = setModel;
    await send('moveGroupContents', { id: 'source', groupId: 'target' });
    assert.equal((await api.sessions.getTabValue(1, TAB_KEY)).groupId, 'target');
  }
});
