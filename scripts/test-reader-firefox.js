import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';
import { articlePage } from './fixtures/article-page.js';

// Own profile, local article, no personal tabs or outside article requests.
const browser = new ScreenshotBrowser();
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(articlePage);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const size = { width: 360, height: 700 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 900 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-reader.log',
  );
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();
    window.readerSend = async (type, args = {}) => {
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const container = await browser.contextualIdentities.create({
      name: 'Reading',
      color: 'blue',
      icon: 'briefcase',
    });
    const tab = await browser.tabs.create({
      url: `http://127.0.0.1:${port}/story`,
      windowId,
      active: true,
      cookieStoreId: container.cookieStoreId,
    });
    const sleeping = await browser.tabs.create({
      url: `http://127.0.0.1:${port}/sleeping`,
      windowId,
      active: false,
      discarded: true,
      title: 'Sleeping article',
    });
    await readerSend('saveForLater', { id: sleeping.id });
    await readerSend('saveForLater', { id: tab.id });
    return { id: tab.id, sleeping: sleeping.id, url: tab.url, container: container.cookieStoreId };
  }, server.address().port);
  const wait = (fn, ...args) =>
    browser.driver.wait(() => browser.evaluate(fn, ...args), 15000, fn.toString());
  await wait(() => Boolean(document.querySelector('#later-toggle:not(:disabled)')));
  await browser.evaluate(() => document.getElementById('later-toggle').click());
  await wait(() => document.querySelectorAll('.later-row').length === 2);
  await wait(async (id) => (await browser.tabs.get(id)).isArticle, fixture.id);
  await wait(
    (id) =>
      Boolean(
        document.querySelector(
          `.later-row[data-id="${id}"] .later-read:not([hidden]):not(:disabled)`,
        ),
      ),
    fixture.id,
  );
  assert.equal(
    await browser.evaluate(() => browser.permissions.contains({ origins: ['http://127.0.0.1/*'] })),
    false,
  );
  // Native Reader View works before access to the article's DOM has been granted.
  await browser.evaluate(
    (id) => document.querySelector(`.later-row[data-id="${id}"] .later-read`).click(),
    fixture.id,
  );
  await wait(async (id) => (await browser.tabs.get(id)).isInReaderMode, fixture.id);
  await wait(
    (id) =>
      document.querySelector(`.later-row[data-id="${id}"] .later-read`)?.textContent ===
      'View original',
    fixture.id,
  );
  await browser.evaluate(() =>
    [...document.querySelectorAll('.later-filters button')]
      .find((button) => button.textContent === 'Articles')
      .click(),
  );
  assert.equal(await browser.evaluate(() => document.querySelectorAll('.later-row').length), 1);
  await browser.evaluate(
    (id) => document.querySelector(`.later-row[data-id="${id}"] .later-read`).click(),
    fixture.id,
  );
  await wait(
    async (id) =>
      !(await browser.tabs.get(id)).isInReaderMode &&
      (await browser.tabs.get(id)).status === 'complete',
    fixture.id,
  );

  // Grant all web origins only in this disposable profile. The UI suite verifies
  // the click request and denial. Retain a separate grant to check scoped removal.
  await browser.chrome(async () => {
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      'resource://gre/modules/ExtensionPermissions.sys.mjs',
    );
    const extension = WebExtensionPolicy.getByID('tabernacle@michaelprojects.com').extension;
    await ExtensionPermissions.add(
      'tabernacle@michaelprojects.com',
      { permissions: [], origins: ['http://*/*', 'https://*/*', 'https://kept.example.test/*'] },
      extension,
    );
  });
  await wait(
    (id) =>
      document
        .querySelector(`.later-row[data-id="${id}"] .later-article-details`)
        ?.textContent.includes('Alex Green'),
    fixture.id,
  );
  await wait(
    (id) => !document.querySelector(`.later-row[data-id="${id}"] .later-excerpt`)?.hidden,
    fixture.id,
  );
  const preview = await browser.evaluate(
    async (id) => browser.sessions.getTabValue(id, 'tabernacle.article.v1'),
    fixture.id,
  );
  assert.equal(preview.title, 'A neighbourhood orchard');
  assert(preview.words > 500);
  assert(!('textContent' in preview));
  assert(!('content' in preview));
  const source = await browser.evaluate(
    async (id) =>
      (
        await browser.scripting.executeScript({
          target: { tabId: id },
          func: () => ({
            paragraphs: document.querySelectorAll('article p').length,
            navigation: Boolean(document.querySelector('nav')),
          }),
        })
      )[0].result,
    fixture.id,
  );
  assert.equal(source.paragraphs, 9);
  assert.equal(source.navigation, true);
  await browser.evaluate(
    (id) => document.querySelector(`.later-row[data-id="${id}"] .later-read`).click(),
    fixture.id,
  );
  await wait(async (id) => (await browser.tabs.get(id)).isInReaderMode, fixture.id);
  await wait(
    (id) =>
      document
        .querySelector(`.later-row[data-id="${id}"] .later-domain`)
        ?.textContent.includes('Reader View'),
    fixture.id,
  );
  assert.equal(
    await browser.evaluate(
      (id) => document.querySelector(`.later-row[data-id="${id}"] .later-excerpt`).hidden,
      fixture.id,
    ),
    false,
  );
  // A sidebar reload in Reader View must hydrate the preview without injecting into about:reader.
  await browser.evaluate(() => {
    window.readerReload = true;
    setTimeout(() => location.reload(), 50);
  });
  await wait(
    () => !window.readerReload && Boolean(document.querySelector('#later-toggle:not(:disabled)')),
  );
  await browser.evaluate(() => document.getElementById('later-toggle').click());
  await wait(
    (id) =>
      document
        .querySelector(`.later-row[data-id="${id}"] .later-article-details`)
        ?.textContent.includes('Alex Green'),
    fixture.id,
  );
  assert.equal(
    await browser.evaluate(() =>
      browser.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }),
    ),
    true,
  );
  await wait(() => document.querySelector('.later-preview-status')?.textContent === 'All sites');
  const native = await browser.evaluate(async (id) => browser.tabs.get(id), fixture.id);
  assert.equal(native.cookieStoreId, fixture.container);
  assert.equal(
    await browser.evaluate(async (id) => (await browser.tabs.get(id)).discarded, fixture.sleeping),
    true,
  );
  assert(!requests.some((path) => path.startsWith('/sleeping')));
  await writeFile(
    'test-results/reader-firefox-360.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  await browser.evaluate(() => {
    document.querySelector('.later-preview-options').open = true;
    document.querySelector('.later-preview-access').click();
  });
  await wait(() => document.querySelector('.later-preview-status')?.textContent === 'Set up');
  assert.equal(
    await browser.evaluate(() =>
      browser.permissions.contains({ origins: ['https://kept.example.test/*'] }),
    ),
    true,
  );
  assert.equal(
    await browser.evaluate(() => browser.permissions.contains({ origins: ['http://127.0.0.1/*'] })),
    false,
  );
  await wait(
    (id) => document.querySelector(`.later-row[data-id="${id}"] .later-excerpt`)?.hidden,
    fixture.id,
  );
  assert.equal(
    await browser.evaluate(
      (id) => document.querySelector(`.later-row[data-id="${id}"] .later-read`).hidden,
      fixture.id,
    ),
    false,
  );
  console.log(
    '✓ Native Firefox: Reader View without site access, bundled extraction, unchanged source, containers, cached Reader View previews across sidebar reload, all-site grant persistence, scoped removal and sleeping tabs',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
