import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';

function fixture(t) {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0 },
      { id: 2, windowId: 2, index: 0 },
    ],
  });
  for (const id of [1, 2])
    api.testing.windowValues.set(id, {
      scopeId: null,
      collapsed: [],
      opaque: { window: id, version: 99 },
      recentFolders: [{ id: 'work', enteredAt: 1000, opaque: { window: id } }],
      recentExpandedFolders: [{ id: 'work', expandedAt: 1000, opaque: { window: id } }],
    });
  let controller = createController(api);
  t.after(() => controller.dispose());
  return {
    api,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),

    async restart() {
      await controller.dispose();
      controller = createController(api);
    },
  };
}

function assertMetadata(api, windowId) {
  const view = api.testing.windowValues.get(windowId);
  assert.deepEqual(view.opaque, { window: windowId, version: 99 });
  for (const key of ['recentFolders', 'recentExpandedFolders'])
    assert.deepEqual(view[key].find((item) => item.id === 'work').opaque, { window: windowId });
}

test('window view and retained activity metadata survive navigation, expansion and restart', async (t) => {
  const { api, send, restart } = fixture(t);
  const before = structuredClone(api.testing.windowValues);
  await send('snapshot');
  assert.deepEqual(api.testing.windowValues, before, 'A read must not rewrite the saved view');
  await send('toggleGroup', { id: 'work' });
  assertMetadata(api, 1);
  await send('enterGroup', { id: 'work' });
  await send('toggleGroup', { id: 'work' });
  assertMetadata(api, 1);
  const first = structuredClone(api.testing.windowValues.get(1));
  assert(first.recentFolders[0].enteredAt > 1000);
  assert(first.recentExpandedFolders[0].expandedAt > 1000);
  await send('enterGroup', { id: 'other' }, 2);
  assert.deepEqual(api.testing.windowValues.get(1), first);
  assertMetadata(api, 2);
  await restart();
  await send('enterGroup', { id: 'other' });
  assertMetadata(api, 1);
  assertMetadata(api, 2);
});

test('failed view reads/writes and lost write responses preserve metadata for restart and retry', async (t) => {
  const { api, send, restart } = fixture(t);
  const before = structuredClone(api.testing.windowValues);
  const get = api.sessions.getWindowValue;
  api.sessions.getWindowValue = async () => {
    throw new Error('Read unavailable');
  };
  await assert.rejects(send('enterGroup', { id: 'work' }), /Read unavailable/);
  assert.deepEqual(api.testing.windowValues, before);
  api.sessions.getWindowValue = get;
  const set = api.sessions.setWindowValue;
  api.sessions.setWindowValue = async () => {
    throw new Error('Write unavailable');
  };
  await assert.rejects(send('enterGroup', { id: 'work' }), /Write unavailable/);
  assert.deepEqual(api.testing.windowValues, before);
  let loseReply = true;
  api.sessions.setWindowValue = async (...args) => {
    await set(...args);
    if (loseReply) {
      loseReply = false;
      throw new Error('Reply lost');
    }
  };
  await assert.rejects(send('enterGroup', { id: 'work' }), /Reply lost/);
  assertMetadata(api, 1);
  const committed = structuredClone(api.testing.windowValues.get(1));
  await restart();
  await send('enterGroup', { id: 'work' });
  assert.deepEqual(api.testing.windowValues.get(1), committed);
  assertMetadata(api, 2);
});
