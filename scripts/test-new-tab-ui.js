import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.context().on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
try {
  const source = await readFile('extension/src/new-tab-page.js', 'utf8');
  await page.context().route('**/extension/src/new-tab-page.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source.replace(
          'function domain(url) {',
          'function domain(url) { window.faviconDomainCalls = (window.faviconDomainCalls || 0) + 1;',
        ) +
        '\nwindow.faviconLookupTest = (next) => { state = { ...next, newTab: normalizeNewTab(next.newTab) }; draft = undefined; window.faviconDomainCalls = 0; render(); return window.faviconDomainCalls; };',
    }),
  );
  await page.goto(`${base}/extension/settings.html?demo#new-tab`);
  await expect(page.locator('#new-tab-fields')).toBeEnabled();
  await expect(page.getByRole('switch')).not.toBeChecked();
  await expect(page.locator('#new-tab-links')).toContainText('Add the websites');

  const add = async (name, url) => {
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Website address', { exact: true }).fill(url);
    await page.getByRole('dialog').getByRole('button', { name: 'Add link', exact: true }).click();
  };

  await add('GitHub', 'github.com');
  await expect(page.getByRole('dialog')).toBeHidden();
  await add('Wikipedia', 'https://wikipedia.org');
  await add('MDN', 'https://developer.mozilla.org');
  await page.getByRole('button', { name: 'Move MDN up', exact: true }).click();
  await expect(page.locator('.nt-link-copy strong')).toHaveText(['GitHub', 'MDN', 'Wikipedia']);
  await page.getByRole('button', { name: 'Edit GitHub', exact: true }).click();
  await page.getByLabel('Website address', { exact: true }).fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Update link', exact: true }).click();
  await expect(page.locator('#nt-link-error')).toContainText('HTTP or HTTPS');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit GitHub', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Remove Wikipedia', exact: true }).click();
  await expect(page.locator('.nt-link-copy strong')).toHaveText(['GitHub', 'MDN']);
  await page.locator('#new-tab-save').click();
  await expect(page.locator('#new-tab-status')).toHaveText('All changes saved');
  await page.locator('#nt-style').selectOption('list');
  // Preview must reflect unsaved edits without saving the master preference.
  const previewOpened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Preview page', exact: true }).click();
  const preview = await previewOpened;
  await expect(preview.locator('#links')).toHaveClass(/list-style/);
  await expect(preview.locator('#links a')).toHaveText(['GitHub', 'MDN']);
  await expect(preview.locator('#links a').first()).toHaveAttribute('href', 'https://github.com/');
  expect(
    await page.evaluate(
      async () =>
        (
          await (
            await window.tabernacleDemoSession.ready
          ).request({ type: 'getSettings', windowId: 1 })
        ).newTab.linkStyle,
    ),
  ).toBe('icons');
  await preview.getByLabel('Search the web or your tabs', { exact: true }).fill('Figma');
  await expect(preview.locator('#search-matches')).toContainText('Figma');
  await preview.getByLabel('Search the web or your tabs', { exact: true }).press('Escape');
  await expect(preview.locator('#search-results')).toBeHidden();
  await preview.locator('#all-folders').click();
  await expect(preview.locator('.folder')).toHaveCount(5);
  await preview.getByLabel('Search the web or your tabs', { exact: true }).fill('Figma');
  await preview.evaluate(() => {
    window.lifecycleHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => lifecycleHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(preview.locator('#new-tab-content [data-key]')).toHaveCount(0);
  await preview.evaluate(() => {
    lifecycleHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(preview.locator('#links')).toHaveClass(/list-style/);
  await expect(preview.locator('#links a')).toHaveText(['GitHub', 'MDN']);
  await expect(preview.locator('.folder')).toHaveCount(5);
  await expect(preview.getByLabel('Search the web or your tabs', { exact: true })).toHaveValue(
    'Figma',
  );
  await expect(preview.locator('#search-matches')).toContainText('Figma');
  await preview.getByLabel('Search the web or your tabs', { exact: true }).press('Escape');
  await preview.evaluate(() => {
    delete document.hidden;
  });
  await preview.locator('#all-folders').click();
  await expect(preview.locator('.folder')).toHaveCount(3);
  await page.locator('#new-tab-discard').click();
  await expect(page.locator('#nt-style')).toHaveValue('icons');
  await page.getByLabel('Show weather', { exact: true }).check();
  await page.locator('#new-tab-save').click();
  await expect(page.locator('#new-tab-error')).toContainText('Choose a location');
  await page.locator('#new-tab-discard').click();
  await page.getByRole('switch').check();
  await page.locator('#new-tab-save').click();
  await expect(page.locator('#new-tab-status')).toHaveText('All changes saved');
  // A live page, rather than a frozen draft, follows settings changes.
  const liveOpened = page.waitForEvent('popup');
  await page.evaluate(() => window.open('new-tab.html?demo'));
  const live = await liveOpened;
  await expect(live.locator('#links a')).toHaveCount(2);
  await page.locator('#nt-colour').selectOption('dark');
  await page.locator('[name=showFolders]').uncheck();
  await page.locator('#new-tab-save').click();
  await live.bringToFront();
  await expect(live.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await expect(live.locator('#folders-section')).toBeHidden();
  for (const [width, height] of [
    [1440, 960],
    [720, 900],
    [320, 900],
  ]) {
    await live.setViewportSize({ width, height });
    await expect
      .poll(() => live.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  await live.screenshot({ path: 'test-results/new-tab-dark-320.png', fullPage: true });
  await page.screenshot({ path: 'test-results/new-tab-settings-320.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#nt-colour').selectOption('light');
  await page.locator('[name=showFolders]').check();
  await page.locator('#new-tab-save').click();
  await live.setViewportSize({ width: 1440, height: 960 });
  await live.bringToFront();
  await expect(live.locator('html')).toHaveAttribute('data-color-scheme', 'light');
  await live.screenshot({ path: 'test-results/new-tab-light.png', fullPage: true });
  await page.screenshot({ path: 'test-results/new-tab-settings.png', fullPage: true });
  const faviconLookup = await live.evaluate(() => {
    const art = (colour) =>
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="' +
          colour +
          '"/></svg>',
      );
    const tabs = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      title: 'Tab ' + i,
      url: 'https://host' + i + '.example.com/',
      favIconUrl: art('red'),
    }));
    tabs[0].url = 'https://www.duplicate.example.com/first';
    tabs[0].favIconUrl = undefined;
    tabs[1].url = 'https://duplicate.example.com/second';
    tabs[1].favIconUrl = art('blue');
    const links = [
      { id: 'duplicate', name: 'Duplicate', url: 'https://duplicate.example.com/' },
      ...Array.from({ length: 59 }, (_, i) => ({
        id: 'site' + i,
        name: 'Site ' + i,
        url: tabs[999 - i].url,
      })),
    ];
    const next = {
      tabs,
      groups: [],
      folderPins: [],
      containers: [],
      recentlyClosed: [],
      look: { colorScheme: 'light' },
      newTab: { links, weatherEnabled: false },
    };
    const read = (key) =>
      document.querySelector('[data-key="link-' + key + '"] img')?.getAttribute('src') || null;
    const domainCalls = faviconLookupTest(next);
    const firstMissing = read('duplicate');
    const farMatch = read('site0');
    [tabs[0], tabs[1]] = [tabs[1], tabs[0]];
    faviconLookupTest(next);
    const reordered = read('duplicate');
    tabs.at(-1).favIconUrl = art('green');
    faviconLookupTest(next);
    const updated = read('site0');
    tabs.pop();
    faviconLookupTest(next);
    const removed = read('site0');
    next.newTab.links = [links[0]];
    const firstMatchCalls = faviconLookupTest(next);
    next.newTab.links = [];
    const noLinkCalls = faviconLookupTest(next);
    return {
      domainCalls,
      firstMissing,
      farMatch,
      reordered,
      updated,
      removed,
      firstMatchCalls,
      noLinkCalls,
      expected: { red: art('red'), blue: art('blue'), green: art('green') },
    };
  });
  expect(faviconLookup.domainCalls).toBeLessThan(1200);
  expect(faviconLookup.firstMissing).toBeNull();
  expect(faviconLookup.farMatch).toBe(faviconLookup.expected.red);
  expect(faviconLookup.reordered).toBe(faviconLookup.expected.blue);
  expect(faviconLookup.updated).toBe(faviconLookup.expected.green);
  expect(faviconLookup.removed).toBeNull();
  expect(faviconLookup.firstMatchCalls).toBe(2);
  expect(faviconLookup.noLinkCalls).toBe(0);
  console.log(
    '✓ New tab favicon matching stays linear and preserves first-match, reorder, edit and removal behaviour',
  );

  expect(errors).toEqual([]);
  console.log(
    '✓ New tab UI: links CRUD/reorder, unsafe URL validation, drafts/preview/discard, local search, live preferences, weather setup, light/dark and 320px layout',
  );
} finally {
  await close();
}
