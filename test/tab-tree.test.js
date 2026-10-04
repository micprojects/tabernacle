import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { TAB_KEY, tabSubtree, unpinnedTabTree, sortTabs } from '../extension/src/model.js';

function fixture() {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'later', name: 'Later', parentId: null },
    ],
    tabs: [
      { id: 1, index: 0, windowId: 1, title: 'Parent', active: true },
      { id: 2, index: 1, windowId: 1, title: 'Child' },
      { id: 3, index: 2, windowId: 1, title: 'Grandchild' },
      { id: 4, index: 3, windowId: 1, title: 'Other group' },
      { id: 5, index: 0, windowId: 2, title: 'Other window' },
    ],
    memberships: {
      1: { groupId: 'work' },
      2: { groupId: 'work' },
      3: { groupId: 'work' },
      4: { groupId: 'later' },
      5: { groupId: 'work' },
    },
  });
  let controller;

  const restart = () => {
    controller = createController(api);
    api.testing.setCreatedHandler((tab) => {
      controller.created(tab).catch(() => {});
    });
  };

  restart();
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });

  const tree = async () => {
    await send('nestTab', { id: 2, parentTabId: 1 });
    return send('nestTab', { id: 3, parentTabId: 2 });
  };

  return { api, send, tree, restart, created: (tab) => controller.created(tab) };
}

const get = (state, id) => state.tabs.find((tab) => tab.id === id);

test('row clicks activate inactive parents without changing children, then toggle only that branch', async () => {
  for (const collapsed of [false, true]) {
    const { send, tree } = fixture();
    await tree();
    if (collapsed) await send('toggleTab', { id: 2 });
    const before = await send('snapshot');
    const activated = await send('clickTab', { id: 2 });
    assert.equal(get(activated, 2).active, true);
    assert.deepEqual(
      activated.tabs.map((tab) => tab.collapsed),
      before.tabs.map((tab) => tab.collapsed),
    );
    const toggled = await send('clickTab', { id: 2 });
    assert.equal(get(toggled, 2).collapsed, !collapsed);
    assert.equal(get(toggled, 1).collapsed, get(before, 1).collapsed);
    assert.equal(get(toggled, 3).collapsed, get(before, 3).collapsed);
    assert.equal(get(await send('clickTab', { id: 2 }), 2).collapsed, collapsed);
  }
});

test('returning to an unfocused window activates without folding, including focus delivered before the click', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await api.windows.update(1, { focused: false });
  const activated = await send('clickTab', { id: 1 });
  assert.equal(get(activated, 1).collapsed, false);
  assert.equal((await api.windows.get(1)).focused, true);
  const guarded = await send('clickTab', { id: 1, toggleChildren: false });
  assert.equal(get(guarded, 1).collapsed, false);
  const toggled = await send('clickTab', { id: 1 });
  assert.equal(get(toggled, 1).collapsed, true);
});

test('disclosure clicks activate the parent, focus its window and toggle its children in one action', async () => {
  const { api, send, tree } = fixture();
  await tree();
  for (const collapsed of [true, false]) {
    await send('activateTab', { id: 4 });
    await api.windows.update(1, { focused: false });
    const state = await send('toggleTab', { id: 1, activate: true });
    assert.equal(get(state, 1).active, true);
    assert.equal(get(state, 1).collapsed, collapsed);
    assert.equal(get(state, 2).collapsed, false);
    assert.equal((await api.windows.get(1)).focused, true);
  }
});

test('leaf and pinned clicks do not fold trees; keyboard activation stays separate from folding', async () => {
  const { send, tree } = fixture();
  await tree();
  await send('clickTab', { id: 3 });
  assert.equal(get(await send('clickTab', { id: 3 }), 3).collapsed, false);
  await send('toggleTab', { id: 1 });
  assert.equal(get(await send('activateTab', { id: 1 }), 1).collapsed, true);
  assert.equal(get(await send('activateTab', { id: 1 }), 1).collapsed, true);
  await send('pinTab', { id: 1 });
  assert.equal(get(await send('clickTab', { id: 1 }), 1).collapsed, true);
  await assert.rejects(send('clickTab', { id: 5 }), /another window/);
});

test('pinning a parent exposes its children without rewriting the saved tab tree', async () => {
  const { send, tree } = fixture();
  await tree();
  await send('toggleTab', { id: 1 });
  const pinned = await send('pinTab', { id: 1 });
  const visible = unpinnedTabTree(pinned.tabs);
  assert(!visible.some((tab) => tab.id === 1));
  assert.equal(visible.find((tab) => tab.id === 2).parentTabId, null);
  assert.equal(visible.find((tab) => tab.id === 3).parentTabId, 2);
  assert.equal(get(pinned, 2).parentTabId, 1);
  const restored = unpinnedTabTree((await send('pinTab', { id: 1 })).tabs);
  assert.equal(restored.find((tab) => tab.id === 2).parentTabId, 1);
  assert.equal(restored.find((tab) => tab.id === 1).collapsed, true);
});

test('pinned tabs at multiple depths never hide or duplicate unpinned descendants', async () => {
  const { send, tree } = fixture();
  await tree();
  await send('pinTab', { id: 1 });
  const state = await send('pinTab', { id: 2 });
  const visible = unpinnedTabTree(state.tabs);
  assert.equal(visible.find((tab) => tab.id === 3).parentTabId, null);
  assert.deepEqual(
    visible.map((tab) => tab.id),
    [3, 4],
  );
  assert.deepEqual(
    tabSubtree(state.tabs, 1).map((tab) => tab.id),
    [1, 2, 3],
  );
});

test('legacy group assignments gain durable identities without changing existing organisation', async () => {
  const { send, restart } = fixture();
  const initial = await send('snapshot');
  assert.deepEqual(
    initial.tabs.map((tab) => tab.groupId),
    ['work', 'work', 'work', 'later'],
  );
  assert(initial.tabs.every((tab) => tab.parentTabId === null));
  assert.equal(new Set(initial.tabs.map((tab) => tab.treeId)).size, 4);
  restart();
  assert.deepEqual(
    (await send('snapshot')).tabs.map((tab) => tab.treeId),
    initial.tabs.map((tab) => tab.treeId),
  );
});

test('links nest under their opener at any depth while blank tabs follow the group scope', async () => {
  const { api, send } = fixture();
  await send('enterGroup', { id: 'later' });
  const child = await api.tabs.create({ windowId: 1, openerTabId: 1 });
  const grandchild = await api.tabs.create({ windowId: 1, openerTabId: child.id });
  const blank = await api.tabs.create({ windowId: 1 });
  const state = await send('snapshot');
  assert.equal(get(state, child.id).parentTabId, 1);
  assert.equal(get(state, grandchild.id).parentTabId, child.id);
  assert.equal(get(state, grandchild.id).groupId, 'work');
  assert.equal(get(state, blank.id).parentTabId, null);
  assert.equal(get(state, blank.id).groupId, 'later');
});

test('links from pinned tabs append as roots in Home or the entered folder and keep that placement', async () => {
  for (const scopeId of [null, 'later', 'work']) {
    const { api, send, restart } = fixture();
    await send('pinTab', { id: 1 });
    await send('enterGroup', { id: scopeId });
    await send('newTab', { groupId: scopeId });
    const before = await send('snapshot');
    const roots = sortTabs(
      unpinnedTabTree(before.tabs).filter(
        (tab) => tab.groupId === scopeId && tab.parentTabId === null,
      ),
    ).map((tab) => tab.id);
    const first = await api.tabs.create({ windowId: 1, openerTabId: 1, index: 1, active: false });
    const second = await api.tabs.create({ windowId: 1, openerTabId: 1, index: 1, active: true });
    let state = await send('snapshot');
    for (const tab of [first, second]) {
      assert.equal(get(state, tab.id).groupId, scopeId);
      assert.equal(get(state, tab.id).parentTabId, null);
      assert.deepEqual(get(state, tab.id).ancestors, []);
    }
    assert.deepEqual(
      sortTabs(
        unpinnedTabTree(state.tabs).filter(
          (tab) => tab.groupId === scopeId && tab.parentTabId === null,
        ),
      ).map((tab) => tab.id),
      [...roots, first.id, second.id],
    );
    assert.deepEqual(get(state, 1), get(before, 1));
    await send('pinTab', { id: 1 });
    restart();
    state = await send('snapshot');
    assert.equal(get(state, first.id).parentTabId, null);
    assert.equal(get(state, first.id).groupId, scopeId);
  }
});

test('pinned links append after existing children promoted into the visible root list', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await send('newChildTab', { id: 1 });
  await send('newChildTab', { id: 1 });
  await send('pinTab', { id: 1 });
  await send('enterGroup', { id: 'work' });
  const before = await send('snapshot');
  const visibleRoots = (state) =>
    sortTabs(
      unpinnedTabTree(state.tabs).filter(
        (tab) => tab.groupId === 'work' && tab.parentTabId === null,
      ),
    ).map((tab) => tab.id);
  const tab = await api.tabs.create({ windowId: 1, openerTabId: 1, index: 1 });
  const state = await send('snapshot');
  assert.equal(get(state, tab.id).parentTabId, null);
  assert.deepEqual(visibleRoots(state), [...visibleRoots(before), tab.id]);
  for (const existing of before.tabs) assert.deepEqual(get(state, existing.id), existing);
});

test('pinned links use their own window scope even when a snapshot precedes the creation handler', async () => {
  const { api, send, created } = fixture();
  await send('pinTab', { id: 1 });
  await send('pinTab', { id: 5 }, 2);
  await send('enterGroup', { id: 'later' });
  await send('enterGroup', { id: null }, 2);
  api.testing.setCreatedHandler(() => {});
  for (const [windowId, openerTabId, groupId] of [
    [1, 1, 'later'],
    [2, 5, null],
  ]) {
    const tab = await api.tabs.create({ windowId, openerTabId, index: 1 });
    await send('snapshot', {}, windowId);
    await created(tab);
    const state = await send('snapshot', {}, windowId);
    assert.equal(get(state, tab.id).groupId, groupId);
    assert.equal(get(state, tab.id).parentTabId, null);
  }
});

test('a snapshot racing before onCreated does not suppress automatic nesting', async () => {
  const { api, send, created } = fixture();
  api.testing.setCreatedHandler(() => {});
  const child = await api.tabs.create({ windowId: 1, openerTabId: 1 });
  await send('snapshot');
  await created(child);
  assert.equal(get(await send('snapshot'), child.id).parentTabId, 1);
});

test('missing or cross-window openers do not create invisible parent relationships', async () => {
  const { api, send } = fixture();
  await send('enterGroup', { id: 'later' });
  const missing = await api.tabs.create({ windowId: 1, openerTabId: 999 });
  const other = await api.tabs.create({ windowId: 1, openerTabId: 5 });
  const state = await send('snapshot');
  for (const tab of [missing, other]) {
    assert.equal(get(state, tab.id).parentTabId, null);
    assert.equal(get(state, tab.id).groupId, 'later');
  }
});

test('moving a parent to a group carries the entire tree and preserves nesting', async () => {
  const { send, tree } = fixture();
  const original = await tree();
  const moved = await send('moveTab', { id: 1, groupId: 'later', beforeId: 4 });
  assert.deepEqual(
    tabSubtree(moved.tabs, 1).map((tab) => tab.id),
    [1, 2, 3],
  );
  assert(tabSubtree(moved.tabs, 1).every((tab) => tab.groupId === 'later'));
  assert.equal(get(moved, 2).treeId, get(original, 2).treeId);
  assert.deepEqual(
    sortTabs(moved.tabs.filter((tab) => tab.groupId === 'later' && tab.parentTabId === null)).map(
      (tab) => tab.id,
    ),
    [1, 4],
  );
});

test('root reordering can target children exposed beneath a pinned parent', async () => {
  const { send, tree, restart } = fixture();
  await tree();
  await send('pinTab', { id: 1 });
  const state = await send('moveTab', { id: 4, groupId: 'work', beforeId: 2 });
  assert.equal(get(state, 4).parentTabId, null);
  assert.deepEqual(
    sortTabs(unpinnedTabTree(state.tabs)).map((tab) => tab.id),
    [4, 2, 3],
  );
  restart();
  const unpinned = await send('pinTab', { id: 1 });
  assert.equal(get(unpinned, 4).parentTabId, null);
  assert.equal(get(unpinned, 2).parentTabId, 1);
});

test('a failed subtree move restores its memberships so retry still moves every descendant', async () => {
  // Fail each member save, including expansion of the destination parent.
  for (const failureAt of [1, 2, 3, 4]) {
    const { api, send, tree, restart } = fixture();
    await tree();
    await send('toggleTab', { id: 4 });
    const before = structuredClone(api.testing.tabValues);
    const save = api.sessions.setTabValue;
    let writes = 0;
    api.sessions.setTabValue = async (...args) => {
      if (++writes === failureAt) throw new Error('Session save failed');
      return save(...args);
    };
    await assert.rejects(send('nestTab', { id: 1, parentTabId: 4 }), /Session save failed/);
    assert.deepEqual(api.testing.tabValues, before);
    api.sessions.setTabValue = save;
    restart();
    const state = await send('nestTab', { id: 1, parentTabId: 4 });
    assert.deepEqual(
      tabSubtree(state.tabs, 1).map((tab) => tab.id),
      [1, 2, 3],
    );
    assert([1, 2, 3].every((id) => get(state, id).groupId === 'later'));
    assert.equal(get(state, 1).parentTabId, 4);
    assert.equal(get(state, 4).collapsed, false);
  }
});

test('failed ancestor expansion settles its writes before the next tree action', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await send('collapseTree', { scopeId: 'work', collapsed: true });
  const save = api.sessions.setTabValue;
  let release,
    started,
    writes = 0,
    settled = false;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  api.sessions.setTabValue = async (...args) => {
    const call = ++writes;
    if (call === 2) throw new Error('Expansion failed');
    if (call === 1) {
      started();
      await held;
    }
    return save(...args);
  };
  const failed = assert.rejects(send('activateTab', { id: 3 }), /Expansion failed/).then(() => {
    settled = true;
  });
  await pending;
  const next = send('collapseTree', { scopeId: 'work', collapsed: true });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false, 'A late expansion must not overwrite the next collapse');
  } finally {
    release();
  }
  await failed;
  const state = await next;
  assert.equal(get(state, 1).collapsed, true);
  assert.equal(get(state, 2).collapsed, true);
});

test('nesting under a tab in another group moves the subtree without creating groups', async () => {
  const { send, tree } = fixture();
  await tree();
  const state = await send('nestTab', { id: 1, parentTabId: 4 });
  assert.deepEqual(
    tabSubtree(state.tabs, 4).map((tab) => tab.id),
    [4, 1, 2, 3],
  );
  assert(state.tabs.every((tab) => tab.groupId === 'later'));
  assert.equal(state.groups.length, 2);
});

test('detaching a child carries its children and survives refresh without reattaching', async () => {
  const { send, tree, restart } = fixture();
  await tree();
  await send('detachTab', { id: 2 });
  restart();
  const state = await send('snapshot');
  assert.equal(get(state, 2).parentTabId, null);
  assert.equal(get(state, 3).parentTabId, 2);
  assert.equal(get(state, 2).groupId, 'work');
});

test('cycles and invalid destinations reject before modifying any tree data', async () => {
  const { send, tree } = fixture();
  const initial = await tree();
  await assert.rejects(send('nestTab', { id: 1, parentTabId: 3 }), /cannot nest/);
  await assert.rejects(send('nestTab', { id: 1, parentTabId: 1 }), /cannot nest/);
  await assert.rejects(send('nestTab', { id: 1, parentTabId: 5 }), /parent tab has moved/);
  await assert.rejects(send('nestTab', { id: 5, parentTabId: 1 }), /another window/);
  await assert.rejects(
    send('moveTab', { id: 1, groupId: 'later', beforeId: 999 }),
    /destination tab/,
  );
  assert.deepEqual((await send('snapshot')).tabs, initial.tabs);
});

test('reordering children only changes sibling order and retains their parent', async () => {
  const { send } = fixture();
  await send('nestTab', { id: 2, parentTabId: 1 });
  await send('nestTab', { id: 3, parentTabId: 1 });
  const state = await send('moveTab', { id: 3, groupId: 'work', parentTabId: 1, beforeId: 2 });
  assert.deepEqual(
    tabSubtree(state.tabs, 1).map((tab) => tab.id),
    [1, 3, 2],
  );
  assert.equal(get(state, 3).parentTabId, 1);
});

test('confirmed branch close includes all descendants and pins, preserves other tabs and supports undo', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await send('pinTab', { id: 2 });
  await send('toggleTab', { id: 1 });
  const state = await send('closeTabTree', { id: 1, tabIds: [1, 2, 3, 4, 5] });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [4],
  );
  assert.equal((await api.tabs.get(5)).title, 'Other window');
  assert.equal(state.groups.length, 2);
  const parent = await send('undoCloseTab');
  const child = await send('undoCloseTab');
  const grandchild = await send('undoCloseTab');
  assert.equal(get(grandchild, child.restoredTabId).pinned, true);
  assert.deepEqual(
    tabSubtree(grandchild.tabs, parent.restoredTabId).map((tab) => tab.id),
    [parent.restoredTabId, child.restoredTabId, grandchild.restoredTabId],
  );
});

test('branch close excludes new children and confirmed tabs moved or detached elsewhere', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await send('detachTab', { id: 3 });
  await api.testing.attach(2, 2);
  const created = await send('newChildTab', { id: 1 });
  const newId = created.tabs.find((tab) => tab.id > 5).id;
  const state = await send('closeTabTree', { id: 1, tabIds: [1, 2, 3] });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id).sort((a, b) => a - b),
    [3, 4, newId],
  );
  assert.equal(get(state, newId).parentTabId, null);
  assert.equal((await api.tabs.get(2)).windowId, 2);
});

test('branch close rejects invalid confirmations and parents in other windows', async () => {
  const { api, send, tree } = fixture();
  await tree();
  for (const tabIds of [undefined, null, 'all', [], [2, 3], [1, '2']])
    await assert.rejects(send('closeTabTree', { id: 1, tabIds }), /tabs to close/);
  await assert.rejects(send('closeTabTree', { id: 5, tabIds: [5, 1] }), /another window/);
  assert.equal((await api.tabs.query({})).length, 5);
});

test('branch close can retry a partial failure without losing the remaining descendants', async () => {
  const { api, send, tree } = fixture();
  await tree();
  const remove = api.tabs.remove;
  api.tabs.remove = async (ids) => {
    await remove(ids[0]);
    throw new Error('Firefox could not close the remaining tabs.');
  };
  await assert.rejects(send('closeTabTree', { id: 1, tabIds: [1, 2, 3] }), /could not close/);
  assert.deepEqual(
    tabSubtree((await send('snapshot')).tabs, 1).map((tab) => tab.id),
    [1, 2],
  );
  api.tabs.remove = remove;
  assert.deepEqual(
    (await send('closeTabTree', { id: 1, tabIds: [1, 2, 3] })).tabs.map((tab) => tab.id),
    [4],
  );
});

test('closing a middle tab promotes children and restoring it reconnects changed tab IDs', async () => {
  const { api, send, tree, restart } = fixture();
  const initial = await tree();
  await send('closeTab', { id: 2 });
  let state = await send('snapshot');
  assert.equal(state.tabs.length, 3);
  assert.equal(get(state, 3).parentTabId, 1);
  restart();
  const restored = await api.testing.restore();
  state = await send('snapshot');
  assert.notEqual(restored.id, 2);
  assert.equal(get(state, restored.id).treeId, get(initial, 2).treeId);
  assert.equal(get(state, 3).parentTabId, restored.id);
  assert.equal(get(state, restored.id).parentTabId, 1);
});

test('parents and children reconnect even when the whole tree is restored in reverse order', async () => {
  const { api, send, tree, restart } = fixture();
  await tree();
  for (const id of [1, 2, 3]) await send('closeTab', { id });
  restart();
  const grandchild = await api.testing.restore();
  assert.equal(get(await send('snapshot'), grandchild.id).parentTabId, null);
  const child = await api.testing.restore();
  assert.equal(get(await send('snapshot'), grandchild.id).parentTabId, child.id);
  const parent = await api.testing.restore();
  const state = await send('snapshot');
  assert.deepEqual(
    tabSubtree(state.tabs, parent.id).map((tab) => tab.id),
    [parent.id, child.id, grandchild.id],
  );
});

test('duplicating a parent never steals its children, through Tabernacle or Firefox', async () => {
  const { api, send, tree } = fixture();
  await tree();
  const after = await send('duplicateTab', { id: 1 });
  const duplicate = after.tabs.find((tab) => ![1, 2, 3, 4].includes(tab.id));
  assert.notEqual(duplicate.treeId, get(after, 1).treeId);
  assert.equal(get(after, 2).parentTabId, 1);
  assert.equal(tabSubtree(after.tabs, duplicate.id).length, 1);
  const external = await api.tabs.duplicate(1);
  const state = await send('snapshot');
  assert.notEqual(get(state, external.id).treeId, get(state, 1).treeId);
  assert.equal(get(state, 2).parentTabId, 1);
  assert.equal(tabSubtree(state.tabs, external.id).length, 1);
});

test('group and tab collapse are independent and survive reload; reveal expands hidden ancestors', async () => {
  const { send, tree, restart } = fixture();
  await tree();
  await send('activateTab', { id: 3 });
  await send('toggleTab', { id: 1 });
  await send('toggleTab', { id: 2 });
  await send('toggleGroup', { id: 'work' });
  restart();
  let state = await send('snapshot');
  assert(get(state, 1).collapsed);
  assert(get(state, 2).collapsed);
  assert(state.view.collapsed.includes('work'));
  state = await send('revealActive');
  assert(!get(state, 1).collapsed);
  assert(!get(state, 2).collapsed);
  assert(!state.view.collapsed.includes('work'));
  assert.equal(state.view.scopeId, null);
});

test('explicit child creation under a pin wins over group scope and queued creation events', async () => {
  const { send } = fixture();
  await send('pinTab', { id: 1 });
  await send('enterGroup', { id: 'later' });
  await send('toggleTab', { id: 1 });
  await send('newChildTab', { id: 1 });
  const state = await send('snapshot');
  const child = state.tabs.find((tab) => tab.title === 'New tab');
  assert.equal(child.parentTabId, 1);
  assert.equal(child.groupId, 'work');
  assert.equal(get(state, 1).collapsed, false);
});

test('moving a tab to another Firefox window shows it as a root until its parent joins it', async () => {
  const { api, send, tree } = fixture();
  await tree();
  await api.testing.attach(2, 2);
  assert.equal(get(await send('snapshot', {}, 2), 2).parentTabId, null);
  assert.equal(get(await send('snapshot'), 3).parentTabId, 1);
  await api.testing.attach(1, 2);
  assert.equal(get(await send('snapshot', {}, 2), 2).parentTabId, 1);
});

test('moving group contents to Home keeps its tab trees intact', async () => {
  const { send, tree } = fixture();
  await tree();
  const state = await send('moveGroupContents', { id: 'work', groupId: null });
  assert.deepEqual(
    tabSubtree(state.tabs, 1).map((tab) => tab.id),
    [1, 2, 3],
  );
  assert(tabSubtree(state.tabs, 1).every((tab) => tab.groupId === null));
});

test('malformed ancestry and cycles cannot hide tabs or cross group boundaries', async () => {
  const { api, send } = fixture();
  await send('snapshot');
  const values = api.testing.tabValues;
  values.get(1).ancestors = [values.get(2).treeId];
  values.get(2).ancestors = [values.get(1).treeId];
  values.get(3).ancestors = [values.get(4).treeId];
  values.get(4).ancestors = 'bad';
  const state = await send('snapshot');
  const visible = state.tabs
    .filter((tab) => tab.parentTabId === null)
    .flatMap((tab) => tabSubtree(state.tabs, tab.id).map((tab) => tab.id));
  assert.deepEqual(visible.sort(), [1, 2, 3, 4]);
  assert.equal(get(state, 3).parentTabId, null);
  assert.equal((await api.sessions.getTabValue(1, TAB_KEY)).groupId, 'work');
});
