import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ScreenshotBrowser } from "../../scripts/screenshot-browser.js";

const browser = new ScreenshotBrowser();
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Collection fixture</title><p>Local collection test</p>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const setup = async () =>
  browser.evaluate(async () => {
    const { id: windowId } = await browser.windows.getCurrent();
    window.collectionSend = async (type, args = {}) => {
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
    window.collectionTarget = (tab) => ({
      id: tab.id,
      treeId: tab.treeId,
      url: tab.url,
      groupId: tab.groupId,
      cookieStoreId: tab.cookieStoreId || 'firefox-default',
    });
  });
const wait = (fn, ...args) =>
  browser.driver.wait(() => browser.evaluate(fn, ...args), 15000, fn.toString());

try {
  await browser.open(
    {
      window: { width: 1100, height: 900 },
      sidebarWidth: 320,
      capture: { sourceSize: { width: 320, height: 700 } },
    },
    'test-results/firefox-tab-collection.log',
  );
  await setup();
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();
    const folder = (await collectionSend('createGroup', { name: 'Collection' })).createdGroupId;
    const container = await browser.contextualIdentities.create({
      name: 'Collection test',
      color: 'blue',
      icon: 'briefcase',
    });
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const tab = await browser.tabs.create({
        windowId,
        url: `http://127.0.0.1:${port}/${i === 3 ? 'other' : 'same'}`,
        cookieStoreId: i === 2 ? container.cookieStoreId : 'firefox-default',
        active: false,
      });
      await collectionSend('moveTab', { id: tab.id, groupId: folder });
      tabs.push(tab.id);
    }
    await collectionSend('enterGroup', { id: folder });
    return { tabs, folder, container: container.cookieStoreId };
  }, server.address().port);
  await wait(
    async (ids) =>
      (await browser.tabs.query({ currentWindow: true }))
        .filter((tab) => ids.includes(tab.id))
        .every((tab) => tab.status === 'complete'),
    fixture.tabs,
  );
  await browser.evaluate(() => {
    document.getElementById('search-toggle').click();
    const input = document.getElementById('search');
    input.value = 'same';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() => document.querySelectorAll('#tree .tab-row').length === 3);
  // A native close redirects to an actual match, within the search results.
  await browser.evaluate(async (ids) => {
    await browser.tabs.update(ids[0], { active: true, successorTabId: ids[3] });
    await browser.tabs.remove(ids[0]);
  }, fixture.tabs);
  await wait(() => document.querySelectorAll('#tree .tab-row').length === 2);
  await wait(
    async (ids) =>
      ids
        .slice(1, 3)
        .includes((await browser.tabs.query({ active: true, currentWindow: true }))[0].id),
    fixture.tabs,
  );
  const restored = await browser.evaluate(() => collectionSend('undoCloseTab'));
  const restoredId = restored.restoredTabId;
  assert.equal(restored.tabs.find((tab) => tab.id === restoredId).groupId, fixture.folder);
  await browser.evaluate(() => {
    window.collectionReloadMarker = true;
  });
  await browser.reloadSidebar();
  await wait(
    () => !window.collectionReloadMarker && Boolean(document.querySelector('#tree .tab-row')),
  );
  await setup();
  let snapshot = await browser.evaluate(() => collectionSend('snapshot'));
  assert.equal(snapshot.tabs.filter((tab) => tab.groupId === fixture.folder).length, 4);
  assert.equal(snapshot.tabs.find((tab) => tab.id === fixture.tabs[2]).cookieStoreId, fixture.container);
  // Same URL in a different container cannot serve as the duplicate keeper.
  const wrong = await browser.evaluate(
    async (targetId, keeperId) => {
      const state = await collectionSend('snapshot');
      return collectionSend('closeDuplicateTabs', {
        scope: { kind: 'window' },
        targets: [collectionTarget(state.tabs.find((tab) => tab.id === targetId))],
        keepers: [collectionTarget(state.tabs.find((tab) => tab.id === keeperId))],
      });
    },
    restoredId,
    fixture.tabs[2],
  );
  assert.deepEqual(wrong.batchResult.skipped, [restoredId]);
  const closed = await browser.evaluate(
    async (targetId, keeperId) => {
      const state = await collectionSend('snapshot');
      return collectionSend('closeDuplicateTabs', {
        scope: { kind: 'window' },
        targets: [collectionTarget(state.tabs.find((tab) => tab.id === targetId))],
        keepers: [collectionTarget(state.tabs.find((tab) => tab.id === keeperId))],
      });
    },
    restoredId,
    fixture.tabs[1],
  );
  assert.deepEqual(closed.batchResult.completed, [restoredId]);
  snapshot = await browser.evaluate(() => collectionSend('snapshot'));
  assert(snapshot.tabs.some((tab) => tab.id === fixture.tabs[1]));
  assert(snapshot.tabs.some((tab) => tab.id === fixture.tabs[2]));
  console.log(
    '✓ Native Firefox: search, native closure/restoration, reload persistence and duplicate container boundaries',
  );
} finally {
  try {
    await browser.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
