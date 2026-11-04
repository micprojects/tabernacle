import { instrumentSource } from '../helpers/probes/new-tab.js';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.context().on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
try {
  const source = await readFile('extension/src/new-tab-page.js', 'utf8');
  await page.context().route('**/extension/src/new-tab-page.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: instrumentSource(source),
    }),
  );
  await page.goto(`${base}/extension/settings.html?demo#new-tab`);
  await expect(page.locator('#new-tab-fields')).toBeEnabled();
  await expect(page.locator('[name="showLater"]')).toHaveCount(0);
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
  await add('Local dashboard', 'localhost:4173/dashboard');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Edit Local dashboard', exact: true }).click();
  await expect(page.getByLabel('Website address', { exact: true })).toHaveValue(
    'https://localhost:4173/dashboard',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Local dashboard', exact: true }).click();
  await page.locator('#new-tab-save').click();
  await expect(page.locator('#new-tab-status')).toHaveText('All changes saved');
  await page.locator('#nt-style').selectOption('list');
  // Preview must reflect unsaved edits without saving the master preference.
  const previewOpened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Preview page', exact: true }).click();
  const preview = await previewOpened;
  await expect(preview.locator('#later-section')).toHaveCount(0);
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
  await live.evaluate(async () => {
    const controller = await window.tabernacleDemoSession.ready;
    const request = controller.request;
    const probe = (window.newTabReadRecovery = { fail: true, completed: 0 });
    probe.restore = () => (controller.request = request);
    controller.request = async (message) => {
      if (message.type === 'getNewTabState' && probe.fail)
        throw new Error('Temporary state read failure');
      const result = await request(message);
      if (message.type === 'getNewTabState') probe.completed++;
      return result;
    };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(live.locator('#page-error')).toHaveText('Temporary state read failure');
  await live.evaluate(() => {
    newTabReadRecovery.fail = false;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(live.locator('#page-error')).toBeHidden();
  // A later successful refresh must preserve unrelated action errors.
  await live.locator('#search').fill('web search');
  await live.locator('#search').press('Enter');
  await expect(live.locator('#page-error')).toContainText('Web search is available');
  await live.evaluate(() => {
    newTabReadRecovery.completed = 0;
    window.dispatchEvent(new Event('focus'));
  });
  await live.waitForFunction(() => newTabReadRecovery.completed > 0);
  await expect(live.locator('#page-error')).toContainText('Web search is available');
  await live.evaluate(() => {
    newTabReadRecovery.restore();
    delete window.newTabReadRecovery;
  });
  await live.locator('#search').press('Escape');
  console.log('✓ Successful new-tab refresh clears read failures and preserves action errors');
  await live.evaluate(async () => {
    const controller = await window.tabernacleDemoSession.ready;
    const request = controller.request;
    window.newTabPress = { completed: 0, restore: () => (controller.request = request) };
    controller.request = async (message) => {
      const result = await request(message);
      if (message.type === 'getNewTabState') newTabPress.completed++;
      return result;
    };
  });
  for (const input of ['pointer', 'Space']) {
    const folder = live.locator('#folders .folder').first();
    await folder.focus();
    await live.evaluate(() => {
      newTabPress.target = document.querySelector('#folders .folder');
      newTabPress.completed = 0;
      document.getElementById('page-status').textContent = '';
    });
    if (input === 'pointer') {
      const box = await folder.boundingBox();
      await live.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await live.mouse.down();
    } else await live.keyboard.down(input);
    const updatedName = await live.evaluate(async () => {
      const controller = await window.tabernacleDemoSession.ready;
      const state = await controller.request({ type: 'getNewTabState', windowId: 1 });
      newTabPress.completed = 0;
      const group = state.groups[0];
      const name = `${group.name} updated`;
      await controller.request({ type: 'renameGroup', windowId: 1, id: group.id, name });
      return name;
    });
    await live.waitForFunction(() => newTabPress.completed > 0);
    expect(await live.evaluate(() => newTabPress.target.isConnected)).toBe(true);
    if (input === 'pointer') await live.mouse.up();
    else await live.keyboard.up(input);
    await expect(live.locator('#page-status')).toContainText('Opened');
    await expect(live.locator('#folders .folder').first()).toContainText(updatedName);
  }
  for (const release of ['pointercancel', 'blur', 'hidden']) {
    const folder = live.locator('#folders .folder').first();
    const box = await folder.boundingBox();
    await live.evaluate(() => {
      document.addEventListener(
        'pointerdown',
        (event) => (newTabPress.pointerId = event.pointerId),
        {
          once: true,
        },
      );
      newTabPress.target = document.querySelector('#folders .folder');
      newTabPress.completed = 0;
    });
    await live.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await live.mouse.down();
    await live.evaluate(() => window.dispatchEvent(new Event('focus')));
    await live.waitForFunction(() => newTabPress.completed > 0);
    expect(await live.evaluate(() => newTabPress.target.isConnected)).toBe(true);
    await live.evaluate((release) => {
      if (release === 'hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } else if (release === 'blur') window.dispatchEvent(new Event('blur'));
      else
        document.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId: newTabPress.pointerId }),
        );
    }, release);
    await live.waitForFunction(() => !newTabPress.target.isConnected);
    await live.mouse.up();
    if (release === 'hidden')
      await live.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await expect(live.locator('#folders .folder').first()).toBeVisible();
  }
  await live.evaluate(() => {
    newTabPress.restore();
    delete window.newTabPress;
  });
  console.log(
    '✓ New tab activation survives refresh; cancellation, blur and hiding release held controls',
  );
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

  for (const [tabCount, folderCount] of [
    [13, 0],
    [0, 7],
    [12, 6],
    [13, 5],
    [1, 1],
  ]) {
    await live.evaluate(
      ({ tabCount, folderCount }) => {
        document.getElementById('search').value = 'Match';
        faviconLookupTest({
          tabs: Array.from({ length: tabCount }, (_, id) => ({
            id,
            title: `Match ${id}`,
            url: `https://example.test/${id}`,
          })),
          groups: Array.from({ length: folderCount }, (_, id) => ({
            id: `match-${id}`,
            name: `Match ${id}`,
            parentId: null,
          })),
          folderPins: [],
          containers: [],
          recentlyClosed: [],
          look: {},
          newTab: {},
        });
      },
      { tabCount, folderCount },
    );
    await expect(live.locator('#search-matches .entry')).toHaveCount(
      Math.min(tabCount, 12) + Math.min(folderCount, 6),
    );
    await expect(live.locator('#search-status')).toHaveText(
      `${tabCount + folderCount} matching tabs and folders${tabCount > 12 || folderCount > 6 ? '; showing the first matches' : ''}.`,
    );
  }

  expect(errors).toEqual([]);
  console.log(
    '✓ New tab UI: links CRUD/reorder, unsafe URL validation, drafts/preview/discard, local search, live preferences, weather setup, light/dark and 320px layout',
  );
} finally {
  await close();
}
