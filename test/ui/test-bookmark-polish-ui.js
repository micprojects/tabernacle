import { expect } from '@playwright/test';
import { startUiTest, composingKey } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pane = page.locator('#bookmarks-view');
const search = pane.getByRole('searchbox', { name: 'Search bookmarks' });
const row = (id) => pane.locator(`[data-bookmark-id="${id}"]`);
const dialog = page.locator('#dialog');
const menu = page.locator('#menu');
const trigger = page.getByRole('button', { name: 'Bookmarks', exact: true });

async function option(label) {
  await pane.getByRole('button', { name: 'Bookmark actions', exact: true }).click();
  await menu.getByRole('menuitem', { name: label, exact: true }).click();
}

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(
    pane.locator('.pane-heading').getByRole('button', { name: /^New bookmark/ }),
  ).toHaveCount(0);
  await expect(pane.locator('.bookmarks-results')).toBeHidden();
  await pane.getByRole('tab', { name: 'Other', exact: true }).click();
  await expect(pane.getByText('No bookmarks in Other Bookmarks.')).toBeVisible();
  await pane.getByRole('tab', { name: 'Toolbar', exact: true }).click();
  await expect(row('design-bookmarks').locator('.bookmark-count')).toHaveText('2');
  await search.fill('mozilla MDN');
  await expect(row('mdn-bookmark')).toBeVisible();
  await expect(row('mdn-bookmark').locator('.label mark')).toHaveText('MDN');
  await expect(row('mdn-bookmark').locator('.bookmark-address mark')).toHaveText('mozilla');
  await expect(pane.locator('.bookmarks-results')).toHaveText('1 match');
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await trigger.click();
  await expect(search).toHaveValue('mozilla MDN');
  await expect(row('mdn-bookmark')).toBeVisible();
  await row('mdn-bookmark').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Show in folder' }).click();
  await expect(search).toHaveValue('');
  await expect(row('mdn-bookmark')).toBeFocused();
  await expect(row('fonts-bookmark')).toBeVisible();
  await search.fill('MDN mozilla');
  expect(await composingKey(search, 'Enter')).toBe(false);
  await expect(pane).toBeVisible();
  await search.press('ArrowDown');
  await expect(row('mdn-bookmark')).toBeFocused();
  await search.focus();
  await search.press('Enter');
  await expect(pane).toBeHidden();
  await trigger.click();
  await expect(search).toHaveValue('MDN mozilla');
  await search.fill('no match');
  await expect(pane.getByText('No matching bookmarks.', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Clear bookmark search' }).click();
  await expect(search).toBeFocused();

  // An explicit collapse survives reopening, including the empty expansion set.
  await option('Collapse all folders');
  await expect(pane.locator('.bookmark-row')).toHaveCount(2);
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await trigger.click();
  await expect(pane.locator('.bookmark-row')).toHaveCount(2);
  await option('Expand all folders');
  await expect(row('mdn-bookmark')).toBeVisible();

  // Put a destination in this location for the same-root hover cancellation check.
  await page.evaluate(() =>
    tabernacleDemoSession.browser.bookmarks.move('reading-bookmarks', { parentId: 'toolbar_____' }),
  );
  await expect(row('reading-bookmarks')).toBeVisible();
  await row('reading-bookmarks').click();

  // Hover expansion is temporary until a valid drop; Escape keeps the panel open.
  await row('reading-bookmarks').click();
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'false');
  const from = await row('news-bookmark').boundingBox();
  const to = await row('reading-bookmarks').boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 7, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 5 });
  await expect(pane.locator('.move-preview')).toContainText('Into “Reading”');
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.locator('.move-preview')).toHaveCount(0);
  await expect(pane).toBeVisible();

  // Context-menu creation follows its folder and uses the shared searchable picker.
  await row('design-bookmarks').focus();
  await row('design-bookmarks').press('ArrowRight');
  await row('design-bookmarks').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  const destination = dialog.getByLabel('Bookmark folder', { exact: true });
  await expect(destination).toContainText('Design references');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('New reading');
  await destination.click();
  const folderSearch = dialog.getByRole('searchbox', { name: 'Find a folder' });
  const pickerTree = dialog.getByRole('tree', { name: 'Destination folders' });
  await expect(pickerTree.getByRole('treeitem', { name: 'Home', exact: true })).toHaveCount(0);
  await folderSearch.fill('Reading');
  await expect(pickerTree.getByRole('treeitem')).toHaveCount(1);
  await expect(pickerTree.locator('.folder-picker-path')).toHaveText('Bookmarks Toolbar / Reading');
  await folderSearch.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(destination).toBeFocused();
  await expect(destination).toHaveText('Bookmarks Toolbar / Reading');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const created = pane.getByRole('treeitem', { name: 'New reading', exact: true });
  await expect(created).toBeFocused();
  const createdId = await created.getAttribute('data-bookmark-id');
  expect(
    await page.evaluate(
      async (id) => (await tabernacleDemoSession.browser.bookmarks.get(id))[0].parentId,
      createdId,
    ),
  ).toBe('reading-bookmarks');
  await created.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', repeat: true, bubbles: true }),
    ),
  );
  await expect(created).toBeVisible();

  // Move destinations exclude the moving folder and its descendants.
  await row('reading-bookmarks').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Move…' }).click();
  await destination.click();
  await folderSearch.fill('reading');
  await expect(pickerTree.getByRole('treeitem')).toHaveCount(0);
  await folderSearch.press('Escape');
  await expect(destination).toBeFocused();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Preserve scroll without retaining inactive DOM rows.
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++)
      await tabernacleDemoSession.browser.bookmarks.create({
        parentId: 'toolbar_____',
        title: `Reference ${i}`,
        url: `https://example.test/${i}`,
      });
  });
  await expect(pane.getByRole('treeitem', { name: 'Reference 59', exact: true })).toHaveCount(1);
  const list = pane.locator('#bookmarks-tree');
  await list.evaluate((node) => {
    node.scrollTop = 700;
  });
  const scroll = await list.evaluate((node) => node.scrollTop);
  await pane.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
  await expect(list).toHaveJSProperty('scrollTop', 0);
  await pane.getByRole('tab', { name: 'Toolbar', exact: true }).click();
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(scroll);
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await expect(pane.getByRole('treeitem')).toHaveCount(0);
  await trigger.click();
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(scroll);

  // Reviewable captures of the actual panel and picker, with narrow themes checked.
  await search.fill('Mozilla MDN');
  await page.screenshot({ path: 'test-results/bookmark-polish-search.png' });
  await row('mdn-bookmark').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Move…' }).click();
  await destination.click();
  await folderSearch.fill('reading');
  await page.screenshot({ path: 'test-results/bookmark-polish-picker.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await page.screenshot({ path: 'test-results/bookmark-polish-picker-forced-colours.png' });
  await folderSearch.press('Escape');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await page.screenshot({ path: 'test-results/bookmark-polish-search-forced-colours.png' });
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(async () =>
    (await tabernacleDemoSession.ready).request({
      type: 'setLook',
      windowId: 1,
      value: { colorScheme: 'dark' },
      partial: true,
    }),
  );
  await page.screenshot({ path: 'test-results/bookmark-polish-dark.png' });
  expect(errors).toEqual([]);
  console.log(
    '✓ Bookmark search feedback, context-menu creation, folder counts, view restoration, cancellable drag expansion, searchable destinations and narrow themes',
  );
} finally {
  await close();
}
