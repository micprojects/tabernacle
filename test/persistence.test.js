import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { deserializeMembership, deserializeModel } from '../extension/src/persistence.js';

async function legacyFixture({ modelField, membershipField }) {
  const api = memoryBrowser({
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'Parent', active: true, groupId: 42 },
      { id: 2, windowId: 1, index: 1, title: 'Child', groupId: -1 },
      { id: 3, windowId: 1, index: 2, title: 'Home tab', groupId: -1 },
    ],
  });
  // Seed persisted data directly so serializers cannot hide compatibility bugs.
  await api.storage.local.set({
    'tabernacle.model.v1': {
      version: 1,
      [modelField]: [
        { id: 'work', name: 'Work', parentId: null },
        { id: 'project', name: 'Project', parentId: 'work' },
      ],
      compact: true,
    },
  });
  for (const [id, value] of [
    [
      1,
      { [membershipField]: 'project', treeId: 'parent', ancestors: [], order: 0, collapsed: true },
    ],
    [2, { [membershipField]: 'project', treeId: 'child', ancestors: ['parent'], order: 1 }],
    [3, { [membershipField]: null, treeId: 'home', ancestors: [], order: 2 }],
  ])
    await api.sessions.setTabValue(id, 'tabernacle.membership.v1', value);
  await api.sessions.setWindowValue(1, 'tabernacle.view.v1', {
    scopeId: 'work',
    collapsed: ['project'],
  });
  let controller;

  const restart = () => {
    controller?.dispose();
    controller = createController(api);
    api.testing.setCreatedHandler((tab) => controller.created(tab).catch(() => {}));
  };

  restart();
  return {
    api,
    restart,
    send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }),
  };
}

for (const fields of [
  { modelField: 'groups', membershipField: 'groupId' },
  { modelField: 'folders', membershipField: 'folderId' },
]) {
  test(`${fields.modelField} storage preserves groups, views and closed-tab memberships`, async () => {
    const { api, send } = await legacyFixture(fields);
    // Simulate a tab closed before the updated extension first reads its data.
    await api.tabs.remove(1);
    const initial = await send('snapshot');
    assert.deepEqual(initial.groups, [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'project', name: 'Project', parentId: 'work' },
    ]);
    assert.equal(Object.hasOwn(initial, 'compact'), false);
    assert.deepEqual(initial.view, { scopeId: 'work', collapsed: ['project'] });
    assert.equal(initial.tabs.find((tab) => tab.id === 2).groupId, 'project');
    assert.equal(initial.tabs.find((tab) => tab.id === 2).parentTabId, null);

    const restored = await send('undoCloseTab');
    const parent = restored.tabs.find((tab) => tab.id === restored.restoredTabId);
    assert.notEqual(parent.id, 1);
    assert.equal(parent.groupId, 'project');
    assert.equal(parent.nativeGroupId, 42);
    assert.equal(parent.treeId, 'parent');
    assert.equal(parent.collapsed, true);
    assert.equal(restored.tabs.find((tab) => tab.id === 2).parentTabId, parent.id);
    assert.equal(Object.hasOwn(restored, 'folders'), false);
    assert(restored.tabs.every((tab) => !Object.hasOwn(tab, 'folderId')));

    await send('closeTab', { id: 3 });
    const home = await send('undoCloseTab');
    assert.equal(home.tabs.find((tab) => tab.id === home.restoredTabId).groupId, null);
    assert.equal(home.view.scopeId, null);
  });

  test(`${fields.modelField} storage saves edits in the original group format across restarts`, async () => {
    const { api, send, restart } = await legacyFixture(fields);
    await send('renameGroup', { id: 'project', name: 'Renamed' });
    const created = await send('createGroup', { name: 'Later' });
    const destination = created.createdGroupId;
    await send('moveTab', { id: 1, groupId: destination });
    await send('enterGroup', { id: destination });

    const saved = (await api.storage.local.get('tabernacle.model.v1'))['tabernacle.model.v1'];
    assert.equal(saved.version, 1);
    assert.equal(Object.hasOwn(saved, 'folders'), false);
    assert.equal(saved.groups.find((group) => group.id === 'project').name, 'Renamed');
    assert(saved.groups.some((group) => group.id === destination));
    for (const id of [1, 2]) {
      const value = await api.sessions.getTabValue(id, 'tabernacle.membership.v1');
      assert.equal(value.groupId, destination);
      assert.equal(Object.hasOwn(value, 'folderId'), false);
    }

    restart();
    const restored = await send('snapshot');
    assert.deepEqual(restored.groups, saved.groups);
    assert.equal(restored.view.scopeId, destination);
    assert.equal(restored.tabs.find((tab) => tab.id === 1).groupId, destination);
    assert.equal(restored.tabs.find((tab) => tab.id === 2).groupId, destination);
    assert.equal(restored.tabs.find((tab) => tab.id === 2).parentTabId, 1);
    assert.equal(restored.tabs.find((tab) => tab.id === 1).nativeGroupId, 42);
  });
}

test('compatibility reads preserve absent membership and explicit Home placement', () => {
  assert.equal(deserializeMembership(undefined), undefined);
  assert.equal(deserializeMembership(null), null);
  assert.deepEqual(deserializeMembership({ treeId: 'new-tab' }), { treeId: 'new-tab' });
  assert.deepEqual(deserializeMembership({ folderId: null }), { groupId: null });
  assert.deepEqual(deserializeMembership({ groupId: null, folderId: 'old-group' }), {
    groupId: null,
  });
  assert.deepEqual(deserializeModel({ version: 1, groups: [], folders: [{ id: 'old-group' }] }), {
    version: 1,
    groups: [],
  });
});
