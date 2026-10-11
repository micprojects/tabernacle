import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { internalPage } from '../extension/src/internal-pages.js';
import { memoryBrowser } from '../preview/browser.js';
import { TAB_KEY } from '../extension/src/model.js';

const getURL = (path) => `moz-extension://tabernacle-test/${path}`;

function setup() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, url: 'https://example.com', active: true },
      { id: 2, windowId: 2, url: 'https://example.org', active: true },
    ],
  });
  api.runtime = { getURL };
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  return { api, controller, send };
}

test('concurrent Settings launches reuse one page across windows without resetting its URL', async () => {
  const { api, controller, send } = setup();
  const opened = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      send('openPage', { page: 'settings', windowId: index % 2 ? 2 : 1 }),
    ),
  );
  assert.equal(new Set(opened.map(({ tabId }) => tabId)).size, 1);
  const { tabId } = opened[0];
  await api.tabs.update(tabId, { url: `${getURL('settings.html')}?source=options#containers` });
  await api.tabs.update(1, { active: true });
  assert.deepEqual(await send('openPage', { page: 'settings', windowId: 2 }), { tabId });
  const tab = await api.tabs.get(tabId);
  assert.equal(tab.url, `${getURL('settings.html')}?source=options#containers`);
  assert.equal(tab.active, true);
  assert.equal((await api.windows.get(1)).focused, true);
  assert.equal((await api.tabs.query({})).length, 3);
  controller.dispose();
});

test('History reuses its page only in the relevant window', async () => {
  const { api, controller, send } = setup();
  const first = await send('openPage', { page: 'activity' });
  await api.tabs.update(first.tabId, { url: `${getURL('activity.html')}?layout=detail#closed` });
  const second = await send('openPage', { page: 'activity', windowId: 2 });
  assert.notEqual(first.tabId, second.tabId);
  assert.deepEqual(await send('openPage', { page: 'activity' }), first);
  assert.equal(
    (await api.tabs.get(first.tabId)).url,
    `${getURL('activity.html')}?layout=detail#closed`,
  );
  controller.dispose();
});

test('a new native options page hands back to the existing Settings page', async () => {
  const { api, controller, send } = setup();
  const first = await send('openPage', { page: 'settings' });
  await api.tabs.update(first.tabId, { url: `${getURL('settings.html')}#containers` });
  await api.tabs.update(1, { active: true });
  // Reloading the owner in the background must not steal focus.
  assert.deepEqual(await send('claimSettingsPage', { id: first.tabId }), first);
  assert.equal((await api.tabs.get(1)).active, true);
  const duplicate = await api.tabs.create({
    windowId: 2,
    url: getURL('settings.html'),
    active: true,
  });
  assert.deepEqual(await send('claimSettingsPage', { id: duplicate.id, windowId: 2 }), first);
  assert.equal((await api.tabs.get(first.tabId)).active, true);
  assert.equal((await api.tabs.get(first.tabId)).url, `${getURL('settings.html')}#containers`);
  await assert.rejects(send('claimSettingsPage', { id: 1 }), /Not a Settings page/);
  await assert.rejects(send('claimSettingsPage', { id: duplicate.id }), /another window/);
  controller.dispose();
});

test('internal pages stay out of folders, tree snapshots and closed history', async () => {
  const { api, controller, send } = setup();
  await send('enterGroup', { id: 'work' });
  const pages = await Promise.all(
    ['settings', 'activity'].map((page) => send('openPage', { page })),
  );
  for (const { tabId } of pages) {
    await controller.created(await api.tabs.get(tabId));
    assert.equal(await api.sessions.getTabValue(tabId, TAB_KEY), undefined);
  }
  const snapshot = await send('snapshot');
  assert.deepEqual(
    snapshot.tabs.map(({ id }) => id),
    [1],
  );
  assert.equal(snapshot.view.scopeId, 'work');
  assert.deepEqual((await send('getGroupContents', { id: 'work' })).tabIds, []);
  await api.tabs.remove(pages.map(({ tabId }) => tabId));
  const closed = await send('snapshot');
  assert.deepEqual(closed.recentlyClosed, []);
  assert.equal(closed.canUndoClose, false);
  await api.tabs.remove(1);
  assert.equal((await send('snapshot')).recentlyClosed[0].url, 'https://example.com');
  assert.equal(internalPage(api, 'https://example.com/settings.html'), null);
  assert.equal(internalPage(api, 'moz-extension://another-extension/settings.html'), null);
  assert.equal(internalPage(api, `${getURL('settings.html')}/other`), null);
  controller.dispose();
});

test('existing pages survive a controller restart; closed or navigated pages are recreated', async () => {
  const { api, controller, send } = setup();
  const first = await send('openPage', { page: 'settings' });
  controller.dispose();
  const restarted = createController(api);
  const open = () => restarted.request({ type: 'openPage', page: 'settings', windowId: 1 });
  assert.deepEqual(await open(), first);
  await api.tabs.update(first.tabId, { url: 'https://example.net' });
  const second = await open();
  assert.notEqual(second.tabId, first.tabId);
  assert.equal((await api.tabs.get(first.tabId)).url, 'https://example.net');
  assert.ok(
    (await restarted.request({ type: 'snapshot', windowId: 1 })).tabs.some(
      (tab) => tab.id === first.tabId,
    ),
  );
  await api.tabs.remove(second.tabId);
  assert.notEqual((await open()).tabId, second.tabId);
  restarted.dispose();
});

test('a close during activation recovers; other failures and invalid pages are reported', async () => {
  const { api, controller, send } = setup();
  const first = await send('openPage', { page: 'settings' });
  const update = api.tabs.update;
  api.tabs.update = async (id, changes) => {
    if (id === first.tabId) await api.tabs.remove(id);
    return update(id, changes);
  };
  const second = await send('openPage', { page: 'settings' });
  assert.notEqual(second.tabId, first.tabId);
  api.tabs.update = async () => {
    throw new Error('Activation failed');
  };
  await assert.rejects(send('openPage', { page: 'settings' }), /Activation failed/);
  await assert.rejects(send('openPage', { page: '../other.html' }), /Unknown Tabernacle page/);
  await assert.rejects(send('openPage', { page: 'constructor' }), /Unknown Tabernacle page/);
  assert.equal((await api.tabs.query({})).length, 3);
  api.tabs.update = update;
  assert.deepEqual(await send('openPage', { page: 'settings' }), second);
  controller.dispose();
});
