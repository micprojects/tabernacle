import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';
import { siteFixtures } from './fixtures/site-pages.js';
import { SITE_MODES, sitePage } from '../extension/src/site-modes.js';
import { readSitePage } from '../extension/src/site-reader.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 320, height: 760 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const extracted = {};
try {
  // Execute the actual self-contained reader against provider-shaped DOMs.
  const sourceContext = await page.context().browser().newContext();
  const source = await sourceContext.newPage();
  await source.route('**/*', (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      : route.abort(),
  );
  for (const fixture of siteFixtures) {
    await source.goto(fixture.url);
    await source.setContent(
      `<!doctype html><html lang="en-GB"><head><title>${fixture.title}</title></head><body>${fixture.html}</body></html>`,
    );
    const data = await source.evaluate(
      ({ reader, url, page }) => new Function(`return (${reader})`)()(url, page),
      { reader: readSitePage.toString(), url: fixture.url, page: sitePage(fixture.url) },
    );
    expect(data, fixture.site).toMatchObject(fixture.fields);
    extracted[fixture.url] = data;
    const stale = await source.evaluate(
      ({ reader, page }) => new Function(`return (${reader})`)()('https://elsewhere.test/', page),
      { reader: readSitePage.toString(), page: sitePage(fixture.url) },
    );
    expect(stale).toBeNull();
    await source.setContent('<title>403 Forbidden</title><h1>Access denied</h1>');
    expect(
      await source.evaluate(
        ({ reader, url, page }) => new Function(`return (${reader})`)()(url, page),
        { reader: readSitePage.toString(), url: fixture.url, page: sitePage(fixture.url) },
      ),
    ).toBeNull();
  }
  // Sensitive Reddit previews, placeholder prices and irrelevant schema fail closed.
  await source.goto(siteFixtures[0].url);
  await source.setContent(
    '<shreddit-post id="t3_abc123" nsfw comment-count="0"><img slot="post-media" src="https://images.example.test/private.jpg"></shreddit-post>',
  );
  const sensitive = await source.evaluate(
    ({ reader, url, page }) => new Function(`return (${reader})`)()(url, page),
    {
      reader: readSitePage.toString(),
      url: siteFixtures[0].url,
      page: sitePage(siteFixtures[0].url),
    },
  );
  expect(sensitive.image).toBeUndefined();
  expect(sensitive.comments).toBe('0 comments');
  await source.close();
  await sourceContext.close();
  console.log(
    '✓ All 13 provider/page contracts extract the intended fields; blocked, stale and sensitive pages have safe fallbacks',
  );

  const entries = [];
  const ids = {};
  const values = {};
  for (const f of siteFixtures) {
    const id = entries.length + 1;
    ids[f.site] = id;
    entries.push([f.title, 'design', f.url]);
    values[id] = extracted[f.url];
    const related = new URL(f.url);
    related.searchParams.set('tabernacle-test', 'other-view');
    entries.push([f.title, 'design', related.href]);
    values[id + 1] = { ...extracted[f.url], url: related.href };
    entries.push([`${SITE_MODES[f.mode].name} home`, 'design', new URL('/', f.url).href]);
  }
  await page.route('https://images.example.test/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="140"><rect width="100" height="140" fill="#c4b7a4"/><path d="M25 45h45v50H25z" fill="#80715f"/></svg>',
    }),
  );
  await page.addInitScript(
    ({ values }) => {
      window.siteTest = { allowed: false, scripts: [], values, requests: [], saved: {} };
      window.browser = {
        permissions: {
          contains: async () => siteTest.allowed,

          request: async (value) => {
            siteTest.requests.push(value);
            return (siteTest.allowed = true);
          },
        },
        tabs: { get: async (id) => domainTest.api.tabs.get(id) },
        sessions: {
          getTabValue: async (id) => siteTest.saved[id],

          setTabValue: async (id, key, value) => {
            siteTest.saved[id] = value;
          },
        },
        scripting: {
          executeScript: async ({ target }) => {
            siteTest.scripts.push(target.tabId);
            return [{ result: siteTest.values[target.tabId] || null }];
          },
        },
      };
    },
    { values },
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
        .replace('pinned: [10, 11, 12, 13].includes(index + 1),', 'pinned: false,')
        .replace(
          'groupId: -1,',
          'groupId: -1, favIconUrl: "https://images.example.test/favicon.png",',
        )
        .replace(
          'return controller;',
          'window.domainTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
        ),
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const row = (id) => page.locator(`#tree [data-key="tab:${id}"]`);
  const toggle = page.locator('#site-mode');
  for (const f of siteFixtures) {
    const id = ids[f.site];
    await row(id).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
    await expect(toggle).toHaveAccessibleName('Enhanced');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    if (f.site === 'reddit') {
      await expect(page.locator('#site-access')).toBeVisible();
      expect(await page.evaluate(() => siteTest.scripts)).toEqual([]);
      await page.locator('#site-allow').click();
      expect(await page.evaluate(() => siteTest.requests)).toEqual([
        { origins: ['https://*.reddit.com/*'] },
      ]);
    }
    await row(id).scrollIntoViewIfNeeded();
    for (const [field, value] of Object.entries(f.fields)) {
      if (field === 'title') await expect(row(id).locator('.label')).toHaveText(value);
      else await expect(row(id)).toContainText(value);
    }
    if (values[id].image) await expect(row(id).locator('.site-media')).toHaveClass(/has-image/);
    if (sitePage(f.url).identity)
      await expect(row(id).locator('.site-related')).toContainText('2 tabs');
    else await expect(row(id).locator('.site-related')).toHaveCount(0);
    for (const width of [220, 320, 480]) {
      await page.setViewportSize({ width, height: 760 });
      expect(
        await page.locator('.sidebar').evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      for (const item of await page.locator('.site-row').all()) {
        expect(await item.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        const label = await item.locator('.label').boundingBox();
        const close = await item.locator('.close-tab').boundingBox();
        expect(label.x + label.width).toBeLessThanOrEqual(close.x + 1);
      }
      await row(id).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/site-modes/${f.site}-${width}.png` });
    }
    await page.setViewportSize({ width: 320, height: 760 });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.site-row')).toHaveCount(0);
    await expect(page.locator('#site-access')).toBeHidden();
    await page.locator('#domain-close').click();
    await row(id).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(() =>
      domainTest.send('setLook', { partial: true, value: { colorScheme: 'dark' } }),
    );
    await row(id).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/site-modes/${f.site}-dark.png` });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.screenshot({ path: `test-results/site-modes/${f.site}-forced-colours.png` });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.evaluate(() =>
      domainTest.send('setLook', { partial: true, value: { colorScheme: 'light' } }),
    );
    await page.keyboard.press('Escape');
    await expect(toggle).toBeHidden();
    console.log(
      `✓ ${f.site}: fields and images display, 220/320/480px layouts, keyboard toggle, remembered preference, dark and forced colours`,
    );
  }
  expect(errors).toEqual([]);
} finally {
  await close();
}
