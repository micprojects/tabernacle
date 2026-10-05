import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { createTreeIndex, scopeBranches } from '../extension/src/tree-index.js';
import { VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

async function fixture() {
  const groups = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'design', name: 'Design', parentId: 'work' },
    { id: 'personal', name: 'Personal', parentId: null },
  ];
  const entries = [
    [1, 'work', []],
    [2, 'work', [1]],
    [3, 'work', [2, 1]],
    [4, 'design', []],
    [5, 'design', [4]],
    [6, 'personal', []],
    [7, 'personal', [6]],
    [8, null, []],
    [9, null, [8]],
    [10, 'work', []],
    [11, 'work', [10]],
    [12, 'work', [11, 10]],
    [13, 'work', []],
    [14, 'work', [13]],
  ];
  const api = memoryBrowser({
    groups,
    tabs: entries.map(([id], index) => ({
      id,
      index,
      windowId: id >= 13 ? 2 : 1,
      title: `Tab ${id}`,
      active: id === 3,
      pinned: id === 10,
    })),
    memberships: Object.fromEntries(
      entries.map(([id, groupId, ancestors]) => [
        id,
        { groupId, treeId: `t${id}`, ancestors: ancestors.map((id) => `t${id}`) },
      ]),
    ),
  });
  await api.sessions.setWindowValue(1, VIEW_KEY, {
    scopeId: 'work',
    collapsed: ['work', 'personal'],
  });
  const controller = createController(api);
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  return { api, controller, send };
}

test('bulk folding includes nested groups and tab trees only within the requested view and window', async () => {
  const { api, send } = await fixture();
  const before = await send('snapshot');
  const other = await send('snapshot', {}, 2);
  const state = await send('collapseTree', { scopeId: 'work', collapsed: true });
  assert.equal(state.view.scopeId, 'work');
  assert.deepEqual(state.view.collapsed, ['work', 'personal', 'design']);
  assert.deepEqual(
    state.tabs.filter((tab) => tab.collapsed).map((tab) => tab.id),
    [1, 2, 4, 11],
  );
  assert.equal(state.tabs.find((tab) => tab.id === 3).active, true);
  assert.equal(state.tabs.find((tab) => tab.id === 10).pinned, true);
  assert.deepEqual((await send('snapshot', {}, 2)).tabs, other.tabs);

  const restarted = createController(api);
  const saved = await restarted.request({ type: 'snapshot', windowId: 1 });
  assert.deepEqual(saved.tabs, state.tabs);
  assert.deepEqual(saved.view, state.view);
  const expanded = await send('collapseTree', { scopeId: 'work', collapsed: false });
  assert.deepEqual(expanded.tabs, before.tabs);
  assert.deepEqual(expanded.view, before.view);
});

test('Home folding includes ungrouped trees and expansion opens all hidden descendants', async () => {
  const { send } = await fixture();
  const folded = await send('collapseTree', { scopeId: null, collapsed: true });
  assert.equal(folded.tabs.find((tab) => tab.id === 8).collapsed, true);
  assert.equal(folded.tabs.find((tab) => tab.id === 6).collapsed, true);
  assert.equal(folded.view.collapsed.length, folded.groups.length);
  const expanded = await send('collapseTree', { scopeId: null, collapsed: false });
  assert.deepEqual(expanded.view.collapsed, []);
  assert(expanded.tabs.every((tab) => !tab.collapsed));
});

test('the next action follows visible roots, including mixed states and children of pinned tabs', async () => {
  const { send } = await fixture();
  let state = await send('snapshot');
  const branches = (scopeId) => scopeBranches(createTreeIndex(state), { ...state.view, scopeId });
  assert.equal(branches('work').expanded, true);
  await send('toggleGroup', { id: 'design' });
  await send('toggleTab', { id: 1 });
  state = await send('toggleTab', { id: 11 });
  // Tab 2 remains open underneath collapsed tab 1; it should not force another collapse.
  assert.equal(branches('work').expanded, false);
  state = await send('toggleTab', { id: 11 });
  assert.equal(branches('work').expanded, true);
  assert.deepEqual([...branches('design').groupIds], []);
  assert.deepEqual(
    branches('design').tabs.map((tab) => tab.id),
    [4],
  );
});

test('flat tabs and pinned-only children offer no folding action; empty groups can still fold', () => {
  const state = {
    groups: [],
    tabs: [
      { id: 1, groupId: null, parentTabId: null },
      { id: 2, groupId: null, parentTabId: 1, pinned: true },
    ],
    view: { scopeId: null, collapsed: [] },
  };
  let branches = scopeBranches(createTreeIndex(state), state.view);
  assert.equal(branches.tabs.length + branches.groupIds.size, 0);
  state.groups.push({ id: 'empty', name: 'Empty', parentId: null });
  branches = scopeBranches(createTreeIndex(state), state.view);
  assert.equal(branches.groupIds.size, 1);
  assert.equal(branches.expanded, true);
});

test('invalid bulk requests fail without changing saved state', async () => {
  const { send } = await fixture();
  const before = await send('snapshot');
  await assert.rejects(send('collapseTree', { scopeId: 'missing', collapsed: true }), /folder/);
  await assert.rejects(send('collapseTree', { scopeId: 'work' }), /tree state/);
  assert.deepEqual(await send('snapshot'), before);
});

test('failed bulk writes settle before retrying and do not lose tab ancestry', async () => {
  const { api, send } = await fixture();
  const before = await send('snapshot');
  const save = api.sessions.setTabValue;
  let pending = 0;
  api.sessions.setTabValue = async (id, ...args) => {
    if (id === 2) throw new Error('Cannot save tree');
    pending++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await save(id, ...args);
    pending--;
  };
  await assert.rejects(send('collapseTree', { scopeId: 'work', collapsed: true }), /Cannot save/);
  assert.equal(pending, 0);
  assert.deepEqual((await send('snapshot')).view, before.view);
  api.sessions.setTabValue = save;
  await send('collapseTree', { scopeId: 'work', collapsed: true });
  const expanded = await send('collapseTree', { scopeId: 'work', collapsed: false });
  assert.deepEqual(expanded.tabs, before.tabs);
});
