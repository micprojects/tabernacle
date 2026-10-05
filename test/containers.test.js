import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';

function fixture(notify) {
  const identities = [
    { cookieStoreId: 'firefox-container-1', name: 'Work', colorCode: '#00a7e0' },
    { cookieStoreId: 'firefox-container-2', name: 'Personal', colorCode: '#f89c24' },
  ];
  const api = memoryBrowser({
    groups: [{ id: 'project', name: 'Project', parentId: null }],
    containers: identities,
    tabs: [
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://example.com/parent',
        active: true,
        pinned: true,
        mutedInfo: { muted: true },
        cookieStoreId: 'firefox-default',
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://example.com/child',
        active: false,
        groupId: 42,
        cookieStoreId: 'firefox-container-1',
      },
      { id: 3, windowId: 1, index: 2, url: 'https://example.com/grandchild', active: false },
      { id: 4, windowId: 2, index: 0, url: 'https://example.com/other', active: true },
    ],
    memberships: {
      1: { groupId: 'project', treeId: 'parent', ancestors: [], collapsed: true, order: 5 },
      2: { groupId: 'project', treeId: 'child', ancestors: ['parent'], collapsed: true, order: 3 },
      3: { groupId: 'project', treeId: 'grandchild', ancestors: ['child', 'parent'], order: 0 },
    },
  });
  let controller;

  const restart = () => {
    controller?.dispose();
    controller = createController(api, notify);
    api.testing.setCreatedHandler((tab) => {
      controller.created(tab).catch(() => {});
    });
  };

  restart();
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  return { api, identities, send, restart };
}

test('container picker returns all current Firefox identities and the tab’s container', async () => {
  const { send, identities } = fixture();
  assert.deepEqual(await send('getContainers', { id: 2 }), {
    containers: identities,
    cookieStoreId: 'firefox-container-1',
  });
  assert.equal((await send('getContainers', { id: 1 })).cookieStoreId, 'firefox-default');
  await assert.rejects(send('getContainers', { id: 4 }), /another window/);
});

test('creating and editing Firefox containers updates snapshots without opening or moving tabs', async () => {
  const { send, api } = fixture();
  const before = await api.tabs.query({});
  const created = await send('createContainer', {
    name: '  Research  ',
    color: 'purple',
    icon: 'briefcase',
  });
  const cookieStoreId = created.createdCookieStoreId;
  assert.equal(
    created.containers.find((item) => item.cookieStoreId === cookieStoreId).name,
    'Research',
  );
  assert.deepEqual(await api.tabs.query({}), before);
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  const updated = await send('updateContainer', {
    cookieStoreId: 'firefox-container-1',
    name: 'Team',
    color: 'green',
    icon: 'tree',
  });
  assert.equal(updated.tabs.find((tab) => tab.id === 2).container.name, 'Team');
  assert.equal(updated.groups[0].defaultCookieStoreId, 'firefox-container-1');
  assert.deepEqual(await api.tabs.query({}), before);
});

test('container removal checks every window and retains unavailable group defaults', async () => {
  const { send, api, identities } = fixture();
  await assert.rejects(
    send('removeContainer', { cookieStoreId: 'firefox-container-1' }),
    /Close this container’s tabs/,
  );
  await api.tabs.update(4, { cookieStoreId: 'firefox-container-2' });
  await assert.rejects(
    send('removeContainer', { cookieStoreId: 'firefox-container-2' }),
    /all Firefox windows/,
  );
  assert.equal(identities.length, 2);
  await api.tabs.update(4, { cookieStoreId: 'firefox-default' });
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-2' });
  const state = await send('removeContainer', { cookieStoreId: 'firefox-container-2' });
  assert.equal(state.containers.length, 1);
  assert.equal(state.groups[0].defaultCookieStoreId, 'firefox-container-2');
  await assert.rejects(send('newTab', { groupId: 'project' }), /default container is unavailable/);
  for (const cookieStoreId of ['firefox-default', 'firefox-private', 'missing'])
    await assert.rejects(send('removeContainer', { cookieStoreId }), /no longer exists/);
});

test('container writes validate choices and surface Firefox failures without changing identities', async () => {
  const { send, api, identities } = fixture();
  const before = structuredClone(identities);
  for (const props of [{ name: ' ' }, { color: 'invalid' }, { icon: 'invalid' }])
    await assert.rejects(
      send('createContainer', { name: 'Test', color: 'blue', icon: 'circle', ...props }),
      /container/,
    );
  api.contextualIdentities.create = async () => {
    throw new Error('Firefox refused creation.');
  };
  await assert.rejects(
    send('createContainer', { name: 'Test', color: 'blue', icon: 'circle' }),
    /Firefox refused/,
  );
  assert.deepEqual(identities, before);
  await assert.rejects(
    send('updateContainer', {
      cookieStoreId: 'missing',
      name: 'Test',
      color: 'blue',
      icon: 'circle',
    }),
    /no longer exists/,
  );
  delete api.contextualIdentities;
  await assert.rejects(send('getContainerChoices'), /unavailable/);
  await assert.rejects(
    send('createContainer', { name: 'Test', color: 'blue', icon: 'circle' }),
    /unavailable/,
  );
});

test('container choices use Firefox’s current palette and writes invalidate warmed caches', async () => {
  const api = memoryBrowser({ events: true });
  const colors = [{ color: 'violet', colorCode: '#7c42ff' }];
  const icons = [{ icon: 'tree', iconUrl: 'resource://usercontext-content/tree.svg' }];
  api.contextualIdentities.getSupportedColors = async () => colors;
  api.contextualIdentities.getSupportedIcons = async () => icons;
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  assert.deepEqual(await send('getContainerChoices'), { colors, icons });
  await send('snapshot');
  // A write must be visible even before Firefox delivers its lifecycle event.
  delete api.contextualIdentities.onCreated;
  delete api.contextualIdentities.onRemoved;
  const state = await send('createContainer', { name: 'Study', color: 'violet', icon: 'tree' });
  assert.equal(state.containers.length, 1);
  assert.equal(
    (await send('removeContainer', { cookieStoreId: state.createdCookieStoreId })).containers
      .length,
    0,
  );
  controller.dispose();
});

test('group container defaults persist across restarts and windows without changing existing tabs', async () => {
  const notifications = [];
  const { api, send, restart } = fixture((event) => notifications.push(event));
  const before = (await send('snapshot')).tabs;
  const state = await send('setGroupContainer', {
    id: 'project',
    cookieStoreId: 'firefox-container-2',
  });
  assert.equal(notifications.at(-1).windowId, undefined);
  assert.deepEqual(state.tabs, before);
  const saved = (await api.storage.local.get(MODEL_KEY))[MODEL_KEY];
  assert.equal(saved.groups[0].defaultCookieStoreId, 'firefox-container-2');
  restart();
  for (const windowId of [1, 2]) {
    const next = await send('newTab', { groupId: 'project' }, windowId);
    const tab = next.tabs.find((item) => item.id === next.createdTabId);
    assert.equal(tab.cookieStoreId, 'firefox-container-2');
    assert.equal(tab.groupId, 'project');
    assert.equal(tab.windowId, windowId);
    assert.equal(tab.parentTabId, null);
  }
});

test('new groups save inherited, existing and explicit no-container defaults together', async () => {
  const { send, restart } = fixture();
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  for (const [cookieStoreId, expected] of [
    [null, 'firefox-container-1'],
    ['firefox-container-2', 'firefox-container-2'],
    ['firefox-default', 'firefox-default'],
  ]) {
    const state = await send('createGroup', { name: 'Child', parentId: 'project', cookieStoreId });
    const group = state.groups.find((item) => item.id === state.createdGroupId);
    assert.equal(group.defaultCookieStoreId, cookieStoreId ?? undefined);
    restart();
    const next = await send('newTab', { groupId: group.id });
    assert.equal(next.tabs.find((item) => item.id === next.createdTabId).cookieStoreId, expected);
  }
});

test('creating a group with a new container commits once and survives retries and restarts', async () => {
  const { api, send, restart, identities } = fixture();
  const before = await api.tabs.query({});
  const id = crypto.randomUUID();
  const args = {
    id,
    name: 'Client',
    parentId: 'project',
    newContainer: { name: 'Client account', color: 'purple', icon: 'briefcase' },
  };
  const created = await send('createGroup', args);
  const group = created.groups.find((item) => item.id === id);
  const identity = identities.find((item) => item.cookieStoreId === group.defaultCookieStoreId);
  assert.equal(identity.name, 'Client account');
  assert.equal(identity.color, 'purple');
  assert.equal(identity.icon, 'briefcase');
  assert.deepEqual(await api.tabs.query({}), before);
  restart();
  await send('createGroup', args);
  assert.equal(identities.length, 3);
  const state = await send('newTab', { groupId: id });
  assert.equal(
    state.tabs.find((item) => item.id === state.createdTabId).cookieStoreId,
    identity.cookieStoreId,
  );
});

test('group creation validates all details before creating a Firefox container', async () => {
  const { send, identities } = fixture();
  const args = {
    name: 'Client',
    newContainer: { name: 'Client', color: 'purple', icon: 'briefcase' },
  };
  for (const invalid of [
    { name: ' ' },
    { parentId: 'missing' },
    { newContainer: { ...args.newContainer, color: 'invalid' } },
    { newContainer: { ...args.newContainer, name: ' ' } },
    { cookieStoreId: 'firefox-container-1' },
    { newContainer: null, cookieStoreId: 'missing' },
  ])
    await assert.rejects(send('createGroup', { ...args, ...invalid }));
  assert.equal(identities.length, 2);
  assert.equal((await send('snapshot')).groups.length, 1);
});

test('failed group saves remove only their newly created container and can be retried', async () => {
  for (const failure of ['create', 'view', 'storage', 'response']) {
    const { api, send, restart, identities } = fixture();
    const args = {
      id: crypto.randomUUID(),
      name: 'Client',
      newContainer: { name: 'Client', color: 'blue', icon: 'circle' },
    };
    const create = api.contextualIdentities.create;
    const setView = api.sessions.setWindowValue;
    const getView = api.sessions.getWindowValue;
    const save = api.storage.local.set;
    let reads = 0;

    const fail = async () => {
      throw new Error('Save failed');
    };

    if (failure === 'create') api.contextualIdentities.create = fail;
    if (failure === 'view') api.sessions.setWindowValue = fail;
    if (failure === 'storage') api.storage.local.set = fail;
    if (failure === 'response')
      api.sessions.getWindowValue = async (...args) => {
        if (++reads === 2) throw new Error('Response failed');
        return getView(...args);
      };
    await assert.rejects(send('createGroup', args), /failed/);
    assert.equal(identities.length, failure === 'response' ? 3 : 2);
    api.contextualIdentities.create = create;
    api.sessions.setWindowValue = setView;
    api.sessions.getWindowValue = getView;
    api.storage.local.set = save;
    restart();
    const state = await send('createGroup', args);
    assert.equal(state.groups.filter((group) => group.id === args.id).length, 1);
    assert.equal(identities.length, 3);
  }
});

test('a failed container cleanup explains how to reuse it when saving the group again', async () => {
  const { api, send, identities } = fixture();
  const save = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Storage failed');
  };
  api.contextualIdentities.remove = async () => {
    throw new Error('Removal failed');
  };
  const id = crypto.randomUUID();
  await assert.rejects(
    send('createGroup', {
      id,
      name: 'Client',
      newContainer: { name: 'Client account', color: 'blue', icon: 'circle' },
    }),
    /Choose it using Change before retrying/,
  );
  assert.equal(identities.length, 3);
  api.storage.local.set = save;
  const state = await send('createGroup', {
    id,
    name: 'Client',
    cookieStoreId: identities.at(-1).cookieStoreId,
  });
  assert.equal(
    state.groups.find((group) => group.id === id).defaultCookieStoreId,
    identities.at(-1).cookieStoreId,
  );
  assert.equal(identities.length, 3);
});

test('a failed group save keeps a new container that another Firefox window has started using', async () => {
  const { api, send, identities } = fixture();
  const create = api.contextualIdentities.create;
  api.contextualIdentities.create = async (details) => {
    const identity = await create(details);
    await api.tabs.update(4, { cookieStoreId: identity.cookieStoreId });
    return identity;
  };
  api.storage.local.set = async () => {
    throw new Error('Storage failed');
  };
  await assert.rejects(
    send('createGroup', {
      name: 'Client',
      newContainer: { name: 'Client', color: 'blue', icon: 'circle' },
    }),
    /Choose it using Change before retrying/,
  );
  assert.equal(identities.length, 3);
  assert.equal((await api.tabs.get(4)).cookieStoreId, identities.at(-1).cookieStoreId);
});

test('nested groups use the nearest default, support No container and can return to inheritance', async () => {
  const { send } = fixture();
  const child = (await send('createGroup', { name: 'Child', parentId: 'project' })).createdGroupId;
  const leaf = (await send('createGroup', { name: 'Leaf', parentId: child })).createdGroupId;

  const open = async (expected) => {
    const state = await send('newTab', { groupId: leaf });
    assert.equal(state.tabs.find((tab) => tab.id === state.createdTabId).cookieStoreId, expected);
  };

  await open('firefox-default');
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  await open('firefox-container-1');
  await send('setGroupContainer', { id: child, cookieStoreId: 'firefox-container-2' });
  await open('firefox-container-2');
  await send('setGroupContainer', { id: child, cookieStoreId: 'firefox-default' });
  await open('firefox-default');
  const reset = await send('setGroupContainer', { id: child, cookieStoreId: null });
  assert(
    !Object.hasOwn(
      reset.groups.find((group) => group.id === child),
      'defaultCookieStoreId',
    ),
  );
  await open('firefox-container-1');
  await send('setGroupContainer', { id: 'project', cookieStoreId: null });
  await open('firefox-default');
});

test('moving groups and their contents recomputes inheritance while preserving explicit defaults', async () => {
  const { send } = fixture();
  const other = (await send('createGroup', { name: 'Other' })).createdGroupId;
  const child = (await send('createGroup', { name: 'Child', parentId: 'project' })).createdGroupId;
  const leaf = (await send('createGroup', { name: 'Leaf', parentId: child })).createdGroupId;
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  await send('setGroupContainer', { id: other, cookieStoreId: 'firefox-container-2' });
  await send('moveGroup', { id: child, parentId: other });
  let next = await send('newTab', { groupId: leaf });
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-container-2',
  );
  await send('setGroupContainer', { id: child, cookieStoreId: 'firefox-default' });
  await send('moveGroup', { id: child, parentId: 'project' });
  next = await send('newTab', { groupId: leaf });
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-default',
  );
  await send('moveGroupContents', { id: child, groupId: 'project' });
  next = await send('newTab', { groupId: leaf });
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-container-1',
  );
});

test('explicit new-tab choices override group defaults and Home has no group default', async () => {
  const { send } = fixture();
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  for (const cookieStoreId of ['firefox-default', 'firefox-container-2']) {
    const state = await send('newTab', { groupId: 'project', cookieStoreId });
    assert.equal(
      state.tabs.find((tab) => tab.id === state.createdTabId).cookieStoreId,
      cookieStoreId,
    );
  }
  await send('enterGroup', { id: 'project' });
  const home = await send('newTab', { groupId: null });
  assert.equal(
    home.tabs.find((tab) => tab.id === home.createdTabId).cookieStoreId,
    'firefox-default',
  );
});

test('new child tabs use the group default before the parent tab container and retain nesting', async () => {
  const { send } = fixture();
  for (const cookieStoreId of ['firefox-container-2', 'firefox-default']) {
    await send('setGroupContainer', { id: 'project', cookieStoreId });
    const state = await send('newChildTab', { id: 2 });
    const child = state.tabs.find((tab) => tab.active);
    assert.equal(child.cookieStoreId, cookieStoreId);
    assert.equal(child.parentTabId, 2);
    assert.equal(child.groupId, 'project');
  }
  await send('setGroupContainer', { id: 'project', cookieStoreId: null });
  const inherited = await send('newChildTab', { id: 2 });
  assert.equal(inherited.tabs.find((tab) => tab.active).cookieStoreId, 'firefox-container-1');
});

test('deleted or disabled defaults block creation and can be explicitly overridden or cleared', async () => {
  const { api, send, identities } = fixture();
  const child = (await send('createGroup', { name: 'Child', parentId: 'project' })).createdGroupId;
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  const count = (await api.tabs.query({})).length;
  identities.splice(0, 1);
  await assert.rejects(send('newTab', { groupId: child }), /default container is unavailable/);
  await assert.rejects(send('newChildTab', { id: 2 }), /default container is unavailable/);
  delete api.contextualIdentities;
  await assert.rejects(send('newTab', { groupId: 'project' }), /default container is unavailable/);
  assert.equal((await api.tabs.query({})).length, count);
  assert.equal((await send('snapshot')).groups[0].defaultCookieStoreId, 'firefox-container-1');
  const explicit = await send('newTab', { groupId: child, cookieStoreId: 'firefox-default' });
  assert.equal(
    explicit.tabs.find((tab) => tab.id === explicit.createdTabId).cookieStoreId,
    'firefox-default',
  );
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-default' });
  const plain = await send('newTab', { groupId: child });
  assert.equal(
    plain.tabs.find((tab) => tab.id === plain.createdTabId).cookieStoreId,
    'firefox-default',
  );
  await send('setGroupContainer', { id: 'project', cookieStoreId: null });
  await send('newTab', { groupId: child });
});

test('invalid settings and failed saves leave the saved default unchanged', async () => {
  const { api, send, restart } = fixture();
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-1' });
  for (const cookieStoreId of ['', undefined, 42, 'firefox-private', 'firefox-container-deleted'])
    await assert.rejects(send('setGroupContainer', { id: 'project', cookieStoreId }), /container/);
  for (const id of [null, undefined, 'missing'])
    await assert.rejects(send('setGroupContainer', { id, cookieStoreId: null }), /folder/);
  api.storage.local.set = async () => {
    throw new Error('Save failed');
  };
  await assert.rejects(
    send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-2' }),
    /Save failed/,
  );
  assert.equal((await send('snapshot')).groups[0].defaultCookieStoreId, 'firefox-container-1');
  restart();
  assert.equal((await send('snapshot')).groups[0].defaultCookieStoreId, 'firefox-container-1');
});

test('group defaults preserve the container of external, moved, duplicated and restored tabs', async () => {
  const { api, send } = fixture();
  await send('setGroupContainer', { id: 'project', cookieStoreId: 'firefox-container-2' });
  const external = await api.tabs.create({
    windowId: 1,
    openerTabId: 2,
    cookieStoreId: 'firefox-container-1',
  });
  let state = await send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.id === external.id).groupId, 'project');
  assert.equal(
    state.tabs.find((tab) => tab.id === external.id).cookieStoreId,
    'firefox-container-1',
  );
  await send('moveTab', { id: external.id, groupId: null });
  state = await send('moveTab', { id: external.id, groupId: 'project' });
  assert.equal(
    state.tabs.find((tab) => tab.id === external.id).cookieStoreId,
    'firefox-container-1',
  );
  await send('duplicateTab', { id: external.id });
  await send('closeTab', { id: external.id });
  state = await send('undoCloseTab');
  assert.equal(
    state.tabs.find((tab) => tab.id === state.restoredTabId).cookieStoreId,
    'firefox-container-1',
  );
  assert(!state.tabs.some((tab) => tab.cookieStoreId === 'firefox-container-2'));
});
test('new container tabs use the chosen group and store without inheriting the active tab tree', async () => {
  const { send, identities } = fixture();
  assert.deepEqual((await send('getContainers')).containers, identities);
  await send('enterGroup', { id: 'project' });
  let state = await send('newTab', { groupId: null, cookieStoreId: 'firefox-container-2' });
  let tab = state.tabs.find((tab) => tab.id === state.createdTabId);
  assert.equal(tab.cookieStoreId, 'firefox-container-2');
  assert.equal(tab.groupId, null);
  assert.equal(tab.parentTabId, null);
  assert.equal(tab.active, true);
  assert.equal(tab.windowId, 1);
  state = await send('newTab', { groupId: 'project', cookieStoreId: 'firefox-default' });
  tab = state.tabs.find((tab) => tab.id === state.createdTabId);
  assert.equal(tab.cookieStoreId, 'firefox-default');
  assert.equal(tab.groupId, 'project');
});
test('invalid or unavailable containers reject before opening a new tab', async () => {
  const { send, api } = fixture();
  const count = (await api.tabs.query({})).length;
  for (const cookieStoreId of ['', null, 42, 'firefox-container-deleted']) {
    await assert.rejects(send('newTab', { cookieStoreId }), /container/);
  }
  delete api.contextualIdentities;
  await assert.rejects(send('newTab', { cookieStoreId: 'firefox-container-1' }), /unavailable/);
  assert.equal((await api.tabs.query({})).length, count);
  // Normal new tabs still work with containers disabled.
  const state = await send('newTab');
  assert(state.tabs.some((tab) => tab.id === state.createdTabId));
});

test('snapshots resolve live container names and colours independently of tab nesting', async () => {
  const { send, identities } = fixture();
  let state = await send('snapshot');
  assert.deepEqual(state.tabs.find((tab) => tab.id === 2).container, {
    name: 'Work',
    colorCode: '#00a7e0',
  });
  assert.equal(state.tabs.find((tab) => tab.id === 1).container, null);
  assert.equal(state.tabs.find((tab) => tab.id === 3).container, null);
  identities[0].name = 'Research';
  identities[0].colorCode = '#af51f5';
  state = await send('snapshot');
  assert.deepEqual(state.tabs.find((tab) => tab.id === 2).container, {
    name: 'Research',
    colorCode: '#af51f5',
  });
  identities.splice(0, 1);
  assert.equal((await send('snapshot')).tabs.find((tab) => tab.id === 2).container, null);
});

test('missing or unavailable container APIs do not prevent the sidebar loading', async () => {
  const { api, send } = fixture();
  api.contextualIdentities.query = async () => {
    throw new Error('Containers are disabled');
  };
  let state = await send('snapshot');
  assert.equal(state.tabs.length, 3);
  assert(state.tabs.every((tab) => tab.container === null));
  delete api.contextualIdentities;
  state = await send('snapshot');
  assert.equal(state.tabs.length, 3);
  assert(state.tabs.every((tab) => tab.container === null));
});

test('container reopen preserves durable nesting, group, order, pin, mute and active state across restart', async () => {
  const { api, send, restart } = fixture();
  let createProperties;
  const create = api.tabs.create;
  api.tabs.create = (props) => {
    createProperties = props;
    return create(props);
  };
  const state = await send('reopenInContainer', { id: 1, cookieStoreId: 'firefox-container-2' });
  const replacement = state.tabs.find((tab) => tab.id === state.reopenedTabId);
  assert(!state.tabs.some((tab) => tab.id === 1));
  assert.equal(replacement.cookieStoreId, 'firefox-container-2');
  assert.equal(replacement.url, 'https://example.com/parent');
  assert.equal(replacement.groupId, 'project');
  assert.equal(replacement.treeId, 'parent');
  assert.equal(replacement.order, 5);
  assert(
    replacement.pinned &&
      replacement.mutedInfo.muted &&
      replacement.active &&
      replacement.collapsed,
  );
  assert.equal(createProperties.index, 1);
  assert.equal(createProperties.active, false);
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, replacement.id);
  assert.equal(state.tabs.find((tab) => tab.id === 2).cookieStoreId, 'firefox-container-1');
  assert.equal(state.tabs.find((tab) => tab.id === 3).parentTabId, 2);
  restart();
  assert.equal(
    (await send('snapshot')).tabs.find((tab) => tab.id === 2).parentTabId,
    replacement.id,
  );
  const restored = await api.testing.restore();
  const afterRestore = await send('snapshot');
  assert.notEqual(afterRestore.tabs.find((tab) => tab.id === restored.id).treeId, 'parent');
  assert.equal(afterRestore.tabs.find((tab) => tab.id === 2).parentTabId, replacement.id);
});

test('No container reopens a background child in the default store and keeps its children and native group', async () => {
  const { send } = fixture();
  const state = await send('reopenInContainer', { id: 2, cookieStoreId: 'firefox-default' });
  const replacement = state.tabs.find((tab) => tab.id === state.reopenedTabId);
  assert.equal(replacement.cookieStoreId, 'firefox-default');
  assert.equal(replacement.parentTabId, 1);
  assert.equal(replacement.nativeGroupId, 42);
  assert.equal(replacement.order, 3);
  assert.equal(replacement.collapsed, true);
  assert(!replacement.active);
  assert(state.tabs.find((tab) => tab.id === 1).active);
  assert.equal(state.tabs.find((tab) => tab.id === 3).parentTabId, replacement.id);
});

test('same container is a no-op; stale, private and cross-window destinations create no tabs', async () => {
  const { api, send } = fixture();
  let creations = 0;
  const create = api.tabs.create;
  api.tabs.create = (...args) => {
    creations++;
    return create(...args);
  };
  assert.equal(
    (await send('reopenInContainer', { id: 2, cookieStoreId: 'firefox-container-1' }))
      .reopenedTabId,
    2,
  );
  await assert.rejects(
    send('reopenInContainer', { id: 2, cookieStoreId: 'firefox-container-deleted' }),
    /no longer exists/,
  );
  await assert.rejects(
    send('reopenInContainer', { id: 2, cookieStoreId: 'firefox-private' }),
    /no longer exists/,
  );
  await assert.rejects(
    send('reopenInContainer', { id: 4, cookieStoreId: 'firefox-container-1' }),
    /another window/,
  );
  api.testing.windows.get(1).incognito = true;
  await assert.rejects(
    send('reopenInContainer', { id: 2, cookieStoreId: 'firefox-default' }),
    /private windows/,
  );
  assert.equal(creations, 0);
});

for (const failure of [
  'create',
  'membership',
  'group',
  'activate',
  'close',
  'cancel-close',
  'navigation',
  'replacement-closed',
  'replacement-moved',
  'wrong-container',
]) {
  test(`failed container reopen (${failure}) keeps the original and its tree`, async () => {
    const { api, send } = fixture();
    const id = failure === 'group' ? 2 : 1;
    const before = await send('snapshot');
    const saved = structuredClone(api.testing.tabValues.get(id));
    if (failure === 'create')
      api.tabs.create = async () => {
        throw new Error('Cannot open this URL');
      };
    if (failure === 'membership') {
      const set = api.sessions.setTabValue;
      api.sessions.setTabValue = async (tabId, ...rest) => {
        if (tabId > 4) throw new Error('Cannot save membership');
        return set(tabId, ...rest);
      };
    }
    if (failure === 'group')
      api.tabs.group = async () => {
        throw new Error('Group disappeared');
      };
    if (failure === 'activate') {
      const update = api.tabs.update;
      api.tabs.update = async (tabId, changes) => {
        if (tabId > 4) throw new Error('Cannot activate replacement');
        return update(tabId, changes);
      };
    }
    if (failure === 'close' || failure === 'cancel-close') {
      const remove = api.tabs.remove;
      api.tabs.remove = async (tabId) => {
        if (tabId === id) {
          if (failure === 'close') throw new Error('Cannot close original');
          return;
        }
        return remove(tabId);
      };
    }
    if (failure === 'navigation') {
      const create = api.tabs.create;
      api.tabs.create = async (props) => {
        const tab = await create(props);
        await api.tabs.update(id, { url: 'https://example.com/new-page' });
        return tab;
      };
    }
    if (['replacement-closed', 'replacement-moved', 'wrong-container'].includes(failure)) {
      const set = api.sessions.setTabValue;
      api.sessions.setTabValue = async (tabId, ...rest) => {
        await set(tabId, ...rest);
        if (tabId > 4) {
          if (failure === 'replacement-closed') await api.tabs.remove(tabId);
          if (failure === 'replacement-moved') await api.testing.attach(tabId, 2);
          if (failure === 'wrong-container')
            await api.tabs.update(tabId, { cookieStoreId: 'firefox-default' });
        }
      };
    }
    await assert.rejects(send('reopenInContainer', { id, cookieStoreId: 'firefox-container-2' }));
    const after = await send('snapshot');
    assert.deepEqual(
      after.tabs.map((tab) => tab.id),
      before.tabs.map((tab) => tab.id),
    );
    assert.deepEqual(await api.sessions.getTabValue(id, TAB_KEY), saved);
    assert.equal(after.tabs.find((tab) => tab.id === 2).parentTabId, 1);
    assert.equal(after.tabs.find((tab) => tab.id === 3).parentTabId, 2);
    assert(after.tabs.find((tab) => tab.id === 1).active);
  });
}

test('new child tabs inherit their parent’s container', async () => {
  const { send } = fixture();
  const state = await send('newChildTab', { id: 2 });
  const child = state.tabs.find((tab) => tab.id > 4);
  assert.equal(child.cookieStoreId, 'firefox-container-1');
  assert.equal(child.parentTabId, 2);
});

test('new-tab pages omit the restricted about:newtab URL when reopening', async () => {
  const { api, send } = fixture();
  await api.tabs.update(1, { url: 'about:newtab' });
  const create = api.tabs.create;
  api.tabs.create = (props) => {
    assert(!Object.hasOwn(props, 'url'));
    return create(props);
  };
  const state = await send('reopenInContainer', { id: 1, cookieStoreId: 'firefox-container-2' });
  assert.equal(state.tabs.find((tab) => tab.id === state.reopenedTabId).url, 'about:newtab');
});
