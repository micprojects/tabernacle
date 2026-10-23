import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import {
  MODEL_KEY,
  VIEW_KEY,
  groupById,
  groupPath,
  groupContainer,
  isWithin,
  normalizeView,
} from '../extension/src/model.js';

test('indexed model helpers preserve paths, inherited settings and view normalisation', () => {
  const model = {
    groups: Array.from({ length: 1000 }, (_, i) => ({
      id: `g${i}`,
      name: `Folder ${i}`,
      parentId: i % 10 ? `g${i - 1}` : null,
      ...(i % 10 === 0 ? { defaultCookieStoreId: 'firefox-container-1' } : {}),
      ...(i % 10 === 5 ? { defaultCookieStoreId: 'firefox-default' } : {}),
      opaque: { keep: i },
    })),
  };
  const index = new Map(model.groups.map((group) => [group.id, group]));
  const before = structuredClone(model);
  for (const id of [null, undefined, 'missing', 'g0', 'g5', 'g9', 'g999']) {
    assert.equal(groupById(model, id, index), groupById(model, id));
    assert.deepEqual(groupPath(model, id, index), groupPath(model, id));
    assert.equal(groupContainer(model, id, index), groupContainer(model, id));
    for (const scope of [null, 'missing', 'g0', 'g990', 'g995'])
      assert.equal(isWithin(model, id, scope, index), isWithin(model, id, scope));
    const view = {
      scopeId: id,
      collapsed: [...model.groups.map((group) => group.id), 'missing', 'g0'],
      recentFolders: [
        { id, enteredAt: 10 },
        { id, enteredAt: 20 },
        { id: 'g1', enteredAt: NaN },
      ],
      recentExpandedFolders: [
        { id, expandedAt: 4 },
        { id: 'missing', expandedAt: 2 },
      ],
      pinLayout: [{ kind: 'group', id: 'g0' }],
    };
    assert.deepEqual(normalizeView(model, view, index), normalizeView(model, view));
  }
  assert.deepEqual(model, before);
});

test('folder lookups follow committed records across failed writes, windows and restart', async () => {
  const api = memoryBrowser({
    groups: [
      {
        id: 'root',
        name: 'Root',
        parentId: null,
        defaultCookieStoreId: 'firefox-container-1',
        opaque: { keep: true },
      },
      { id: 'child', name: 'Child', parentId: 'root' },
      { id: 'other', name: 'Other', parentId: null, defaultCookieStoreId: 'firefox-default' },
    ],
    tabs: [
      { id: 1, index: 0, windowId: 1, title: 'One', active: true },
      { id: 2, index: 0, windowId: 2, title: 'Two', active: true },
    ],
    containers: [
      { cookieStoreId: 'firefox-container-1', name: 'One' },
      { cookieStoreId: 'firefox-container-2', name: 'Two' },
    ],
  });
  const controller = createController(api);
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  const retained = await send('snapshot');
  const save = api.storage.local.set;
  api.storage.local.set = async (value) => {
    if (Object.hasOwn(value, MODEL_KEY)) throw new Error('Model save refused');
    return save(value);
  };
  await assert.rejects(
    send('setGroupContainer', { id: 'root', cookieStoreId: 'firefox-container-2' }),
    /Model save refused/,
  );
  let next = await send('newTab', { groupId: 'child' });
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-container-1',
  );
  api.storage.local.set = save;
  await send('setGroupContainer', { id: 'root', cookieStoreId: 'firefox-container-2' });
  next = await send('newTab', { groupId: 'child' }, 2);
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-container-2',
  );
  next.groups.find((group) => group.id === 'root').defaultCookieStoreId = 'missing';
  await send('moveGroup', { id: 'child', parentId: 'other' });
  assert.deepEqual((await send('getGroupContents', { id: 'root' })).groupIds, ['root']);
  assert.deepEqual((await send('getGroupContents', { id: 'other' })).groupIds, ['other', 'child']);
  next = await send('newTab', { groupId: 'child' });
  assert.equal(
    next.tabs.find((tab) => tab.id === next.createdTabId).cookieStoreId,
    'firefox-default',
  );
  assert.equal(retained.groups[0].defaultCookieStoreId, 'firefox-container-1');
  assert.deepEqual((await send('snapshot')).groups.find((group) => group.id === 'root').opaque, {
    keep: true,
  });
  await controller.dispose();
  await assert.rejects(send('snapshot'), /disposed/);
  const restarted = createController(api);
  const restored = await restarted.request({ type: 'snapshot', windowId: 2 });
  assert.deepEqual(restored.groups, (await api.storage.local.get(MODEL_KEY))[MODEL_KEY].groups);
  await restarted.dispose();
});

test('folder view validation sees successful creation and removal, never a rejected creation', async () => {
  const api = memoryBrowser();
  const id = crypto.randomUUID();
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  await send('snapshot');
  await api.sessions.setWindowValue(1, VIEW_KEY, { scopeId: id, collapsed: [id] });
  const save = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Save failed');
  };
  await assert.rejects(send('createGroup', { id, name: 'New' }), /Save failed/);
  assert.deepEqual((await send('snapshot')).view, { scopeId: null, collapsed: [] });
  api.storage.local.set = save;
  await send('createGroup', { id, name: 'New' });
  await api.sessions.setWindowValue(1, VIEW_KEY, { scopeId: id, collapsed: [id] });
  const valid = await send('snapshot');
  assert.equal(valid.view.scopeId, id);
  assert.deepEqual(valid.view.collapsed, [id]);
  await send('removeGroup', { id, ...(await send('getGroupContents', { id })) });
  assert.deepEqual((await send('snapshot')).view, { scopeId: null, collapsed: [] });
  await controller.dispose();
});
