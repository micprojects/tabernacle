import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';
import { readYouTubePlayer } from '../extension/src/youtube.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 760 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const calls = [];
await page.route('https://i.ytimg.com/**', (route) =>
  route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#d5bf9d"/><path d="M50 130V60H265V130M40 58H275" fill="none" stroke="#785738" stroke-width="14"/></svg>',
  }),
);
await page.route('https://www.youtube.com/oembed?**', (route) => {
  calls.push(route.request().url());
  return route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ author_name: 'Bench Notes' }),
  });
});
await page.addInitScript(() => {
  window.ytFixture = {
    allowed: false,
    scripts: [],
    players: {
      1: {
        videoId: 'OakDesk0001',
        channel: 'Bench Notes',
        position: 750,
        duration: 1122,
        paused: true,
      },
      3: {
        videoId: 'HandPlane01',
        channel: 'Bench Notes',
        position: 130,
        duration: 558,
        paused: true,
      },
      5: { videoId: 'Landscape01', channel: 'Paper & Water' },
      10: {
        videoId: 'MusicWork01',
        channel: 'Studio Sessions',
        position: 1100,
        duration: 3720,
        paused: false,
      },
    },
  };
  window.browser = {
    permissions: {
      contains: async () => ytFixture.allowed,
      request: async () => (ytFixture.allowed = true),
    },
    sessions: {
      getTabValue: async (id) => JSON.parse(sessionStorage.getItem(`yt-data-${id}`) || 'null'),
      setTabValue: async (id, key, value) =>
        sessionStorage.setItem(`yt-data-${id}`, JSON.stringify(value)),
    },
    tabs: { get: async (id) => domainTest.api.tabs.get(id) },
    scripting: {
      executeScript: async ({ target }) => {
        ytFixture.scripts.push(target.tabId);
        return [{ result: ytFixture.players[target.tabId] || null }];
      },
    },
  };
  Object.defineProperty(navigator.clipboard, 'writeText', {
    value: async (text) => {
      ytFixture.copied = text;
    },
  });
});
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: demo
      .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
      .replace(
        'const memberships = {};',
        `
      entries[0] = ['(196) Building a small oak writing desk - YouTube', 'design', 'https://www.youtube.com/watch?v=OakDesk0001'];
      entries[2] = ['Choosing your first hand plane - YouTube', 'design', 'https://youtube.com/watch?v=HandPlane01'];
      entries[4] = ['Painting a quiet landscape - YouTube', 'research', 'https://youtube.com/watch?v=Landscape01'];
      entries[9] = ['Music for working - YouTube', 'personal', 'https://youtube.com/watch?v=MusicWork01'];
      entries[12] = ['Weekend woodworking ideas', 'later', 'https://youtube.com/playlist?list=test'];
      entries[13] = ['Building a small oak writing desk - YouTube', 'later', 'https://www.youtube.com/watch?v=OakDesk0001&t=45'];
      const memberships = {};`,
      )
      .replace(
        'const controller = createController',
        `
      await api.tabs.update(14, { discarded: true });
      await api.tabs.update(10, { audible: true });
      const modelKey = 'tabernacle.model.v1';
      const saved = (await api.storage.local.get(modelKey))[modelKey];
      if (localStorage.getItem('yt-enabled') === 'false') await api.storage.local.set({ [modelKey]: { ...saved, youtubeMode: false } });
      const save = api.storage.local.set;
      api.storage.local.set = async (value) => {
        await save(value);
        if (value[modelKey]?.youtubeMode !== undefined) localStorage.setItem('yt-enabled', String(value[modelKey].youtubeMode));
      };
      const controller = createController`,
      )
      .replace(
        'return controller;',
        'window.domainTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const row = (id) => page.locator(`#tree [data-key="tab:${id}"]`);
const toggle = page.getByRole('switch', { name: 'Enhanced' });

const filter = async () => {
  await row(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await expect(toggle).toBeVisible();
};

const ids = () =>
  page.locator('#tree .tab-row').evaluateAll((rows) => rows.map((row) => Number(row.dataset.id)));

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row(1)).toBeVisible();
  await filter();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#domain-count')).toBeHidden();
  await expect(page.locator('#tree .youtube-row')).toHaveCount(6);
  await expect(page.locator('#youtube-access')).toBeVisible();
  expect(await page.evaluate(() => ytFixture.scripts)).toEqual([]);
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(page.locator('#youtube-access')).toBeHidden();
  await expect(row(1).locator('.youtube-position')).toHaveText('12:30 / 18:42', { timeout: 10000 });
  await expect(page.locator('.youtube-status')).toHaveCount(0);
  await expect(row(1).locator('.label')).toHaveText('Building a small oak writing desk');
  await expect(row(1).locator('.youtube-progress')).toBeVisible();
  await expect(row(1).locator('.youtube-progress')).toHaveAttribute('value', '750');
  await expect(row(1).locator('.youtube-progress')).toHaveAttribute('max', '1122');
  await expect(row(14).locator('.youtube-position')).toBeHidden();
  await expect(row(14).locator('.youtube-progress')).toBeHidden();
  await expect(row(14).locator('.youtube-channel')).toHaveText('Bench Notes');
  await expect(row(13).locator('.youtube-channel')).toHaveText('Playlist');
  await expect(row(13).locator('.youtube-progress')).toHaveCount(0);
  await expect(row(1).locator('.youtube-duplicate')).toBeVisible();
  await expect(row(14).locator('.youtube-duplicate')).toBeVisible();
  expect(await page.evaluate(() => ytFixture.scripts.includes(14))).toBe(false);
  await expect(row(1).locator('.youtube-folder')).toHaveText('Work / Design');
  await row(1).hover();
  await expect(row(1).locator('.youtube-actions')).toHaveCSS('opacity', '1');
  await row(1).getByRole('button', { name: 'Copy video link' }).click();
  expect(await page.evaluate(() => ytFixture.copied)).toBe(
    'https://www.youtube.com/watch?v=OakDesk0001',
  );
  const folderAction = row(1).getByRole('button', { name: 'Show in folder', exact: true });
  await page.mouse.move(0, 0);
  await folderAction.focus();
  await expect(row(1).locator('.youtube-actions')).toHaveCSS('opacity', '1');
  console.log(
    '✓ Enhanced defaults on for YouTube, requests scoped access and shows per-tab progress without waking discarded tabs',
  );
  await expect(page.locator('#toast')).toBeHidden();
  await toggle.focus();

  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 760 });
    await row(14).hover();
    expect(
      await page.locator('.sidebar').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    for (const item of await page.locator('#tree .youtube-row').all()) {
      expect(await item.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      const title = await item.locator('.label').boundingBox();
      expect(title.height).toBeLessThanOrEqual(54);
      const close = await item.locator('.close-tab').boundingBox();
      expect(title.x + title.width).toBeLessThanOrEqual(close.x);
    }
    await page.screenshot({ path: `test-results/youtube-mode-${width}.png` });
  }
  await page.setViewportSize({ width: 320, height: 760 });
  await folderAction.press('Enter');
  await expect(toggle).toBeHidden();
  await expect(row(1)).toHaveAttribute('aria-selected', 'true');
  await filter();
  console.log('✓ Hover and keyboard actions copy the link and reveal the original folder');
  await page.getByRole('button', { name: 'In progress', exact: true }).click();
  await expect.poll(ids).toEqual([10, 3, 1]);
  await page.getByRole('button', { name: 'Duplicates', exact: true }).click();
  await expect.poll(ids).toEqual([14, 1]);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#tree .youtube-row')).toHaveCount(0);
  await expect(page.locator('#youtube-tools')).toBeHidden();
  await expect(row(1).locator('.icon-slot')).toBeVisible();
  await page.reload();
  await expect(row(1)).toBeVisible();
  await filter();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => ytFixture.scripts)).toEqual([]);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(row(1).locator('.youtube-position')).toHaveText('12:30 / 18:42');
  console.log(
    '✓ The switch persists across reloads, supports keyboard input, and restores the standard domain list',
  );

  await page.getByRole('button', { name: 'In progress', exact: true }).click();
  await row(3).click();
  await page.evaluate(() => domainTest.api.tabs.update(3, { successorTabId: 14 }));
  await row(3).locator('.close-tab').click();
  await expect(row(10)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Duplicates', exact: true }).click();
  await row(14).click();
  await row(14).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  await expect(page.getByText('No duplicate videos', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(row(1).locator('.youtube-duplicate')).toHaveCount(0);
  await page.evaluate(() =>
    domainTest.send('setLook', { partial: true, value: { colorScheme: 'dark' } }),
  );
  await row(1).hover();
  await page.screenshot({ path: 'test-results/youtube-mode-dark.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(toggle).toBeVisible();
  await page.screenshot({ path: 'test-results/youtube-mode-forced-colours.png' });
  await page.keyboard.press('Escape');
  await expect(toggle).toBeHidden();
  await expect(row(1).locator('.label')).toHaveCSS('white-space', 'nowrap');
  expect(errors).toEqual([]);
  console.log(
    '✓ Filters preserve close-neighbour behaviour; empty, dark, forced-colour and ordinary tree views remain usable',
  );
  const player = page;
  await player.route('https://www.youtube.com/watch?**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="owner"><ytd-channel-name><a>Bench Notes</a></ytd-channel-name></div><ytd-watch-flexy video-id="OakDesk0001"><div class="html5-video-player"><video class="html5-main-video"></video><button class="ytp-live-badge" hidden>Live</button></div></ytd-watch-flexy>',
    }),
  );
  await player.goto('https://www.youtube.com/watch?v=OakDesk0001');
  await player.evaluate(() =>
    Object.defineProperties(document.querySelector('video'), {
      readyState: { value: 4 },
      duration: { value: 100, configurable: true },
      currentTime: { value: 25 },
      paused: { value: true },
    }),
  );
  expect(await player.evaluate(readYouTubePlayer, 'OakDesk0001')).toMatchObject({
    channel: 'Bench Notes',
    position: 25,
    duration: 100,
    live: false,
  });
  await player.evaluate(() =>
    document.querySelector('.html5-video-player').classList.add('ytp-live'),
  );
  expect((await player.evaluate(readYouTubePlayer, 'OakDesk0001')).live).toBe(true);
  await player.evaluate(() => {
    document.querySelector('.html5-video-player').classList.remove('ytp-live');
    Object.defineProperty(document.querySelector('video'), 'duration', { value: Infinity });
  });
  expect((await player.evaluate(readYouTubePlayer, 'OakDesk0001')).live).toBe(true);
  await player.evaluate(() =>
    document.querySelector('ytd-watch-flexy').classList.add('ad-showing'),
  );
  expect(await player.evaluate(readYouTubePlayer, 'OakDesk0001')).not.toHaveProperty('position');
  await player.evaluate(() =>
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', 'Other000001'),
  );
  expect(await player.evaluate(readYouTubePlayer, 'OakDesk0001')).toBeNull();
  await player.close();
  console.log(
    '✓ Hidden live badges do not suppress ordinary progress; real live media, ads and stale navigation are handled',
  );
} finally {
  await close();
}
