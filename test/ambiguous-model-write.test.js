import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY } from '../extension/src/model.js';
import { exportFolderBackup } from '../extension/src/folder-backup.js';

function fixture(t) {
  const api = memoryBrowser({
    groups: [{ id: 'existing', name: 'Existing', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, index: 0 },
      { id: 2, windowId: 2, index: 0 },
    ],
  });
  api.testing.saved[MODEL_KEY].opaque = { retained: true };
  api.testing.saved[MODEL_KEY].look.future = { retained: true };
  const controller = createController(api);
  t.after(() => controller.dispose());
  return { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) };
}

async function importRequest(f) {
  const backup = exportFolderBackup(
    [
      { id: 'source', name: 'Imported', parentId: null, defaultCookieStoreId: 'source-container' },
      { id: 'child', name: 'Child', parentId: 'source' },
    ],
    [
      {
        cookieStoreId: 'source-container',
        name: 'Imported container',
        color: 'blue',
        icon: 'briefcase',
      },
    ],
  );
  const preview = await f.send('previewFolderImport', {
    backup,
    destination: { newFolderName: 'Destination' },
  });
  return {
    backup,
    token: preview.token,
    fingerprint: preview.fingerprint,
    destination: preview.destination,
    containers: { 'container-1': 'create' },
  };
}

function lostWrite(f, after = () => {}) {
  const set = f.api.storage.local.set;
  let once = true;
  f.api.storage.local.set = async (value) => {
    await set(value);
    if (value[MODEL_KEY] && once) {
      once = false;
      after();
      throw new Error('Storage reply lost');
    }
  };
}

test('a committed import survives a lost storage reply, another-window save and retry', async (t) => {
  const f = fixture(t);
  const request = await importRequest(f);
  lostWrite(f);
  await assert.rejects(f.send('importFolders', request), /Storage reply lost/);
  const committed = structuredClone(f.api.testing.saved[MODEL_KEY]);
  const containers = await f.api.contextualIdentities.query({});
  assert.equal(containers.length, 1);
  assert(committed.groups.some((g) => g.defaultCookieStoreId === containers[0].cookieStoreId));
  await f.send('createGroup', { name: 'Unrelated', windowId: 2 });
  const after = f.api.testing.saved[MODEL_KEY];
  for (const group of committed.groups)
    assert.deepEqual(
      after.groups.find((g) => g.id === group.id),
      group,
    );
  assert.deepEqual(after.opaque, { retained: true });
  assert.deepEqual(after.look.future, { retained: true });
  const count = after.groups.length;
  const result = await f.send('importFolders', request);
  assert.deepEqual(result, committed.lastFolderImport.result);
  assert.equal(f.api.testing.saved[MODEL_KEY].groups.length, count);
  assert.deepEqual(await f.api.contextualIdentities.query({}), containers);
});

test('an unreadable model after an ambiguous import keeps containers and blocks subsequent writes', async (t) => {
  const f = fixture(t);
  const request = await importRequest(f);
  const get = f.api.storage.local.get;
  lostWrite(f, () => {
    f.api.storage.local.get = async (key) => {
      if (key === MODEL_KEY) throw new Error('Read unavailable');
      return get(key);
    };
  });
  await assert.rejects(
    f.send('importFolders', request),
    /These containers were kept: Imported container/,
  );
  const committed = structuredClone(f.api.testing.saved);
  assert.equal((await f.api.contextualIdentities.query({})).length, 1);
  await assert.rejects(
    f.send('createGroup', { name: 'Must not overwrite', windowId: 2 }),
    /Read unavailable/,
  );
  assert.deepEqual(f.api.testing.saved, committed);
  f.api.storage.local.get = get;
  assert.deepEqual(
    await f.send('importFolders', request),
    committed[MODEL_KEY].lastFolderImport.result,
  );
  await f.send('renameGroup', { id: 'existing', name: 'Renamed' });
  assert.equal(f.api.testing.saved[MODEL_KEY].groups.length, committed[MODEL_KEY].groups.length);
});

test('a committed appearance change is retained by the next unrelated save without a restart', async (t) => {
  const f = fixture(t);
  await f.send('getSettings');
  lostWrite(f);
  await assert.rejects(
    f.send('setLook', { partial: true, value: { domains: true } }),
    /Storage reply lost/,
  );
  await f.send('renameGroup', { id: 'existing', name: 'Renamed', windowId: 2 });
  assert.equal(f.api.testing.saved[MODEL_KEY].look.domains, true);
  assert.deepEqual(f.api.testing.saved[MODEL_KEY].look.future, { retained: true });
});

test('a committed folder creation is retained and its original identity remains retryable', async (t) => {
  const f = fixture(t);
  await f.send('snapshot');
  lostWrite(f);
  const id = 'ce1e4f41-7020-4227-9af8-2a467f7ac111';
  await assert.rejects(f.send('createGroup', { id, name: 'Created' }), /Storage reply lost/);
  await f.send('renameGroup', { id: 'existing', name: 'Renamed', windowId: 2 });
  assert.equal(f.api.testing.saved[MODEL_KEY].groups.find((g) => g.id === id)?.name, 'Created');
  await f.send('createGroup', { id, name: 'Created' });
  assert.equal(f.api.testing.saved[MODEL_KEY].groups.filter((g) => g.id === id).length, 1);
});

test('unsupported saved data after an ambiguous import is kept with its containers', async (t) => {
  const f = fixture(t);
  const request = await importRequest(f);
  lostWrite(f, () => {
    f.api.testing.saved[MODEL_KEY].version = 99;
  });
  await assert.rejects(
    f.send('importFolders', request),
    /These containers were kept: Imported container/,
  );
  const committed = structuredClone(f.api.testing.saved);
  assert.equal((await f.api.contextualIdentities.query({})).length, 1);
  await assert.rejects(f.send('createGroup', { name: 'Must not overwrite' }), /newer version/);
  assert.deepEqual(f.api.testing.saved, committed);
});

for (const unavailable of [false, true]) {
  test(`a committed new-container folder survives a lost write reply${unavailable ? ' and failed reads' : ''}`, async (t) => {
    const f = fixture(t);
    await f.send('snapshot');
    const get = f.api.storage.local.get;
    const id = 'ce1e4f41-7020-4227-9af8-2a467f7ac222';
    const request = {
      id,
      name: 'Client',
      newContainer: { name: 'Client', color: 'blue', icon: 'briefcase' },
    };
    lostWrite(f, () => {
      if (unavailable)
        f.api.storage.local.get = async (key) => {
          if (key === MODEL_KEY) throw new Error('Read unavailable');
          return get(key);
        };
    });
    await assert.rejects(f.send('createGroup', request), /Storage reply lost/);
    const committed = structuredClone(f.api.testing.saved[MODEL_KEY]);
    const containers = await f.api.contextualIdentities.query({});
    assert.equal(containers.length, 1);
    assert.equal(
      committed.groups.find((group) => group.id === id).defaultCookieStoreId,
      containers[0].cookieStoreId,
    );
    if (unavailable) {
      await assert.rejects(
        f.send('renameGroup', { id: 'existing', name: 'Blocked' }),
        /Read unavailable/,
      );
      assert.deepEqual(f.api.testing.saved[MODEL_KEY], committed);
      f.api.storage.local.get = get;
    }
    await f.send('renameGroup', { id: 'existing', name: 'Renamed', windowId: 2 });
    await f.send('createGroup', request);
    assert.equal(
      f.api.testing.saved[MODEL_KEY].groups.filter((group) => group.id === id).length,
      1,
    );
    assert.deepEqual(await f.api.contextualIdentities.query({}), containers);
  });
}

test('a confirmed failed write still removes unused containers with legacy folder storage', async (t) => {
  const f = fixture(t);
  const raw = f.api.testing.saved[MODEL_KEY];
  raw.folders = raw.groups;
  delete raw.groups;
  await f.send('snapshot');
  const before = structuredClone(raw);
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[MODEL_KEY]) throw new Error('Write refused');
    return set(value);
  };
  await assert.rejects(
    f.send('createGroup', {
      name: 'Client',
      newContainer: { name: 'Client', color: 'blue', icon: 'briefcase' },
    }),
    /Write refused/,
  );
  assert.deepEqual(f.api.testing.saved[MODEL_KEY], before);
  assert.deepEqual(await f.api.contextualIdentities.query({}), []);
});
