import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';

const browser = new ScreenshotBrowser();
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    `<!doctype html><title>Saved page ${request.url}</title><p>Local Saved for Later test</p>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const size = { width: 360, height: 680 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 850 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-later.log',
  );
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();
    window.laterSend = async (type, args = {}) => {
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
    const folder = (await laterSend('createGroup', { name: 'Reading' })).createdGroupId;
    const container = await browser.contextualIdentities.create({
      name: 'Saved test',
      color: 'blue',
      icon: 'briefcase',
    });
    const parent = await browser.tabs.create({
      windowId,
      url: `http://127.0.0.1:${port}/blog/parent`,
      cookieStoreId: container.cookieStoreId,
      active: false,
    });
    await laterSend('moveTab', { id: parent.id, groupId: folder });
    const child = await browser.tabs.create({
      windowId,
      url: `http://127.0.0.1:${port}/blog/child`,
      active: false,
    });
    await laterSend('nestTab', { id: child.id, parentTabId: parent.id });
    const second = await browser.tabs.create({
      windowId,
      url: `http://127.0.0.1:${port}/blog/second`,
      active: false,
    });
    await laterSend('moveTab', { id: second.id, groupId: folder });
    await laterSend('enterGroup', { id: folder });
    return {
      parent: parent.id,
      child: child.id,
      second: second.id,
      folder,
      container: container.cookieStoreId,
    };
  }, server.address().port);
  const wait = (fn, ...args) =>
    browser.driver.wait(() => browser.evaluate(fn, ...args), 10000, fn.toString());
  await wait(
    (id) => Boolean(document.querySelector(`#tree .tab-row[data-id="${id}"]`)),
    fixture.parent,
  );
  await browser.evaluate((id) => {
    document
      .querySelector(`#tree .tab-row[data-id="${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 140 }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Save for later')
      .click();
  }, fixture.parent);
  await wait((id) => !document.querySelector(`#tree .tab-row[data-id="${id}"]`), fixture.parent);
  assert(
    await browser.evaluate(
      (id) => Boolean(document.querySelector(`#tree .tab-row[data-id="${id}"]`)),
      fixture.child,
    ),
  );
  await browser.evaluate(async (id) => {
    await laterSend('saveForLater', { id });
    document.getElementById('later-toggle').click();
  }, fixture.second);
  await wait(() => document.querySelectorAll('#later-view .later-row').length === 2);
  assert.deepEqual(
    await browser.evaluate(() =>
      [...document.querySelectorAll('footer button')].map((button) => button.id),
    ),
    [
      'new-tab',
      'new-group',
      'tree-toggle',
      'later-toggle',
      'domains-toggle',
      'recently-closed-toggle',
      'settings',
    ],
  );
  await browser.evaluate(
    (id) =>
      document.querySelector(`#later-view .later-row[data-id="${id}"] .later-open-tab`).click(),
    fixture.parent,
  );
  await wait(async (id) => (await browser.tabs.get(id)).active, fixture.parent);
  let snapshot = await browser.evaluate(() => laterSend('snapshot'));
  assert.equal(
    snapshot.tabs.find((tab) => tab.id === fixture.parent).cookieStoreId,
    fixture.container,
  );
  assert(snapshot.tabs.find((tab) => tab.id === fixture.parent).savedForLaterAt > 0);
  await browser.evaluate(() =>
    [...document.querySelectorAll('.later-filters button')]
      .find((button) => button.textContent === 'Articles')
      .click(),
  );
  assert.equal(
    await browser.evaluate(() => document.querySelectorAll('#later-view .later-row').length),
    2,
  );
  // Reload the real sidebar; the queue belongs to tab sessions, not the page.
  await browser.evaluate(() => {
    window.laterReloadMarker = true;
    setTimeout(() => location.reload(), 50);
  });
  await wait(
    () =>
      !window.laterReloadMarker && Boolean(document.querySelector('#later-toggle:not(:disabled)')),
  );
  await browser.evaluate(async () => {
    const { id: windowId } = await browser.windows.getCurrent();
    window.laterSend = async (type, args = {}) => {
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
  });
  await browser.evaluate(() => document.getElementById('later-toggle').click());
  await wait(() => document.querySelectorAll('#later-view .later-row').length === 2);
  await writeFile(
    'test-results/later-firefox-360.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  await browser.evaluate(
    (id) =>
      document
        .querySelector(
          `#later-view .later-row[data-id="${id}"] button[aria-label="Return to Reading"]`,
        )
        .click(),
    fixture.parent,
  );
  await wait(() => document.querySelectorAll('#later-view .later-row').length === 1);
  snapshot = await browser.evaluate(() => laterSend('snapshot'));
  assert.equal(snapshot.tabs.find((tab) => tab.id === fixture.child).parentTabId, fixture.parent);
  assert.equal(snapshot.tabs.find((tab) => tab.id === fixture.parent).savedForLaterAt, undefined);
  await wait(() => document.querySelectorAll('#later-view .later-row').length === 1);
  await browser.evaluate(
    async (saved, parent, outside) => {
      await laterSend('saveForLater', { id: parent });
      await browser.tabs.update(saved, { active: true, successorTabId: outside });
    },
    fixture.second,
    fixture.parent,
    fixture.child,
  );
  await wait(() => document.querySelectorAll('#later-view .later-row').length === 2);
  await browser.evaluate(
    (id) =>
      document
        .querySelector(`#later-view .later-row[data-id="${id}"] button[aria-label="Close tab"]`)
        .click(),
    fixture.second,
  );
  await wait(
    (id) => !document.querySelector(`#later-view .later-row[data-id="${id}"]`),
    fixture.second,
  );
  assert(await browser.evaluate(async (id) => (await browser.tabs.get(id)).active, fixture.parent));
  assert.equal(
    await browser.evaluate(() => document.getElementById('toast').classList.contains('error')),
    false,
  );
  console.log(
    '✓ Native Firefox: save, child promotion, containers, filters, sidebar reload, return and close',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
