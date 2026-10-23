import { instrumentSidebar, instrumentDemo } from '../helpers/probes/later.js';
import { instrumentRows } from '../helpers/probes/rows.js';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 400, height: 740 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const rowSource = await readFile('extension/src/sidebar/rows.js', 'utf8');
await page.route('**/extension/src/sidebar/rows.js', (route) =>
  route.fulfill({ contentType: 'application/javascript', body: instrumentRows(rowSource) }),
);
const sidebar = await readFile('extension/src/sidebar.js', 'utf8');
await page.route('**/extension/src/sidebar.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: instrumentSidebar(sidebar),
  }),
);
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: instrumentDemo(demo),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => laterTest.send(type, args), [type, args]);
const pane = page.locator('#later-view');
const trigger = page.getByRole('button', { name: 'Saved for Later', exact: true });
const row = (id) => pane.locator(`.later-row[data-id="${id}"]`);
const search = pane.getByRole('searchbox');

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  expect(
    await page
      .locator('footer button')
      .evaluateAll((buttons) => buttons.map((button) => button.id)),
  ).toEqual([
    'new-tab',
    'new-group',
    'tree-toggle',
    'later-toggle',
    'domains-toggle',
    'recently-closed-toggle',
    'settings',
  ]);
  const treeScroll = await page.locator('#tree').evaluate((node) => {
    node.scrollTop = 160;
    return node.scrollTop;
  });
  await trigger.click();
  await expect(pane.getByRole('heading', { name: 'Saved for Later', exact: true })).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Nothing saved for later' })).toBeVisible();
  await expect(page.locator('#tree')).toBeHidden();
  await expect(page.locator('#tree .row, #pinned-tabs .row')).toHaveCount(0);
  expect(await page.evaluate(() => treeLifecycleState())).toEqual({
    tabs: 0,
    index: false,
    wrappers: 0,
  });
  await expect(page.locator('#navigation-capsule')).toBeHidden();
  await expect(page.locator('#tree-toggle')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(await page.locator('#tree').evaluate((node) => node.scrollTop)).toBeCloseTo(treeScroll, 0);

  await page.locator('#tree .tab-row[data-id="1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save for later', exact: true }).click();
  await expect(page.locator('#tree .tab-row[data-id="1"]')).toHaveCount(0);
  await expect(page.locator('#tree .tab-row[data-id="2"]')).toBeVisible();
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree .tab-row[data-id="1"]')).toBeVisible();

  for (const id of [7, 6, 5, 4, 3, 2, 1]) await send('saveForLater', { id });
  await trigger.click();
  await expect(pane.locator('.later-row')).toHaveCount(7);
  await expect(pane.locator('.later-row').first()).toHaveAttribute('data-id', '1');
  await expect(pane.getByRole('status')).toHaveText('7 tabs');
  await expect(row(7)).toBeVisible();
  await row(1).hover();
  await expect(page.locator('#toast')).toBeHidden({ timeout: 6000 });
  await expect(
    pane.locator(
      '.later-filters, .later-preview-options, .later-read, .later-article-details, .later-excerpt, .later-domain, .later-time',
    ),
  ).toHaveCount(0);
  const longTitle =
    'A saved page with a long title that stays on one line while keeping all its original words available in the tooltip — ' +
    'more details '.repeat(20);
  await page.evaluate(
    (title) =>
      laterTest.api.tabs.update(7, {
        title,
        isArticle: true,
        articlePreview: {
          title: 'An obsolete preview title',
          byline: 'Old author',
          excerpt: 'Old excerpt',
        },
      }),
    longTitle,
  );
  await expect(row(7).locator('.later-label')).toHaveText(longTitle);
  await expect(row(7).locator('.later-open-tab')).toHaveAttribute('aria-label', longTitle);
  await expect(row(7).locator('.later-open-tab')).toHaveAttribute(
    'title',
    `${longTitle}\nhttps://maps.google.com/`,
  );
  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 740 });
    await row(7).scrollIntoViewIfNeeded();
    const geometry = await row(7).evaluate((node) => {
      const label = node.querySelector('.later-label');
      const rect = label.getBoundingClientRect();
      const actions = node.querySelector('.later-row-actions').getBoundingClientRect();
      return {
        height: rect.height,
        whiteSpace: getComputedStyle(label).whiteSpace,
        rowHeight: node.getBoundingClientRect().height,
        right: rect.right,
        actionsLeft: actions.left,
        actionsRight: actions.right,
      };
    });
    expect(geometry.rowHeight).toBe(30);
    expect(geometry.whiteSpace).toBe('nowrap');
    expect(geometry.height).toBeLessThan(30);
    expect(geometry.right).toBeLessThanOrEqual(geometry.actionsLeft);
    expect(geometry.actionsRight).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/later-plain-${width}.png` });
  }
  await page.setViewportSize({ width: 400, height: 360 });
  const laterScroll = await pane.locator('.later-content').evaluate((node) => {
    node.scrollTop = 100;
    return node.scrollTop;
  });
  await trigger.click();
  await expect(pane.locator('.later-row')).toHaveCount(0);
  await trigger.click();
  expect(await pane.locator('.later-content').evaluate((node) => node.scrollTop)).toBeCloseTo(
    laterScroll,
    0,
  );
  await page.setViewportSize({ width: 400, height: 740 });
  await pane.locator('.later-content').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: 'test-results/later-all-400.png' });

  await expect(row(2).locator('.later-label')).toHaveText(
    'How the London Underground map was designed',
  );
  await expect(pane.locator('.later-row')).toHaveCount(7);
  await row(2).locator('.later-open-tab').click();
  await expect(row(2).locator('.later-open-tab')).toHaveAttribute('aria-current', 'true');
  await expect(pane).toBeVisible();
  await search.fill('OAK');
  await expect(pane.locator('.later-row')).toHaveCount(1);
  await expect(row(5)).toBeVisible();
  await pane.getByRole('combobox').selectOption('oldest');
  await trigger.click();
  await expect(pane.locator('.later-row')).toHaveCount(0);
  await expect(page.locator('#tree .row').first()).toBeVisible();
  await page.evaluate(() =>
    laterTest.api.tabs.update(5, { title: 'Solid oak desk updated while closed' }),
  );
  await trigger.click();
  await expect(search).toHaveValue('OAK');
  await expect(pane.getByRole('combobox')).toHaveValue('oldest');
  await expect(pane.locator('.later-row')).toHaveCount(1);
  await expect(row(5).locator('.later-label')).toHaveText('Solid oak desk updated while closed');
  await search.fill('nothing matches');
  await expect(pane.getByRole('heading', { name: 'No matching tabs' })).toBeVisible();
  await search.fill('');
  await pane.getByRole('combobox').selectOption('oldest');
  const times = await send('snapshot');
  const first = await pane.locator('.later-row').first().getAttribute('data-id');
  expect(times.tabs.find((tab) => tab.id === Number(first)).savedForLaterAt).toBe(
    Math.min(...times.tabs.filter((tab) => tab.savedForLaterAt).map((tab) => tab.savedForLaterAt)),
  );
  await pane.getByRole('combobox').selectOption('newest');

  await pane.locator('#later-close').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(1).locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('End');
  await expect(pane.locator('.later-row').last().locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(1).locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Return to original folder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toBeVisible();
  await row(1).getByRole('button', { name: 'Return to Design', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(row(1)).toHaveCount(0);
  expect((await send('snapshot')).tabs.find((tab) => tab.id === 1).savedForLaterAt).toBeUndefined();

  await expect(pane.locator('.later-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Domains', exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator('#domains-view')).toBeVisible();
  await expect(pane.locator('.later-row')).toHaveCount(0);
  await trigger.click();
  await expect(page.locator('#domains-view')).toBeHidden();
  await expect(page.locator('#domains-view .domains-row')).toHaveCount(0);
  await expect(pane).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(pane).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toBeVisible();

  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.setViewportSize({ width: 320, height: 620 });
  await page.screenshot({ path: 'test-results/later-dark-320.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  expect(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const boxes = await page.locator('footer button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  expect(boxes.every((box) => box.left >= 0 && box.right <= 220)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: 'test-results/later-forced-colours-220.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.setViewportSize({ width: 400, height: 740 });

  await row(2).locator('.later-open-tab').click();
  await row(2).getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect(row(2)).toHaveCount(0);
  await expect(pane.locator('.later-row')).toHaveCount(5);
  expect((await send('snapshot')).tabs.some((tab) => tab.id === 3)).toBe(true);
  for (const id of [3, 4, 5, 6, 7]) await send('closeTab', { id });
  await expect(pane.getByRole('heading', { name: 'Nothing saved for later' })).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Saved for Later: plain rows, single-line titles, save/undo, search, sorting, return, safe close, footer order, keyboard and themes',
  );
} finally {
  await close();
}
