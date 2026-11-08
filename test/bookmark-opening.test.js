import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { BOOKMARK_OPEN_KEY } from '../extension/src/controller/bookmark-actions.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'work', name: 'Work', parentId: null, defaultCookieStoreId: 'firefox-container-1' },
      { id: 'child', name: 'Child', parentId: 'work' },
    ],
    containers: [
      { cookieStoreId: 'firefox-container-1', name: 'Work', color: 'blue', icon: 'briefcase' },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, url: 'https://existing.test/', active: true },
      { id: 2, windowId: 2, index: 0, url: 'https://other.test/' },
    ],
    memberships: {
      1: { groupId: 'work', treeId: 'existing', ancestors: [] },
      2: { groupId: null, treeId: 'other', ancestors: [] },
    },
  });
  let controller = createController(api);
  api.testing.setCreatedHandler((tab) => controller.created(tab).catch(() => {}));
  return {
    api,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),

    async restart() {
      await controller.dispose();
      controller = createController(api);
    },
  };
}

const opening = (groupId = 'child') => ({
  id: 'mdn-bookmark',
  groupId,
  operationId: crypto.randomUUID(),
});

test('bookmarks open in the requested folder with its inherited container and survive restart', async () => {
  const f = fixture();
  await f.send('snapshot');
  const saved = structuredClone(f.api.testing.saved[MODEL_KEY]);
  const bookmarks = await f.api.bookmarks.getTree();
  const request = opening();
  const state = await f.send('openBookmark', request);
  const tab = state.tabs.find((tab) => tab.id === state.createdTabId);
  assert.equal(tab.url, 'https://developer.mozilla.org/');
  assert.equal(tab.groupId, 'child');
  assert.equal(tab.cookieStoreId, 'firefox-container-1');
  assert.equal(tab.active, true);
  assert.equal(tab.parentTabId, null);
  await f.restart();
  const retry = await f.send('openBookmark', request);
  assert.equal(retry.createdTabId, tab.id);
  assert.equal(retry.tabs.length, 2);
  assert.equal(retry.tabs.find((item) => item.id === tab.id).treeId, tab.treeId);
  assert.deepEqual(f.api.testing.saved[MODEL_KEY], saved);
  assert.deepEqual(await f.api.bookmarks.getTree(), bookmarks);
});

test('concurrent windows use their own destination, container and retry receipts', async () => {
  const f = fixture();
  const a = opening();
  const b = opening(null);
  const [one, two] = await Promise.all([f.send('openBookmark', a), f.send('openBookmark', b, 2)]);
  assert.equal(
    one.tabs.find((tab) => tab.id === one.createdTabId).cookieStoreId,
    'firefox-container-1',
  );
  assert.equal(
    two.tabs.find((tab) => tab.id === two.createdTabId).cookieStoreId,
    'firefox-default',
  );
  assert.equal(two.tabs.find((tab) => tab.id === two.createdTabId).groupId, null);
  await f.restart();
  assert.equal((await f.send('openBookmark', a)).createdTabId, one.createdTabId);
  assert.equal((await f.send('openBookmark', b, 2)).createdTabId, two.createdTabId);
  assert.equal((await f.api.tabs.query({})).length, 4);
});

for (const boundary of [
  'receipt-read',
  'receipt-write',
  'create',
  'marker',
  'membership',
  'placed',
  'navigate',
  'complete',
]) {
  for (const committed of [false, true]) {
    if (boundary === 'receipt-read' && committed) continue;
    test(`bookmark opening retries after ${boundary} failure${committed ? ' with lost reply' : ''} and a background restart`, async () => {
      const f = fixture();
      await f.send('snapshot');
      let owner, method, matches;
      if (boundary === 'receipt-read') {
        owner = f.api.sessions;
        method = 'getWindowValue';
        matches = (id, key) => key === BOOKMARK_OPEN_KEY;
      } else if (boundary === 'create') {
        owner = f.api.tabs;
        method = 'create';
        matches = () => true;
      } else if (boundary === 'navigate') {
        owner = f.api.tabs;
        method = 'update';
        matches = (id, change) => Boolean(change.url);
      } else if (['marker', 'membership'].includes(boundary)) {
        owner = f.api.sessions;
        method = 'setTabValue';
        matches = (id, key, value) =>
          boundary === 'marker'
            ? key === BOOKMARK_OPEN_KEY
            : key === TAB_KEY && value.groupId === 'child';
      } else {
        owner = f.api.sessions;
        method = 'setWindowValue';
        matches = (id, key, value) =>
          key === BOOKMARK_OPEN_KEY &&
          value.phase ===
            { 'receipt-write': 'pending', placed: 'placed', complete: 'complete' }[boundary];
      }
      const original = owner[method];
      let failed = false;
      owner[method] = async (...args) => {
        if (!failed && matches(...args)) {
          failed = true;
          if (committed) await original(...args);
          throw new Error('Injected bookmark failure');
        }
        return original(...args);
      };
      const request = opening();
      await assert.rejects(f.send('openBookmark', request), /Injected bookmark failure/);
      assert.equal(failed, true);
      owner[method] = original;
      await f.restart();
      const result = await f.send('openBookmark', request);
      const tab = result.tabs.find((tab) => tab.id === result.createdTabId);
      assert.equal(result.tabs.length, 2);
      assert.equal(tab.groupId, 'child');
      assert.equal(tab.cookieStoreId, 'firefox-container-1');
      assert.equal(tab.url, 'https://developer.mozilla.org/');
      assert.equal((await f.send('openBookmark', request)).tabs.length, 2);
    });
  }
}

test('unreadable bookmarks, unavailable containers, stale folders and unsupported receipts preserve data', async () => {
  const f = fixture();
  const before = await f.api.tabs.query({});
  const get = f.api.bookmarks.get;
  f.api.bookmarks.get = async () => {
    throw new Error('Could not read bookmarks');
  };
  await assert.rejects(f.send('openBookmark', opening()), /Could not read bookmarks/);
  f.api.bookmarks.get = get;
  await assert.rejects(f.send('openBookmark', opening('gone')), /folder/);
  await f.api.contextualIdentities.remove('firefox-container-1');
  await assert.rejects(f.send('openBookmark', opening()), /container is unavailable/);
  const unknown = { version: 9, opaque: { preserved: true } };
  await f.api.sessions.setWindowValue(1, BOOKMARK_OPEN_KEY, unknown);
  await assert.rejects(f.send('openBookmark', opening(null)), /unsupported/);
  assert.deepEqual(await f.api.sessions.getWindowValue(1, BOOKMARK_OPEN_KEY), unknown);
  assert.deepEqual(await f.api.tabs.query({}), before);
});

test('a completed opening never recreates a closed tab and a new click may open it again', async () => {
  const f = fixture();
  const request = opening();
  const result = await f.send('openBookmark', request);
  await f.api.tabs.remove(result.createdTabId);
  await f.restart();
  const retry = await f.send('openBookmark', request);
  assert.equal(retry.createdTabId, undefined);
  assert.equal(retry.tabs.length, 1);
  assert.equal((await f.send('openBookmark', opening())).tabs.length, 2);
});

test('an interrupted bookmark moved to another window is preserved without creating a duplicate', async () => {
  const f = fixture();
  const update = f.api.tabs.update;
  f.api.tabs.update = async (id, value) => {
    if (value.url) throw new Error('Navigation interrupted');
    return update(id, value);
  };
  const request = opening();
  await assert.rejects(f.send('openBookmark', request), /Navigation interrupted/);
  const staged = (await f.api.tabs.query({})).find((tab) =>
    tab.url.includes('tabernacle-bookmark'),
  );
  await f.api.testing.attach(staged.id, 2);
  f.api.tabs.update = update;
  await f.restart();
  await assert.rejects(f.send('openBookmark', request), /moved to another window/);
  assert.equal((await f.api.tabs.query({})).length, 3);
  assert.equal((await f.api.sessions.getWindowValue(1, BOOKMARK_OPEN_KEY)).phase, 'placed');
});

test('bookmark identity read failures and invalid model reads never start a replacement opening', async () => {
  const f = fixture();
  const request = opening();
  await f.send('openBookmark', request);
  const before = await f.api.tabs.query({});
  const read = f.api.sessions.getTabValue;
  f.api.sessions.getTabValue = async (id, key) => {
    if (key === BOOKMARK_OPEN_KEY) throw new Error('Unreadable opening marker');
    return read(id, key);
  };
  await assert.rejects(f.send('openBookmark', request), /Unreadable opening marker/);
  assert.deepEqual(await f.api.tabs.query({}), before);
  f.api.sessions.getTabValue = read;
  await f.restart();
  f.api.storage.local.get = async () => {
    throw new Error('Model read failed');
  };
  await assert.rejects(f.send('openBookmark', opening()), /Model read failed/);
  assert.deepEqual(await f.api.tabs.query({}), before);
});

test('Firefox may return an initial blank URL before exposing the requested staging fragment', async () => {
  const f = fixture();
  const create = f.api.tabs.create;
  f.api.tabs.create = async (value) => ({ ...(await create(value)), url: 'about:blank' });
  const state = await f.send('openBookmark', opening());
  assert.equal(
    state.tabs.find((tab) => tab.id === state.createdTabId).url,
    'https://developer.mozilla.org/',
  );
});
