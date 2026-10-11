import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';
import {
  exportFolderBackup,
  parseFolderBackup,
  planFolderImport,
  materializeFolderImport,
  MAX_BACKUP_BYTES,
} from '../extension/src/folder-backup.js';

const identity = {
  cookieStoreId: 'firefox-container-1',
  name: 'Work',
  color: 'blue',
  icon: 'briefcase',
};
const groups = [
  {
    id: 'work',
    name: 'Work',
    parentId: null,
    defaultCookieStoreId: identity.cookieStoreId,
    appearance: { icon: 'keyboard', color: 'blue' },
  },
  { id: 'child', name: 'Projects', parentId: 'work' },
  { id: 'none', name: 'No container', parentId: 'child', defaultCookieStoreId: 'firefox-default' },
  { id: 'personal', name: 'Personal', parentId: null },
];
const backup = () => exportFolderBackup(groups, [identity], new Date('2026-10-11T12:00:00Z'));

function fixture(options = {}) {
  const api = memoryBrowser(options);
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  const previews = new Map();

  const send = async (type, args = {}) => {
    const response = await controller.request({
      type,
      windowId: 1,
      ...(type === 'importFolders' ? previews.get(args.token) : {}),
      ...args,
    });
    if (type === 'previewFolderImport')
      previews.set(response.token, { ...response, backup: args.backup });
    if (response.stale)
      previews.set(response.preview.token, {
        ...response.preview,
        backup: previews.get(args.token).backup,
      });
    return response;
  };

  return {
    api,
    controller,
    send,
    notices,
    stored: async () => (await api.storage.local.get(MODEL_KEY))[MODEL_KEY],
    preview: (value = backup(), destination = {}) =>
      send('previewFolderImport', { backup: JSON.stringify(value), destination }),
  };
}

test('portable export round-trips folder setup and allowlists all records', () => {
  const value = exportFolderBackup(
    groups.map((group) => ({ ...group, tabs: ['secret'], history: 'secret' })),
    [identity],
  );
  const text = JSON.stringify(value);
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('firefox-container-1'));
  assert.deepEqual(
    value.folders.map((folder) => folder.container),
    ['container-1', undefined, 'none', undefined],
  );
  assert.deepEqual(parseFolderBackup(text), value);
  const restored = materializeFolderImport(
    planFolderImport(value, [], {}),
    new Map([['container-1', 'firefox-container-99']]),
  );
  assert.equal(restored.groups[0].defaultCookieStoreId, 'firefox-container-99');
  assert.equal(restored.groups[1].defaultCookieStoreId, undefined);
  assert.equal(restored.groups[2].defaultCookieStoreId, 'firefox-default');
  assert.equal(restored.groups[2].parentId, restored.groups[1].id);
  assert.deepEqual(restored.groups[0].appearance, groups[0].appearance);
  assert.ok(restored.groups.every((group) => !groups.some((source) => source.id === group.id)));
  assert.equal(exportFolderBackup([], []).folders.length, 0);
});

test('merge pairs duplicate siblings once, preserves distinct trees and imports are repeatable', () => {
  const original = [
    { id: 'first', name: 'Same', parentId: null },
    { id: 'second', name: 'Same', parentId: null },
    { id: 'a', name: 'A', parentId: 'first' },
    { id: 'b', name: 'B', parentId: 'second' },
    { id: 'third', name: 'Same', parentId: null },
    { id: 'c', name: 'C', parentId: 'third' },
  ];
  const existing = [
    { id: 'destination', name: 'Destination', parentId: null },
    { id: 'other', name: 'Unrelated', parentId: 'destination' },
    { id: 'x', name: 'Same', parentId: 'destination', appearance: { color: 'red' } },
    { id: 'y', name: 'Same', parentId: 'destination' },
  ];
  const saved = exportFolderBackup(original, []);
  // Parent-first traversal must work for arbitrary record ordering too.
  saved.folders = [
    saved.folders[2],
    saved.folders[3],
    ...saved.folders.filter((_, i) => i !== 2 && i !== 3),
  ];
  const plan = planFolderImport(parseFolderBackup(saved), existing, { parentId: 'destination' });
  assert.equal(plan.reuseCount, 2);
  assert.equal(plan.createCount, 4);
  const added = materializeFolderImport(plan, new Map()).groups;
  assert.equal(added.find((group) => group.name === 'A').parentId, 'x');
  assert.equal(added.find((group) => group.name === 'B').parentId, 'y');
  assert.equal(
    added.find((group) => group.name === 'C').parentId,
    added.find((group) => group.name === 'Same').id,
  );
  const after = [...existing, ...added];
  assert.equal(planFolderImport(saved, after, { parentId: 'destination' }).createCount, 0);
  assert.deepEqual(after.slice(0, existing.length), existing);
});

test('invalid backups fail before planning, including cycles, references and appearance', () => {
  const bad = [
    (value) => {
      value.version = 20;
    },
    (value) => {
      value.format = 'another-app';
    },
    (value) => {
      value.exportedAt = 'not a date';
    },
    (value) => {
      value.folders[0].name = ' ';
    },
    (value) => {
      value.folders[0].name = 'a'.repeat(81);
    },
    (value) => {
      value.folders[1].id = value.folders[0].id;
    },
    (value) => {
      value.folders[0].parentId = value.folders[1].id;
    },
    (value) => {
      value.folders[0].parentId = 'missing';
    },
    (value) => {
      value.folders[0].container = 'missing';
    },
    (value) => {
      value.folders[0].appearance = { icon: 'not-an-icon' };
    },
    (value) => {
      value.folders[0].appearance = { color: 'url(evil)' };
    },
    (value) => {
      value.containers.push(value.containers[0]);
    },
    (value) => {
      value.containers[0].id = 'none';
    },
    (value) => {
      value.containers[0].name = '';
    },
  ];
  for (const change of bad) {
    const value = backup();
    change(value);
    assert.throws(() => parseFolderBackup(value));
  }
  assert.throws(() => parseFolderBackup('{'), /invalid/);
  assert.throws(() => parseFolderBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), /5 MB/);
});

test('all backup actions avoid tab snapshots, sessions and tab mutation; orphan memberships stay orphaned', async () => {
  const f = fixture({
    groups,
    containers: [identity],
    tabs: [{ id: 1, windowId: 1 }],
    memberships: { 1: { groupId: 'folder-1', treeId: 'original' } },
  });
  const before = await f.api.sessions.getTabValue(1, TAB_KEY);
  const originalGet = f.api.sessions.getTabValue;
  for (const object of [f.api.tabs, f.api.sessions])
    for (const key of Object.keys(object))
      if (typeof object[key] === 'function')
        object[key] = async () => {
          throw new Error(`Unexpected tab/session call: ${key}`);
        };
  const value = await f.send('exportFolders');
  assert.equal(value.folders.length, 4);
  assert.equal((await f.send('getFolderBackupState')).groups.length, 4);
  const preview = await f.preview(value, { newFolderName: 'Restored' });
  assert.equal(preview.containers[0].suggestedStore, identity.cookieStoreId);
  const result = await f.send('importFolders', {
    token: preview.token,
    containers: { 'container-1': identity.cookieStoreId },
  });
  assert.equal(result.createdFolders, 4);
  assert.equal(result.createdDestination, true);
  assert.equal((await f.stored()).groups.length, 9);
  assert.deepEqual(await originalGet(1, TAB_KEY), before);
  assert.ok(!(await f.stored()).groups.some((group) => group.id === 'folder-1'));
  assert.equal(f.notices.at(-1).windowId, undefined);
  assert.deepEqual(await f.send('importFolders', { token: preview.token }), result);
  assert.equal((await f.stored()).groups.length, 9);
  f.controller.dispose();
});

test('Home merge leaves existing settings and order intact and only maps containers needed for additions', async () => {
  const existing = [
    {
      id: 'existing',
      name: 'Work',
      parentId: null,
      appearance: { color: 'red' },
      defaultCookieStoreId: 'firefox-default',
    },
  ];
  const f = fixture({ groups: existing });
  const preview = await f.preview();
  assert.deepEqual(preview.containers, []);
  assert.equal(preview.reuseCount, 1);
  await f.send('importFolders', { token: preview.token });
  const model = await f.stored();
  assert.deepEqual(model.groups[0], existing[0]);
  assert.equal(model.groups.find((group) => group.name === 'Projects').parentId, 'existing');
  assert.equal((await f.preview()).createCount, 0);
  f.controller.dispose();
});

test('missing containers require an explicit choice; exact unique matches are suggested', async () => {
  const f = fixture();
  let preview = await f.preview();
  assert.equal(preview.containers[0].suggestedStore, null);
  assert.equal(preview.containers[0].canCreate, true);
  await assert.rejects(f.send('importFolders', { token: preview.token }), /Choose a container/);
  assert.deepEqual((await f.stored()).groups, []);
  const result = await f.send('importFolders', {
    token: preview.token,
    containers: { 'container-1': 'create' },
  });
  assert.equal(result.createdContainers, 1);
  assert.equal((await f.api.contextualIdentities.query({})).length, 1);
  preview = await f.preview(backup(), { newFolderName: 'Second' });
  assert.equal(preview.containers[0].suggestedStore, 'firefox-container-1');
  await f.api.contextualIdentities.create(identity);
  preview = await f.preview(backup(), { newFolderName: 'Third' });
  assert.equal(preview.containers[0].suggestedStore, null);
  f.controller.dispose();
});

test('unavailable container definitions and disabled Firefox containers can map to No container', async () => {
  const f = fixture();
  const value = exportFolderBackup(groups, []);
  assert.deepEqual(value.containers, [{ id: 'container-1', unavailable: true }]);
  f.api.contextualIdentities.query = async () => {
    throw new Error('disabled');
  };
  const preview = await f.preview(value);
  assert.equal(preview.containers[0].canCreate, false);
  assert.ok(preview.containerError);
  await f.send('importFolders', { token: preview.token, containers: { 'container-1': 'none' } });
  assert.equal((await f.stored()).groups[0].defaultCookieStoreId, 'firefox-default');
  f.controller.dispose();
});

test('changed folders or containers return a fresh preview without importing', async () => {
  const f = fixture({ groups: [{ id: 'target', name: 'Target', parentId: null }] });
  let preview = await f.preview(backup(), { parentId: 'target' });
  await f.send('renameGroup', { id: 'target', name: 'Renamed' });
  let result = await f.send('importFolders', {
    token: preview.token,
    containers: { 'container-1': 'create' },
  });
  assert.equal(result.stale, true);
  assert.equal((await f.stored()).groups.length, 1);
  assert.equal(result.preview.groups[0].name, 'Renamed');
  preview = result.preview;
  await f.api.contextualIdentities.create(identity);
  result = await f.send('importFolders', {
    token: preview.token,
    containers: { 'container-1': 'create' },
  });
  assert.equal(result.stale, true);
  assert.equal((await f.stored()).groups.length, 1);
  assert.equal((await f.api.contextualIdentities.query({})).length, 1);
  f.controller.dispose();
});

test('storage failure leaves folders unchanged, removes unused created containers and supports retry', async () => {
  const f = fixture();
  const preview = await f.preview();
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async () => {
    throw new Error('Storage failed');
  };
  await assert.rejects(
    f.send('importFolders', { token: preview.token, containers: { 'container-1': 'create' } }),
    /Storage failed/,
  );
  assert.deepEqual((await f.stored()).groups, []);
  assert.deepEqual(await f.api.contextualIdentities.query({}), []);
  f.api.storage.local.set = set;
  await f.send('importFolders', { token: preview.token, containers: { 'container-1': 'create' } });
  assert.equal((await f.stored()).groups.length, 4);
  f.controller.dispose();
});

test('failed import keeps newly created containers that are already in use and reports them', async () => {
  const f = fixture();
  const preview = await f.preview();
  f.api.storage.local.set = async () => {
    throw new Error('Storage failed');
  };
  f.api.tabs.query = async () => [{ cookieStoreId: 'firefox-container-1' }];
  f.api.tabs.remove = async () => {
    throw new Error('Must never close tabs');
  };
  await assert.rejects(
    f.send('importFolders', { token: preview.token, containers: { 'container-1': 'create' } }),
    /These containers were kept: Work/,
  );
  assert.equal((await f.api.contextualIdentities.query({})).length, 1);
  assert.deepEqual((await f.stored()).groups, []);
  f.controller.dispose();
});

test('partial container creation failure cleans up earlier creations before folder writes', async () => {
  const f = fixture();
  const value = backup();
  value.containers.push({ id: 'second', name: 'Second', icon: 'briefcase', color: 'red' });
  value.folders[1].container = 'second';
  const preview = await f.preview(value);
  const create = f.api.contextualIdentities.create;
  f.api.contextualIdentities.create = async (details) => {
    if (details.name === 'Second') throw new Error('Creation failed');
    return create(details);
  };
  await assert.rejects(
    f.send('importFolders', {
      token: preview.token,
      containers: { 'container-1': 'create', second: 'create' },
    }),
    /Creation failed/,
  );
  assert.deepEqual(await f.api.contextualIdentities.query({}), []);
  assert.deepEqual((await f.stored()).groups, []);
  f.controller.dispose();
});

test('pending moves block backup actions without replaying tab changes', async () => {
  const api = memoryBrowser();
  await api.storage.local.set({
    [PENDING_MOVE_KEY]: { version: 1, direction: 'after', changes: [] },
  });
  api.tabs.query = async () => {
    throw new Error('Must not replay pending moves');
  };
  const controller = createController(api);
  await assert.rejects(
    controller.request({ type: 'exportFolders', windowId: 1 }),
    /move needs to finish/,
  );
  assert.ok((await api.storage.local.get(PENDING_MOVE_KEY))[PENDING_MOVE_KEY]);
  controller.dispose();
});

test('empty backups are valid, and invalid destinations/files never write storage', async () => {
  const f = fixture();
  let writes = 0;
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    writes++;
    return set(value);
  };
  await assert.rejects(f.preview(backup(), { parentId: 'gone' }), /no longer exists/);
  await assert.rejects(f.preview(backup(), { newFolderName: ' ' }), /name/);
  await assert.rejects(f.send('previewFolderImport', { backup: '{bad' }), /invalid/);
  const preview = await f.preview(exportFolderBackup([], []));
  const result = await f.send('importFolders', { token: preview.token });
  assert.equal(result.createdFolders, 0);
  assert.equal(writes, 0);
  f.controller.dispose();
});

test('a reviewed import survives background unload and a lost commit reply cannot create another destination', async () => {
  const api = memoryBrowser();
  let controller = createController(api);
  const value = backup();
  const preview = await controller.request({
    type: 'previewFolderImport',
    windowId: 1,
    backup: value,
    destination: { newFolderName: 'Restored' },
  });
  const request = {
    type: 'importFolders',
    windowId: 1,
    token: preview.token,
    fingerprint: preview.fingerprint,
    backup: value,
    destination: preview.destination,
    containers: { 'container-1': 'create' },
  };
  controller.dispose();
  controller = createController(api);
  const result = await controller.request(request);
  assert.equal(result.createdFolders, 4);
  const committed = (await api.storage.local.get(MODEL_KEY))[MODEL_KEY];
  controller.dispose();
  controller = createController(api);
  assert.deepEqual(await controller.request(request), result);
  assert.deepEqual((await api.storage.local.get(MODEL_KEY))[MODEL_KEY], committed);
  assert.equal((await api.contextualIdentities.query({})).length, 1);
  assert.equal(
    (await controller.request({ type: 'exportFolders', windowId: 1 })).lastFolderImport,
    undefined,
  );
  controller.dispose();
});

test('a destination removed after preview is rejected before writing or creating containers', async () => {
  const f = fixture({ groups: [{ id: 'target', name: 'Target', parentId: null }] });
  const preview = await f.preview(backup(), { parentId: 'target' });
  await f.send('removeGroup', { id: 'target', groupIds: ['target'], tabIds: [] });
  await assert.rejects(
    f.send('importFolders', { token: preview.token, containers: { 'container-1': 'create' } }),
    /no longer exists/,
  );
  assert.deepEqual((await f.stored()).groups, []);
  assert.deepEqual(await f.api.contextualIdentities.query({}), []);
  f.controller.dispose();
});
