import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 620 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const logo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect x="1" y="8" width="46" height="32" rx="9" fill="#ff0000"/><path d="M20 16 33 24 20 32Z" fill="white"/></svg>')}`;
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: demo
      .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
      .replace(
        '      title,',
        `      favIconUrl: index === 0 ? ${JSON.stringify(logo)} : undefined,\n      title,`,
      )
      .replace(
        'const memberships = {};',
        `
      entries[0] = ['Woodworking projects', 'design', 'https://www.youtube.com/watch?v=1'];
      entries[1] = ['Typography reference', 'design', 'https://fonts.google.com/specimen/Inter'];
      entries[2] = ['Music for working', 'design', 'https://music.youtube.com/watch?v=3'];
      entries[4] = ['Painting techniques', 'research', 'https://youtube.com/watch?v=5'];
      entries[6] = ['youtube.com reference', 'research', 'https://example.com/youtube.com'];
      entries[9] = ['Pinned video', 'personal', 'https://youtube.com/watch?v=10'];
      entries[12] = ['Pinned playlist', 'later', 'https://www.youtube.com/playlist?list=13'];
      entries[13] = ['Woodworking tools', 'later', 'https://youtube.com/watch?v=14'];
      entries[15] = ['New tab', 'later', 'about:blank'];
      while (entries.length < 65) entries.push(['Extra tab ' + entries.length, null, 'https://example.com/' + entries.length]);
      const memberships = {};`,
      )
      .replace(
        'return controller;',
        'window.domainTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const row = (id) => page.locator(`#tree [data-key="tab:${id}"]`);
const header = page.locator('#domain-header');
const exit = page.getByRole('button', { name: 'Close domain view', exact: true });
const search = page.locator('#search');
const results = page.locator('#tree .tab-row');
const sort = page.getByRole('combobox', { name: 'Sort filtered tabs' });
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => domainTest.send(type, args), [type, args]);
const snapshot = () => send('snapshot');
const ids = () => results.evaluateAll((rows) => rows.map((row) => Number(row.dataset.id)));

const reset = async () => {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row(1)).toBeVisible();
};

const filter = async (
  id = 1,
  order = 'tree',
  name = id === 2 ? 'fonts.google.com' : 'youtube.com',
) => {
  await row(id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await expect(page.locator('#domain-name')).toHaveText(name);
  await expect(page.locator('#navigation-capsule')).toBeHidden();
  await expect(page.locator('#search')).toHaveValue('');
  await sort.selectOption(order);
};

try {
  await reset();
  await expect(page.locator('#domain-tools')).toBeHidden();
  await filter(1, 'newest');
  await expect(sort).toHaveValue('newest');
  await expect(page.locator('#domain-count')).toHaveText('6 tabs');
  const unsorted = await snapshot();
  for (const [order, expected] of [
    ['newest', [14, 13, 10, 5, 3, 1]],
    ['oldest', [1, 3, 5, 10, 13, 14]],
    ['title', [3, 5, 13, 10, 1, 14]],
    ['tree', [10, 13, 1, 3, 5, 14]],
  ]) {
    await sort.selectOption(order);
    expect(await ids()).toEqual(expected);
    await expect(header).toBeVisible();
  }
  expect((await snapshot()).tabs).toEqual(unsorted.tabs);
  await sort.selectOption('viewed');
  await row(5).click();
  await expect(results.first()).toHaveAttribute('data-id', '5');
  await expect(row(5)).toBeFocused();
  await row(14).click();
  await expect(results.first()).toHaveAttribute('data-id', '14');
  await page.evaluate(() => domainTest.api.tabs.update(14, { successorTabId: 2 }));
  await row(14).locator('.close-tab').click();
  await expect(row(5)).toHaveAttribute('aria-selected', 'true');
  await sort.selectOption('newest');
  await row(1).click();
  await expect(row(1)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => domainTest.api.tabs.update(1, { successorTabId: 2 }));
  await row(1).locator('.close-tab').click();
  await expect(row(3)).toHaveAttribute('aria-selected', 'true');
  await expect(row(3)).toBeFocused();
  await expect(page.locator('#domain-count')).toHaveText('4 tabs');
  await page.keyboard.press('Escape');
  await expect(page.locator('#domain-tools')).toBeHidden();
  console.log(
    '✓ Sorts default to newest, update counts and viewing order, preserve the tree and use sorted close neighbours',
  );

  await reset();
  await page.locator('[data-key="group:design"]').dblclick();
  await row(1).locator('.tab-disclosure').click();
  await expect(row(3)).toHaveCount(0);
  const before = await snapshot();
  await filter();
  await expect(results).toHaveCount(6);
  await expect(
    page.locator(
      '#youtube-mode, #site-mode, #youtube-tools, #site-access, .youtube-row, .site-row',
    ),
  ).toHaveCount(0);
  expect(await ids()).toEqual([10, 13, 1, 3, 5, 14]);
  await expect(page.locator('#tree > .tab-row')).toHaveCount(6);
  await expect(
    page.locator('#tree .group-row, #tree .tab-disclosure, #tree .branch, #tree .tab-branch'),
  ).toHaveCount(0);
  await expect(page.locator('#pinned-tabs')).toBeHidden();
  await expect(page.locator('#tree-toggle')).toBeDisabled();
  await expect(row(14)).toHaveAttribute('title', /Folder: Home \/ Later/);
  await expect(page.locator('#domain-status')).toHaveText('6 tabs from youtube.com in this window');
  await row(3).click();
  await expect(row(3)).toHaveAttribute('aria-selected', 'true');
  await row(3).click();
  await row(5).focus();
  await page.keyboard.press('Enter');
  await expect(row(5)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(header).toBeVisible();
  const activated = await snapshot();
  expect(activated.view).toEqual(before.view);
  expect(activated.tabs.map((tab) => tab.collapsed)).toEqual(
    before.tabs.map((tab) => tab.collapsed),
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await expect(row(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(header).toBeHidden();
  console.log(
    '✓ Domain filter spans every folder and pins, stays flat and preserves folds while activating results',
  );

  await filter();
  await row(1).click();
  await expect(row(1)).toHaveAttribute('aria-selected', 'true');
  await row(1).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  await expect(row(13)).toBeFocused();
  await expect(row(13)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toBeHidden();
  const closed = await snapshot();
  expect(closed.tabs.some((tab) => tab.id === 1)).toBe(false);
  for (const id of [2, 3, 4]) expect(closed.tabs.some((tab) => tab.id === id)).toBe(true);
  await row(5).click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Close tab and nested tabs…', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await expect(row(5)).toHaveCount(0);
  for (const id of [6, 7]) expect((await snapshot()).tabs.some((tab) => tab.id === id)).toBe(true);
  await row(10).click({ button: 'middle' });
  await expect(row(10)).toHaveCount(0);
  await expect(header).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await snapshot()).tabs.some((tab) => tab.id === 1)).toBe(false);
  await expect(row(2)).toBeVisible();
  await expect(row(3)).toBeVisible();
  console.log(
    '✓ Button, menu and middle-click close only the result, preserving hidden descendants',
  );

  await reset();
  await filter();
  await row(10).click();
  await expect(row(10)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => domainTest.api.tabs.update(10, { successorTabId: 2 }));
  await row(10).click({ button: 'middle' });
  await expect(row(13)).toHaveAttribute('aria-selected', 'true');
  await row(3).click();
  await expect(row(3)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => domainTest.api.tabs.update(3, { successorTabId: 14 }));
  await row(3).locator('.close-tab').click();
  await expect(row(14)).toHaveAttribute('aria-selected', 'true');
  await row(1).locator('.close-tab').click();
  await expect(row(14)).toHaveAttribute('aria-selected', 'true');
  await reset();
  await filter();
  await row(14).click();
  await expect(row(14)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => domainTest.api.tabs.update(14, { successorTabId: 2 }));
  await row(14).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await expect(row(5)).toHaveAttribute('aria-selected', 'true');
  await row(5).click();
  await expect(row(5)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(async () => {
    await domainTest.api.tabs.update(5, { successorTabId: 2 });
    await domainTest.api.tabs.remove(5);
  });
  await expect(row(3)).toHaveAttribute('aria-selected', 'true');
  console.log(
    '✓ Filtered closes keep visible successors, otherwise activate above then below, including native closes',
  );

  await reset();
  await filter(1, 'newest');
  const created = await page.evaluate(() =>
    domainTest.api.tabs.create({
      windowId: 1,
      url: 'https://youtube.com/new',
      title: 'New video',
      active: false,
    }),
  );
  await expect(row(created.id)).toBeVisible();
  await expect(results.first()).toHaveAttribute('data-id', String(created.id));
  await page.evaluate(
    (id) => domainTest.api.tabs.update(id, { url: 'https://example.com/' }),
    created.id,
  );
  await expect(row(created.id)).toHaveCount(0);
  await page.evaluate(
    (id) => domainTest.api.tabs.update(id, { url: 'https://www.youtube.com/back' }),
    created.id,
  );
  await expect(row(created.id)).toBeVisible();
  await page.evaluate((id) => domainTest.api.tabs.remove(id), created.id);
  await expect(row(created.id)).toHaveCount(0);
  await row(14).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in folder', exact: true }).click();
  await expect(header).toBeHidden();
  await expect(page.locator('#scope-heading')).toHaveText('Later');
  await expect(row(14)).toBeFocused();
  await expect(row(14)).toHaveAttribute('aria-selected', 'true');
  await row(16).click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Filter by domain', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  console.log(
    '✓ Open, navigate and close notifications update results; Show in folder restores the real location',
  );

  await reset();
  await page.keyboard.press('Control+k');
  await search.fill('Woodworking');
  await filter();
  await expect(results).toHaveCount(6);
  await expect(page.locator('#search-wrap')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#search')).toBeHidden();
  await exit.click();
  await expect(header).toBeHidden();
  await expect(page.locator('#breadcrumbs')).toBeVisible();
  await filter();
  await page.keyboard.press('Control+k');
  await expect(header).toBeVisible();
  const domainSearch = page.locator('#domain-search');
  await expect(domainSearch).toBeFocused();
  await domainSearch.fill('Woodworking');
  await expect(results).toHaveCount(2);
  await expect(page.locator('#domain-count')).toHaveText('2 of 6 tabs');
  await page.keyboard.press('Escape');
  await expect(domainSearch).toHaveValue('');
  await expect(results).toHaveCount(6);
  await page.keyboard.press('Escape');
  await expect(header).toBeHidden();
  await filter();
  await page.locator('#new-tab').click();
  await expect(header).toBeHidden();
  console.log(
    '✓ Dedicated domain view stays separate from search; domain search stays scoped; close, Escape and folder actions return to the main interface',
  );

  // Returning from a short result list must restore the original long tree's scroll.
  await page.evaluate(() =>
    domainTest.api.tabs.update(60, { url: 'https://youtube.com/scroll-test' }),
  );
  await row(60).scrollIntoViewIfNeeded();
  const scroll = await page.locator('#tree').evaluate((tree) => tree.scrollTop);
  expect(scroll).toBeGreaterThan(500);
  await filter(60);
  await expect.poll(() => page.locator('#tree').evaluate((tree) => tree.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('#tree').evaluate((tree) => tree.scrollTop)).toBe(scroll);
  await expect(row(60)).toBeFocused();
  await filter(1, 'newest');
  for (const id of await ids()) await row(id).locator('.close-tab').click();
  await expect(results).toHaveCount(0);
  await expect(exit).toBeFocused();
  await expect(header).toBeVisible();
  await expect(page.locator('.empty-state h2')).toHaveText('No tabs from youtube.com');
  await page.locator('.empty-state h2').click();
  await expect(header).toBeVisible();
  await exit.click();
  await expect(header).toBeHidden();
  console.log(
    '✓ Clearing the filter restores scroll; closing the last result leaves a persistent empty view',
  );

  await reset();
  await filter();
  await expect(page.locator('#domain-address')).toBeHidden();
  await page.evaluate(() => domainTest.api.tabs.update(1, { title: 'Building shelves - YouTube' }));
  await expect(row(1).locator('.label')).toHaveText('Building shelves - YouTube');
  await expect(page.locator('#domain-name')).toHaveText('youtube.com');
  await page.evaluate(() =>
    domainTest.api.tabs.update(5, { title: 'Painting landscapes - YouTube', status: 'loading' }),
  );
  await expect(row(5).locator('.label')).toHaveText('Painting landscapes - YouTube');
  await expect(page.locator('#domain-name')).toHaveText('youtube.com');
  await page.evaluate(() => domainTest.api.tabs.update(5, { status: 'complete' }));
  await expect(page.locator('#domain-name')).toHaveText('YouTube');
  await expect(page.locator('#domain-address')).toHaveText('youtube.com');
  await expect(page.locator('#domain-address')).toBeVisible();
  await sort.selectOption('title');
  await expect(page.locator('#domain-name')).toHaveText('YouTube');
  for (const id of await ids()) await row(id).locator('.close-tab').click();
  await expect(results).toHaveCount(0);
  await expect(page.locator('#domain-name')).toHaveText('YouTube');
  await expect(page.locator('#domain-address')).toBeVisible();
  await exit.click();
  await filter(2);
  await expect(page.locator('#domain-address')).toBeHidden();

  await reset();
  const hackerNewsIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><path fill="#ff6600" d="M0 0h36v36H0z"/><path fill="white" d="m9 7 9 14 9-14h-4l-5 9-5-9zm7 13h4v10h-4z"/></svg>')}`;
  await page.evaluate(async (favIconUrl) => {
    await domainTest.api.tabs.update(1, {
      title: 'Hacker News',
      url: 'https://news.ycombinator.com/',
      favIconUrl,
    });
    await domainTest.api.tabs.update(5, {
      title: 'A quieter way to browse the web | Hacker News',
      url: 'https://news.ycombinator.com/item?id=5',
      favIconUrl,
    });
    await domainTest.api.tabs.update(14, {
      title: 'Show HN: A little tool for organising browser tabs | Hacker News',
      url: 'https://news.ycombinator.com/item?id=14',
      favIconUrl,
    });
  }, hackerNewsIcon);
  await expect(row(1).locator('.label')).toHaveText('Hacker News');
  await filter(1, 'newest', 'Hacker News');
  await expect(page.locator('#domain-address')).toHaveText('news.ycombinator.com');
  await expect(page.locator('#domain-count')).toHaveText('3 tabs');
  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 620 });
    const name = await page.locator('#domain-name').boundingBox();
    const address = await page.locator('#domain-address').boundingBox();
    const clear = await exit.boundingBox();
    const bounds = await header.boundingBox();
    expect(address.y).toBeGreaterThanOrEqual(name.y + name.height);
    expect(address.x).toBe(name.x);
    expect(address.x + address.width).toBeLessThan(clear.x);
    expect(address.y + address.height).toBeLessThan(bounds.y + bounds.height);
    expect(await header.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/domain-site-name-${width}.png` });
  }
  await page.setViewportSize({ width: 320, height: 620 });
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await page.screenshot({ path: 'test-results/domain-site-name-dark.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('#domain-address')).toBeVisible();
  await expect(exit).toBeVisible();
  await page.screenshot({ path: 'test-results/domain-site-name-forced-colours.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  console.log(
    '✓ Site names resolve from homepage/shared titles, survive closes, reset between domains and fit above muted addresses at 220–480px',
  );

  await reset();
  await filter();
  await expect(page.locator('#domain-icon img')).toHaveAttribute('src', logo);
  await expect
    .poll(() =>
      page
        .locator('.domain-wash')
        .evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]),
    )
    .toEqual([255, 0, 0, 255]);
  const blue = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0066ff"/></svg>')}`;
  await page.evaluate((favIconUrl) => domainTest.api.tabs.update(1, { favIconUrl }), blue);
  await expect
    .poll(() =>
      page
        .locator('.domain-wash')
        .evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]),
    )
    .toEqual([0, 102, 255, 255]);
  await page.evaluate(() =>
    domainTest.api.tabs.update(1, { favIconUrl: 'data:image/png;base64,broken' }),
  );
  await expect(page.locator('#domain-icon svg')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.domain-wash')
        .evaluate((canvas) => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]),
    )
    .toBe(0);

  // A remote favicon without CORS still produces a visible tint; no pixel readback.
  const remote = base.replace('127.0.0.1', 'localhost') + '/domain-icon.svg';
  await page.route('**/domain-icon.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
    }),
  );
  await page.evaluate((favIconUrl) => domainTest.api.tabs.update(1, { favIconUrl }), remote);
  await expect
    .poll(() =>
      page.locator('#domain-icon img').evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);

  const backgroundPixel = async () => {
    const buffer = await page.screenshot();
    const { data } = await sharp(buffer)
      .extract({ left: 4, top: 4, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return [...data].slice(0, 3);
  };

  await expect
    .poll(async () => {
      const [r, g, b] = await backgroundPixel();
      return r > g + 10 && Math.abs(g - b) < 3;
    })
    .toBe(true);
  await expect
    .poll(() =>
      page.locator('.domain-wash').evaluate((canvas) => {
        try {
          canvas.getContext('2d').getImageData(0, 0, 1, 1);
          return false;
        } catch (error) {
          return error.name === 'SecurityError';
        }
      }),
    )
    .toBe(true);
  await exit.click();
  await filter(2);
  await expect(page.locator('#domain-icon svg')).toBeVisible();
  await expect(page.locator('#domain-name')).toHaveText('fonts.google.com');
  await exit.click();
  await filter();
  let finishIcon;
  const pendingIcon = new Promise((resolve) => {
    finishIcon = resolve;
  });
  await page.route('**/slow-icon.svg', async (route) => {
    await pendingIcon;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
    });
  });
  const delayedUrl = `${base}/slow-icon.svg`;
  await page.evaluate((favIconUrl) => domainTest.api.tabs.update(1, { favIconUrl }), delayedUrl);
  await expect(page.locator('#domain-icon img')).toHaveAttribute('src', delayedUrl);
  await exit.click();
  await filter(2);
  finishIcon();
  // Wait for the abandoned image to finish before checking the new domain.
  await expect
    .poll(() =>
      page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return true;
      }, delayedUrl),
    )
    .toBe(true);
  await expect(page.locator('#domain-icon svg')).toBeVisible();
  await expect(page.locator('#domain-name')).toHaveText('fonts.google.com');
  expect(
    await page
      .locator('.domain-wash')
      .evaluate((canvas) => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]),
  ).toBe(0);
  console.log(
    '✓ Header uses favicon colours, updates live, handles broken/missing icons and paints remote icons without pixel access',
  );

  await reset();
  await filter(1, 'newest');
  const longTitle =
    'Building a small oak writing desk from start to finish — choosing timber, cutting traditional joints, assembling the frame and applying a durable hand-rubbed finish, with practical tips for your first woodworking project';
  await page.evaluate(async (title) => {
    await domainTest.api.tabs.update(1, { title });
    await domainTest.api.tabs.update(14, {
      title: 'The woodworking tools I use every day and how to choose your first set',
    });
    await domainTest.api.tabs.update(5, {
      title: 'Painting a quiet landscape with watercolours — a complete guide for beginners',
    });
  }, longTitle);
  await expect(row(1).locator('.label')).toHaveText(longTitle);
  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 620 });
    const box = await header.boundingBox();
    const favicon = await page.locator('#domain-icon').boundingBox();
    const name = await page.locator('#domain-name').boundingBox();
    const clear = await exit.boundingBox();
    expect(favicon.width).toBeGreaterThanOrEqual(32);
    expect(favicon.x + favicon.width).toBeLessThan(name.x);
    expect(name.x + name.width).toBeLessThan(clear.x);
    expect(clear.x + clear.width).toBeLessThanOrEqual(box.width);
    await expect(exit).toBeVisible();
    const count = await page.locator('#domain-count').boundingBox();
    const sorter = await sort.boundingBox();
    if (Math.abs(count.y - sorter.y) < 8) expect(count.x + count.width).toBeLessThan(sorter.x);
    else expect(count.y + count.height).toBeLessThanOrEqual(sorter.y);
    expect(sorter.x + sorter.width).toBeLessThanOrEqual(width);
    const geometry = await results.evaluateAll((rows) =>
      rows.map((row) => {
        const rect = row.getBoundingClientRect();
        const label = row.querySelector('.label').getBoundingClientRect();
        const icon = row.querySelector('.icon-slot').getBoundingClientRect();
        const close = row.querySelector('.close-tab').getBoundingClientRect();
        return {
          id: Number(row.dataset.id),
          top: rect.top,
          bottom: rect.bottom,
          titleHeight: label.height,
          lineHeight: parseFloat(getComputedStyle(row.querySelector('.label')).lineHeight),
          iconCentre: icon.top + icon.height / 2 - label.top,
          closeCentre: close.top + close.height / 2 - label.top,
          fits: label.right <= close.left && row.scrollWidth <= row.clientWidth,
        };
      }),
    );
    for (const [index, item] of geometry.entries()) {
      expect(item.titleHeight).toBeLessThanOrEqual(3 * item.lineHeight);
      expect(item.iconCentre).toBe(item.lineHeight / 2);
      expect(item.closeCentre).toBe(item.lineHeight / 2);
      expect(item.fits).toBe(true);
      if (index) expect(item.top).toBeGreaterThanOrEqual(geometry[index - 1].bottom);
    }
    const longest = geometry.find((item) => item.id === 1);
    expect(longest.titleHeight).toBe(3 * longest.lineHeight);
    const shortest = geometry.find((item) => item.id === 10);
    expect(shortest.titleHeight).toBe(shortest.lineHeight);
    await page.screenshot({ path: `test-results/domain-header-${width}.png` });
  }
  await send('setLook', { partial: true, value: { domains: true } });
  await expect(row(1).locator('.row-detail')).toHaveText('youtube.com');
  expect(
    await row(1)
      .locator('.label')
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(54);
  const detail = await row(1).locator('.row-detail').boundingBox();
  const titleBox = await row(1).locator('.label').boundingBox();
  const rowBox = await row(1).boundingBox();
  expect(detail.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
  expect(detail.y + detail.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  await send('setLook', { partial: true, value: { domains: false } });
  await page.setViewportSize({ width: 220, height: 620 });
  await page.evaluate(() => domainTest.api.tabs.update(1, { title: 'Unbroken'.repeat(80) }));
  await expect(row(1).locator('.label')).toHaveText('Unbroken'.repeat(80));
  expect(
    await row(1)
      .locator('.label')
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(54);
  expect(await row(1).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.evaluate((title) => domainTest.api.tabs.update(1, { title }), longTitle);
  await exit.click();
  await expect(row(1).locator('.label')).toHaveCSS('white-space', 'nowrap');
  await filter(1, 'newest');
  await page.setViewportSize({ width: 320, height: 620 });
  await page.screenshot({ path: 'test-results/domain-wrapped-results-320.png' });
  console.log(
    '✓ Result titles wrap to three lines at 220–480px, keep short rows compact and support website lines and unbroken titles',
  );
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.screenshot({ path: 'test-results/domain-header-dark.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('.domain-wash')).toBeHidden();
  await expect(exit).toBeVisible();
  await page.evaluate(() =>
    domainTest.api.tabs.update(1, {
      url: 'https://a-very-long-domain-name-for-testing.example.com/',
    }),
  );
  await exit.click();
  await row(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await page.setViewportSize({ width: 220, height: 620 });
  await expect(page.locator('#domain-name')).toHaveAttribute(
    'title',
    'a-very-long-domain-name-for-testing.example.com',
  );
  expect(await header.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(exit).toBeVisible();
  await page.screenshot({ path: 'test-results/domain-header-forced-colours.png' });
  expect(errors).toEqual([]);
  console.log(
    '✓ Domain header and close button remain usable at 220–480px and in dark/forced colours',
  );
} finally {
  await close();
}
