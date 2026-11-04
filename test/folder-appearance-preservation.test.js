import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY } from '../extension/src/model.js';
import { normalizeNewTab } from '../extension/src/new-tab/preferences.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture(t) {
  const opaque = { version: 4, values: ['keep', { enabled: true }] };
  const api = memoryBrowser({
    groups: [
      {
        id: 'work',
        name: 'Work',
        parentId: null,
        defaultCookieStoreId: 'firefox-default',
        appearance: { icon: 'plane', color: 'purple', opaque },
        unrelated: opaque,
      },
      { id: 'child', name: 'Child', parentId: 'work', appearance: { icon: 'book' } },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'First' },
      { id: 2, windowId: 2, index: 0, title: 'Second' },
    ],
    memberships: { 1: { groupId: 'work' }, 2: { groupId: 'child' } },
  });
  Object.assign(api.testing.saved[MODEL_KEY], {
    newTab: normalizeNewTab(),
    folderPins: [],
    domainPins: [],
  });
  const original = structuredClone(api.testing.saved[MODEL_KEY]);
  let controller = createController(api);
  t.after(() => controller.dispose());
  return {
    api,
    opaque,
    original,
    saved: () => api.testing.saved[MODEL_KEY],
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),

    restart() {
      controller.dispose();
      controller = createController(api);
    },
  };
}

for (const appearance of [{ icon: 'book', color: 'teal' }, { icon: 'book' }, {}]) {
  test(`appearance ${JSON.stringify(appearance)} preserves unknown fields through another window and restart`, async (t) => {
    const f = fixture(t);
    await f.send('setGroupAppearance', { id: 'work', appearance });
    const expected = structuredClone(f.original);
    expected.groups[0].appearance = { opaque: f.opaque, ...appearance };
    assert.deepEqual(f.saved(), expected);
    assert.deepEqual((await f.send('snapshot', {}, 2)).groups, expected.groups);
    f.restart();
    await f.send('renameGroup', { id: 'child', name: 'Renamed child' }, 2);
    expected.groups[1].name = 'Renamed child';
    assert.deepEqual(f.saved(), expected);
  });
}

test('an appearance reset still removes a record containing only supported overrides', async (t) => {
  const f = fixture(t);
  await f.send('setGroupAppearance', { id: 'child', appearance: {} });
  assert.equal(f.saved().groups[1].appearance, undefined);
  assert.deepEqual(f.saved().groups[0], f.original.groups[0]);
});

test('failed appearance reads and writes preserve metadata until an explicit retry succeeds', async (t) => {
  const f = fixture(t);
  const read = f.api.storage.local.get;
  f.api.storage.local.get = async () => {
    throw new Error('Read failed');
  };
  await assert.rejects(f.send('setGroupAppearance', { id: 'work', appearance: {} }), /Read failed/);
  assert.deepEqual(f.saved(), f.original);
  f.api.storage.local.get = read;
  await f.send('snapshot');
  const write = f.api.storage.local.set;
  f.api.storage.local.set = async () => {
    throw new Error('Write failed');
  };
  await assert.rejects(
    f.send('setGroupAppearance', { id: 'work', appearance: {} }),
    /Write failed/,
  );
  assert.deepEqual(f.saved(), f.original);
  assert.deepEqual((await f.send('snapshot', {}, 2)).groups, f.original.groups);
  f.api.storage.local.set = write;
  await f.send('setGroupAppearance', { id: 'work', appearance: {} }, 2);
  assert.deepEqual(f.saved().groups[0].appearance, { opaque: f.opaque });
});

test('a lost appearance write response retains metadata through another-window save and retry', async (t) => {
  const f = fixture(t);
  await f.send('snapshot');
  const write = f.api.storage.local.set;
  let loseResponse = true;
  f.api.storage.local.set = async (value) => {
    await write(value);
    if (Object.hasOwn(value, MODEL_KEY) && loseResponse) {
      loseResponse = false;
      throw new Error('Write response lost');
    }
  };
  const appearance = { color: 'teal' };
  await assert.rejects(
    f.send('setGroupAppearance', { id: 'work', appearance }),
    /Write response lost/,
  );
  assert.deepEqual(f.saved().groups[0].appearance, { opaque: f.opaque, ...appearance });
  await f.send('renameGroup', { id: 'child', name: 'Other window' }, 2);
  f.restart();
  await f.send('setGroupAppearance', { id: 'work', appearance }, 2);
  assert.deepEqual(f.saved().groups[0].appearance, { opaque: f.opaque, ...appearance });
  assert.equal(f.saved().groups[1].name, 'Other window');
});

test('queued edits in two windows preserve stored metadata without accepting opaque input', async (t) => {
  const f = fixture(t);
  await Promise.all([
    f.send('setGroupAppearance', { id: 'work', appearance: { icon: 'book' } }),
    f.send(
      'setGroupAppearance',
      { id: 'work', appearance: { color: 'teal', opaque: 'replace' } },
      2,
    ),
  ]);
  assert.deepEqual(f.saved().groups[0].appearance, { color: 'teal', opaque: f.opaque });
  await f.send('setGroupAppearance', { id: 'child', appearance: { icon: 'plane', opaque: 'new' } });
  assert.deepEqual(f.saved().groups[1].appearance, { icon: 'plane' });
});
