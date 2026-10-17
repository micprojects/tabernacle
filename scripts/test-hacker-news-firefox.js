import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';

// A disposable Firefox profile maps the HN hostname to this local fixture.
// Neither the story nor its linked article makes an external request.
const browser = new ScreenshotBrowser();
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  const port = server.address().port;
  if (request.url === '/article') {
    response.writeHead(302, { Location: `http://127.0.0.1:${port}/published` });
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    request.url.startsWith('/item')
      ? `<!doctype html><title>Local rendering story | Hacker News</title><table><tr id="8863" class="athing"><td><span class="titleline"><a href="http://127.0.0.1:${port}/article">Local rendering story</a></span></td></tr><tr><td><a>200 comments</a></td></tr></table>`
      : '<!doctype html><title>The publisher’s title</title><h1>Local article</h1>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 900 },
      sidebarWidth: 360,
      capture: { sourceSize: { width: 360, height: 700 } },
    },
    'test-results/firefox-hacker-news.log',
  );
  await browser.chrome(async () => {
    Services.prefs.setCharPref('network.dns.localDomains', 'news.ycombinator.com');
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      'resource://gre/modules/ExtensionPermissions.sys.mjs',
    );
    const id = 'tabernacle@michaelprojects.com';
    await ExtensionPermissions.add(
      id,
      {
        permissions: [],
        origins: [
          'http://*/*',
          'https://news.ycombinator.com/*',
          'https://hacker-news.firebaseio.com/*',
        ],
      },
      WebExtensionPolicy.getByID(id).extension,
    );
  });
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();
    const url = `http://news.ycombinator.com:${port}/item?id=8863`;
    const tab = await browser.tabs.create({ windowId, url, active: true });
    return { id: tab.id, windowId, url };
  }, server.address().port);
  const wait = (fn, ...args) =>
    browser.driver.wait(() => browser.evaluate(fn, ...args), 15000, fn.toString());
  await wait(async (id) => (await browser.tabs.get(id)).status === 'complete', fixture.id);
  await wait((id) => Boolean(document.querySelector(`#tree [data-id="${id}"]`)), fixture.id);
  await browser.evaluate((id) => {
    const row = document.querySelector(`#tree [data-id="${id}"]`);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.id);
  await wait(
    (id) => Boolean(document.querySelector(`#tree [data-id="${id}"] [data-hn-view="article"]`)),
    fixture.id,
  );
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-id="${id}"] [data-hn-view="article"]`).click(),
    fixture.id,
  );
  await wait(async (id) => {
    const tab = await browser.tabs.get(id);
    return tab.url.endsWith('/published') && tab.status === 'complete';
  }, fixture.id);
  await wait(
    (id) =>
      document
        .querySelector(`#tree [data-id="${id}"] [data-hn-view="article"]`)
        ?.getAttribute('aria-pressed') === 'true',
    fixture.id,
  );
  const state = await browser.evaluate(async ({ id, windowId }) => {
    const result = await browser.runtime.sendMessage({ type: 'tabernacle:snapshot', windowId });
    return result.data.tabs.find((tab) => tab.id === id);
  }, fixture);
  assert.equal(state.hnStory.articleUrl, `http://127.0.0.1:${server.address().port}/published`);
  assert.equal(state.hnStory.commentsUrl, fixture.url);
  assert.equal(state.hnStory.pendingArticle, undefined);
  // Recreate the sidebar's service and DOM from persisted tab state.
  await browser.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await wait((id) => Boolean(document.querySelector(`#tree [data-id="${id}"]`)), fixture.id);
  await browser.evaluate((id) => {
    const row = document.querySelector(`#tree [data-id="${id}"]`);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.id);
  await wait(
    (id) =>
      document
        .querySelector(`#tree [data-id="${id}"] [data-hn-view="article"]`)
        ?.getAttribute('aria-pressed') === 'true',
    fixture.id,
  );
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-id="${id}"] [data-hn-view="comments"]`).click(),
    fixture.id,
  );
  await wait(async ({ id, url }) => (await browser.tabs.get(id)).url === url, fixture);
  await wait(
    (id) =>
      document
        .querySelector(`#tree [data-id="${id}"] [data-hn-view="comments"]`)
        ?.getAttribute('aria-pressed') === 'true',
    fixture.id,
  );
  assert(requests.includes('/article') && requests.includes('/published'));
  console.log(
    `✓ Firefox ${browser.environment.firefox}: real HN DOM extraction, same-tab article redirect, persisted grouping after sidebar reload, and return to comments`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
