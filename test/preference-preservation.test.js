import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, VIEW_KEY } from '../extension/src/model.js';
import { normalizeLook } from '../extension/src/look.js';
import { normalizeNewTab } from '../extension/src/new-tab/preferences.js';
import { pinMoveMessage } from './helpers/pin-move.js';

function fixture(t, { invalidLinks = false } = {}) {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'First window' },
      { id: 2, windowId: 2, index: 0, title: 'Second window' },
    ],
  });
  const raw = api.testing.saved[MODEL_KEY];
  raw.look = {
    ...normalizeLook(),
    sidebarSize: 'future-size',
    themeSource: 'firefox',
    future: { version: 99, values: ['keep'] },
  };
  raw.newTab = {
    ...normalizeNewTab(),
    unit: 'future-unit',
    showLater: true,
    future: { version: 99, values: ['keep'] },
    links: [
      { id: 'one', name: 'Example', url: 'https://example.test/', future: { retained: true } },
    ],
    location: { name: 'Place', latitude: 50, longitude: 1, future: { retained: true } },
  };
  if (invalidLinks)
    raw.newTab.links.push({
      id: 'unsupported',
      name: 'Future link',
      url: 'future:address',
      future: { retained: true },
    });
  const before = structuredClone(raw);
  let controller = createController(api);
  t.after(() => controller.dispose());
  return {
    api,
    before,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),

    async restart() {
      await controller.dispose();
      controller = createController(api);
    },
  };
}

function expectedPreferences(before) {
  const look = structuredClone(before.look);
  delete look.themeSource;
  const newTab = structuredClone(before.newTab);
  delete newTab.showLater;
  return { look, newTab };
}

function assertPreferences(api, expected) {
  assert.deepEqual(api.testing.saved[MODEL_KEY].look, expected.look);
  assert.deepEqual(api.testing.saved[MODEL_KEY].newTab, expected.newTab);
}

test('unrelated folder writes and restarts preserve raw preferences without exposing them to views', async (t) => {
  const { api, before, send, restart } = fixture(t);
  for (const windowId of [1, 2]) {
    const state = await send('getSettings', {}, windowId);
    assert.deepEqual(state.look, normalizeLook(before.look));
    assert.deepEqual(state.newTab, normalizeNewTab(before.newTab));
  }
  assert.deepEqual(api.testing.saved[MODEL_KEY], before, 'Loading must not rewrite existing data');
  await send('renameGroup', { id: 'work', name: 'Renamed' });
  const expected = expectedPreferences(before);
  assertPreferences(api, expected);
  await restart();
  await send('createGroup', { name: 'Another folder' }, 2);
  assertPreferences(api, expected);
  assert.deepEqual((await send('getSettings')).newTab, normalizeNewTab(before.newTab));
});

test('partial preference edits and retained link edits preserve unknown values and metadata', async (t) => {
  const { api, before, send, restart } = fixture(t);
  const expected = expectedPreferences(before);
  await send('setLook', { partial: true, value: { domains: true } });
  expected.look.domains = true;
  assertPreferences(api, expected);
  await send('setNewTab', { value: { showRecent: false } }, 2);
  expected.newTab.showRecent = false;
  assertPreferences(api, expected);
  const state = await send('getSettings');
  await send('setNewTab', {
    value: { links: [{ ...state.newTab.links[0], name: 'Renamed link' }] },
  });
  expected.newTab.links[0].name = 'Renamed link';
  assertPreferences(api, expected);
  await send('setNewTab', {
    value: { location: { name: 'Another place', latitude: 51, longitude: 2 } },
  });
  Object.assign(expected.newTab.location, { name: 'Another place', latitude: 51, longitude: 2 });
  assertPreferences(api, expected);
  await send('setLook', { partial: true, value: { sidebarSize: 'large' } }, 2);
  expected.look.sidebarSize = 'large';
  await send('setNewTab', { value: { unit: 'fahrenheit', links: [] } });
  expected.newTab.unit = 'fahrenheit';
  expected.newTab.links = [];
  assertPreferences(api, expected);
  await restart();
  assert.deepEqual((await send('getSettings', {}, 2)).look, normalizeLook(expected.look));
  assertPreferences(api, expected);
});

test('failed reads, failed writes and lost write responses leave opaque preferences retryable', async (t) => {
  const { api, before, send, restart } = fixture(t);
  const get = api.storage.local.get;
  api.storage.local.get = async () => {
    throw new Error('Read failed');
  };
  await assert.rejects(send('renameGroup', { id: 'work', name: 'No change' }), /Read failed/);
  assert.deepEqual(api.testing.saved[MODEL_KEY], before);
  api.storage.local.get = get;
  await send('getSettings');
  const set = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Write failed');
  };
  await assert.rejects(
    send('setLook', { partial: true, value: { domains: true } }),
    /Write failed/,
  );
  assert.deepEqual(api.testing.saved[MODEL_KEY], before);
  assert.equal((await send('getSettings', {}, 2)).look.domains, false);
  api.storage.local.set = set;
  await send('renameGroup', { id: 'work', name: 'Renamed' });
  const expected = expectedPreferences(before);
  assertPreferences(api, expected);
  let loseResponse = true;
  api.storage.local.set = async (value) => {
    await set(value);
    if (Object.hasOwn(value, MODEL_KEY) && loseResponse) {
      loseResponse = false;
      throw new Error('Write response lost');
    }
  };
  await assert.rejects(
    send('setLook', { partial: true, value: { domains: true } }),
    /Write response lost/,
  );
  expected.look.domains = true;
  assertPreferences(api, expected);
  await restart();
  await send('setLook', { partial: true, value: { domains: true } }, 2);
  await send('setNewTab', { value: { showSearch: false } });
  expected.newTab.showSearch = false;
  assertPreferences(api, expected);
});

test('unsupported saved links survive unrelated writes and cannot be silently replaced by a filtered list', async (t) => {
  const { api, before, send, restart } = fixture(t, { invalidLinks: true });
  const state = await send('getSettings');
  assert.equal(state.newTab.links.length, 1);
  await send('renameGroup', { id: 'work', name: 'Renamed' });
  const expected = expectedPreferences(before);
  assertPreferences(api, expected);
  await send('setNewTab', { value: { showFolders: false } });
  expected.newTab.showFolders = false;
  assertPreferences(api, expected);
  await assert.rejects(
    send('setNewTab', { value: { links: state.newTab.links } }),
    /saved.*links|unsupported/i,
  );
  assertPreferences(api, expected);
  await restart();
  assert.equal((await send('getSettings')).newTab.links.length, 1);
  assertPreferences(api, expected);
});

test('journalled folder-pin ordering preserves raw preferences through a failed layout and restart', async (t) => {
  const { api, before, send, restart } = fixture(t);
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('setGroupPin', { id: 'other', action: 'open' });
  const state = await send('snapshot');
  const message = pinMoveMessage(
    state,
    { kind: 'group', id: 'other' },
    { kind: 'group', id: 'work' },
  );
  const setView = api.sessions.setWindowValue;
  api.sessions.setWindowValue = async (...args) => {
    if (args[1] === VIEW_KEY) throw new Error('Layout unavailable');
    return setView(...args);
  };
  await assert.rejects(send('moveItem', message), /could not finish recovery/);
  api.sessions.setWindowValue = setView;
  await restart();
  await send('snapshot');
  assertPreferences(api, expectedPreferences(before));
  await send('moveItem', message);
  assertPreferences(api, expectedPreferences(before));
});
