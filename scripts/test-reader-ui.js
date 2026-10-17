import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';
import { articlePage } from './fixtures/article-page.js';
import { readArticle } from '../extension/src/article.js';

const { page, base, close } = await startUiTest({ viewport: { width: 400, height: 740 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const url = 'https://news.example.test/story/1';
try {
  const sourceContext = await page.context().browser().newContext();
  const source = await sourceContext.newPage();
  await source.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: articlePage }),
  );
  await source.goto(url);
  for (const name of ['Readability.js', 'Readability-readerable.js'])
    await source.addScriptTag({ path: `extension/vendor/readability/${name}` });
  const before = await source.locator('body').innerHTML();
  const data = await source.evaluate(({ code, url }) => new Function(`return (${code})`)()(url), {
    code: readArticle.toString(),
    url,
  });
  expect(data.title).toBe('A neighbourhood orchard');
  expect(data.byline).toBe('Alex Green');
  expect(data.words).toBeGreaterThan(500);
  expect(data.excerpt).toContain('shared orchard');
  expect(data.published).toContain('2026-10-17');
  expect(await source.locator('body').innerHTML()).toBe(before);
  expect(Object.keys(data).sort()).toEqual([
    'byline',
    'excerpt',
    'published',
    'title',
    'url',
    'words',
  ]);
  await source.setContent('<title>Sign in</title><form><input><button>Continue</button></form>');
  expect(
    await source.evaluate(({ code, url }) => new Function(`return (${code})`)()(url), {
      code: readArticle.toString(),
      url,
    }),
  ).toBeNull();
  await source.close();
  await sourceContext.close();

  await page.addInitScript(
    ({ data }) => {
      const event = () => {
        const listeners = new Set();
        return {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),

          emit: () => {
            for (const fn of listeners) fn();
          },
        };
      };

      window.articleTest = {
        data,
        granted: false,
        deny: true,
        calls: [],
        requests: [],
        removals: [],
        saved: {},
        added: event(),
        removed: event(),
      };
      window.browser = {
        permissions: {
          contains: async () => articleTest.granted,

          request: async (request) => {
            articleTest.requests.push(request);
            if (articleTest.deny) return false;
            articleTest.granted = true;
            articleTest.added.emit();
            return true;
          },

          remove: async (request) => {
            articleTest.removals.push(request);
            articleTest.granted = false;
            articleTest.removed.emit();
            return true;
          },

          onAdded: articleTest.added,
          onRemoved: articleTest.removed,
        },
        tabs: { get: async (id) => laterTest.api.tabs.get(id) },
        sessions: {
          getTabValue: async (id) => articleTest.saved[id],

          setTabValue: async (id, key, value) => {
            articleTest.saved[id] = value;
          },
        },
        scripting: {
          executeScript: async ({ target, files }) => {
            articleTest.calls.push({ id: target.tabId, files: Boolean(files) });
            return files
              ? []
              : [
                  {
                    result: [1, 4].includes(target.tabId)
                      ? {
                          ...articleTest.data,
                          url: (await laterTest.api.tabs.get(target.tabId)).url,
                        }
                      : null,
                  },
                ];
          },
        },
      };
    },
    { data },
  );
  const demo = await readFile('preview/demo.js', 'utf8');
  await page.route('**/preview/demo.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: demo
        .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
        .replace(
          'return controller;',
          `
      api.tabs.toggleReaderMode = async (id) => {
        const tab = await api.tabs.get(id);
        await api.tabs.update(id, {
          url: tab.isInReaderMode ? ${JSON.stringify(url)} : 'about:reader?url=' + encodeURIComponent(tab.url),
          isInReaderMode: !tab.isInReaderMode, status: 'complete',
        });
      };
      window.laterTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) };
      return controller;`,
        ),
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('#later-toggle')).toBeEnabled();
  await page.evaluate(async (url) => {
    await laterTest.api.tabs.update(1, {
      url,
      title: 'Field Notes',
      isArticle: true,
      status: 'complete',
    });
    await laterTest.api.tabs.update(2, {
      url: 'https://news.example.test/story/2',
      title: 'Sleeping article',
      discarded: true,
      isArticle: false,
    });
    await laterTest.api.tabs.update(3, {
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'A video',
      isArticle: false,
    });
    for (const id of [3, 2, 1]) await laterTest.send('saveForLater', { id });
  }, url);
  await page.locator('#later-toggle').click();
  const row = page.locator('.later-row[data-id="1"]');
  const read = row.getByRole('button', { name: 'Read in Reader View', exact: true });
  const options = page.locator('.later-preview-options');
  const summary = options.locator('summary');
  const enable = options.getByRole('button', { name: 'Enable previews on all sites', exact: true });
  await expect(read).toBeVisible();
  await expect(options).not.toHaveAttribute('open');
  await expect(page.getByRole('button', { name: 'Show article preview', exact: true })).toHaveCount(
    0,
  );
  await expect(row.locator('.later-excerpt')).toBeHidden();
  expect(await page.evaluate(() => articleTest.calls)).toEqual([]);
  expect(await page.evaluate(() => articleTest.requests)).toEqual([]);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(enable).toBeVisible();
  for (const width of [320, 220]) {
    await page.setViewportSize({ width, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `test-results/reader-setup-${width}.png` });
  }
  await page.setViewportSize({ width: 400, height: 740 });
  await enable.click();
  await expect(page.locator('#toast')).toContainText('Previews were not enabled');
  await expect(options).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  expect(await page.evaluate(() => articleTest.calls)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('#later-toggle').click();
  await expect(options).not.toHaveAttribute('open');
  expect(await page.evaluate(() => articleTest.requests)).toHaveLength(1);
  await page.evaluate(() => {
    articleTest.deny = false;
  });
  await summary.click();
  await enable.click();
  await expect(row.locator('.later-label')).toHaveText('A neighbourhood orchard');
  await expect(row.locator('.later-excerpt')).toContainText('shared orchard');
  await expect(row.locator('.later-article-details')).toContainText('Alex Green');
  await expect(row.locator('.later-article-details')).toContainText('min read');
  await expect(options).not.toHaveAttribute('open');
  await expect(summary).toContainText('All sites');
  await expect(page.locator('#toast')).toHaveText('Article previews enabled on all sites.');
  await expect(page.locator('#toast')).not.toHaveClass(/error/);
  expect(await page.evaluate(() => articleTest.requests)).toEqual([
    { origins: ['http://*/*', 'https://*/*'] },
    { origins: ['http://*/*', 'https://*/*'] },
  ]);
  expect((await page.evaluate(() => articleTest.calls)).every(({ id }) => id === 1)).toBe(true);
  await read.focus();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('button', { name: 'View original page', exact: true })).toBeVisible();
  await expect(row.locator('.later-domain')).toHaveText('news.example.test · Reader View');
  await expect(row.locator('.later-excerpt')).toContainText('shared orchard');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await expect(page.locator('.later-row')).toHaveCount(1);
  await row.getByRole('button', { name: 'View original page', exact: true }).click();
  await expect(read).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search saved tabs' }).fill('Alex Green');
  await expect(row).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search saved tabs' }).fill('');
  await expect(page.locator('#toast')).toBeHidden({ timeout: 6000 });
  for (const width of [400, 320, 220]) {
    await page.setViewportSize({ width, height: 740 });
    expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `test-results/reader-${width}.png` });
  }
  await page.evaluate(() =>
    laterTest.send('setLook', { value: { colorScheme: 'dark' }, partial: true }),
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: 'test-results/reader-dark-320.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await row.evaluate((node) => getComputedStyle(node).forcedColorAdjust)).toBe('none');
  expect(
    await row.evaluate(
      (node) =>
        getComputedStyle(node.querySelector('.later-label')).color === getComputedStyle(node).color,
    ),
  ).toBe(true);
  expect(
    await read.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.color !== style.backgroundColor;
    }),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/reader-forced-320.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.keyboard.press('Escape');
  await page.locator('#later-toggle').click();
  await expect(row.locator('.later-excerpt')).toBeVisible();
  // A new article on another site needs no further permission request.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.evaluate(async () => {
    await laterTest.api.tabs.update(4, {
      url: 'http://another.example.test/article',
      title: 'Another site',
      isArticle: true,
      status: 'complete',
      discarded: false,
    });
    await laterTest.send('saveForLater', { id: 4 });
  });
  await expect(page.locator('.later-row[data-id="4"] .later-excerpt')).toContainText(
    'shared orchard',
  );
  expect(await page.evaluate(() => articleTest.requests)).toHaveLength(2);
  await summary.click();
  await options.getByRole('button', { name: 'Remove all-site access', exact: true }).click();
  await expect(summary).toContainText('Set up');
  expect(await page.evaluate(() => articleTest.removals)).toEqual([
    { origins: ['http://*/*', 'https://*/*'] },
  ]);
  await expect(page.locator('.later-row[data-id="4"] .later-excerpt')).toBeHidden();
  await expect(row.locator('.later-excerpt')).toBeHidden();
  await expect(options).not.toHaveAttribute('open');
  await expect(read).toBeVisible();
  await read.click();
  await expect(row.getByRole('button', { name: 'View original page', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Reader previews: real Readability extraction, unchanged source DOM, one-time all-site permission denial/grant/removal, future sites, source URLs, native controls, filters and narrow layouts',
  );
} finally {
  await close();
}
