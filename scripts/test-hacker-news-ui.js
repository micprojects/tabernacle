import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 360, height: 820 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const url = 'https://news.ycombinator.com/item?id=8863';
const article = 'https://jamesfmackenzie.com/software-rendering';
const entries = [
  ['I love software rendering | Hacker News', 'design', url],
  [
    'Ask HN: What are you working on? | Hacker News',
    'design',
    'https://news.ycombinator.com/item?id=2',
  ],
  ['Hacker News', 'design', 'https://news.ycombinator.com/'],
  [
    'Defending my own brain against enshittification | Hacker News',
    'design',
    'https://news.ycombinator.com/item?id=4',
  ],
];
try {
  await page.addInitScript(
    ({ url, article }) => {
      window.hnTest = {
        scripts: [],
        saved: {},
        values: {
          1: {
            url,
            articleUrl: article,
            title: 'I love software rendering',
            source: 'jamesfmackenzie.com',
            comments: '200 comments',
          },
          2: {
            url: 'https://news.ycombinator.com/item?id=2',
            title: 'Ask HN: What are you working on?',
            kind: 'Ask HN',
            comments: '45 comments',
          },
          4: {
            url: 'https://news.ycombinator.com/item?id=4',
            articleUrl: 'https://mrmarket.lol/brain',
            title: 'Defending my own brain against enshittification',
            source: 'mrmarket.lol',
            comments: '0 comments',
          },
        },
      };
      window.browser = {
        permissions: { contains: async () => true },
        tabs: { get: async (id) => hnTest.api.tabs.get(id) },
        sessions: {
          getTabValue: async (id) => hnTest.saved[id],

          setTabValue: async (id, key, value) => {
            hnTest.saved[id] = value;
          },
        },
        scripting: {
          executeScript: async ({ target }) => {
            const tab = await hnTest.api.tabs.get(target.tabId);
            hnTest.scripts.push(tab.url);
            if (!tab.url.startsWith('https://news.ycombinator.com/'))
              throw new Error('Must not read the article');
            return [{ result: hnTest.values[target.tabId] || null }];
          },
        },
      };
    },
    { url, article },
  );
  const demo = await readFile('preview/demo.js', 'utf8');
  await page.route('**/preview/demo.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: demo
        .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
        .replace(/const entries = \[[\s\S]*?\n  \];/, `const entries = ${JSON.stringify(entries)};`)
        .replace(
          'const parents = { 2: [1], 3: [1], 4: [3, 1], 6: [5], 7: [5] };',
          'const parents = {};',
        )
        .replace(
          'groupId: -1,',
          `groupId: -1, favIconUrl: '${base}/extension/icons/sites/hacker-news.ico',`,
        )
        .replace(
          'return controller;',
          'Object.assign(window.hnTest, { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }); return controller;',
        ),
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const row = (id) => page.locator(`#tree [data-key="tab:${id}"]`);
  const button = (id, view) => row(id).locator(`[data-hn-view="${view}"]`);

  const openDomain = async () => {
    await row(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  };

  await openDomain();
  await expect(button(1, 'comments')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(1).locator('.hn-comment-count')).toHaveText('200');
  await expect(row(2).locator('.hn-view-switch')).toHaveCount(0);
  await expect(row(3).locator('.hn-view-switch')).toHaveCount(0);
  await expect(row(4).locator('.hn-comment-count')).toHaveText('0');
  await button(1, 'article').focus();
  await page.keyboard.press('Enter');
  await expect(button(1, 'article')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(1, 'article')).toBeFocused();
  expect(await page.evaluate(() => hnTest.api.tabs.query({}))).toHaveLength(4);
  expect(await page.evaluate(() => hnTest.api.tabs.get(1))).toMatchObject({
    url: article,
    active: true,
  });
  await page.evaluate(() => hnTest.api.tabs.update(1, { title: 'The publisher’s article title' }));
  await expect(row(1).locator('.label')).toHaveText('I love software rendering');
  await page.locator('#domain-close').click();
  await openDomain();
  await expect(page.locator('#domain-address')).toHaveText('news.ycombinator.com');
  await expect(button(1, 'article')).toHaveAttribute('aria-pressed', 'true');
  await button(1, 'comments').click();
  await expect(button(1, 'comments')).toHaveAttribute('aria-pressed', 'true');
  expect((await page.evaluate(() => hnTest.api.tabs.get(1))).url).toBe(url);
  // A failed browser navigation must leave the working return route and controls intact.
  await page.evaluate(() => {
    const update = hnTest.api.tabs.update;
    hnTest.api.tabs.update = async (id, changes) => {
      if (changes.url) {
        hnTest.api.tabs.update = update;
        throw new Error('Navigation failed');
      }
      return update(id, changes);
    };
  });
  await button(1, 'article').click();
  await expect(button(1, 'article')).toBeEnabled();
  await expect(button(1, 'comments')).toHaveAttribute('aria-pressed', 'true');
  await button(1, 'article').click();
  await expect(button(1, 'article')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#toast')).toBeHidden({ timeout: 10000 });
  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 820 });
    for (const item of await page.locator('.site-row').all())
      expect(await item.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const item of await page.locator('.hn-view-button').all())
      expect(await item.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/hacker-news-${width}.png` });
  }
  await page.setViewportSize({ width: 360, height: 820 });
  await page.evaluate(() =>
    hnTest.send('setLook', { partial: true, value: { colorScheme: 'dark' } }),
  );
  await page.screenshot({ path: 'test-results/hacker-news-dark.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: 'test-results/hacker-news-forced-colours.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.locator('#site-mode').click();
  await expect(page.locator('.hn-view-switch')).toHaveCount(0);
  await expect(row(1)).toBeVisible();
  await page.locator('#site-mode').click();
  await expect(button(1, 'article')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => hnTest.api.tabs.update(1, { url: 'https://elsewhere.test/other' }));
  await expect(row(1)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      hnTest.scripts.every((url) => url.startsWith('https://news.ycombinator.com/')),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    '✓ HN row switches navigate the same tab, preserve focus and grouping, recover from failures, omit text-only posts, and fit 220/320/480px, dark and forced colours',
  );
} finally {
  await close();
}
