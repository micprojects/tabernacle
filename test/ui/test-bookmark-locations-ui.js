import { expect } from '@playwright/test';
import { startUiTest, composingKey } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 620 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pane = page.locator('#bookmarks-view');
const tab = (name) => pane.getByRole('tab', { name, exact: true });
const row = (id) => pane.locator(`[data-bookmark-id="${id}"]`);
const search = pane.getByRole('searchbox', { name: 'Search bookmarks' });
const menu = page.locator('#menu');
const dialog = page.locator('#dialog');
const tree = () => page.evaluate(() => tabernacleDemoSession.browser.bookmarks.getTree());
const node = (id) =>
  page.evaluate(async (id) => (await tabernacleDemoSession.browser.bookmarks.get(id))[0], id);

async function action(label) {
  await pane.getByRole('button', { name: 'Bookmark actions', exact: true }).click();
  await menu.getByRole('menuitem', { name: label, exact: true }).click();
}

async function drop(id, name, cancel = false) {
  const source = await row(id).boundingBox();
  const target = await tab(name).boundingBox();
  await page.mouse.move(source.x + 40, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 40, source.y + source.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await expect(tab(name)).toHaveClass(/drop-inside/);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(tab('Bookmarks')).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByRole('tab')).toHaveText(['Bookmarks', 'Toolbar', 'Other']);
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-level', '1');
  await expect(
    pane.locator(
      '[data-bookmark-id="menu________"], [data-bookmark-id="toolbar_____"], [data-bookmark-id="unfiled_____"]',
    ),
  ).toHaveCount(0);
  const original = await tree();
  await search.fill('MDN');
  await expect(pane.getByRole('treeitem')).toHaveCount(0);
  await tab('Bookmarks').focus();
  expect(await composingKey(tab('Bookmarks'), 'ArrowRight')).toBe(false);
  await expect(tab('Bookmarks')).toHaveAttribute('aria-selected', 'true');
  await tab('Bookmarks').press('ArrowRight');
  await expect(tab('Toolbar')).toBeFocused();
  await expect(tab('Toolbar')).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByRole('tabpanel')).toHaveAccessibleName('Toolbar');
  await expect(row('mdn-bookmark')).toHaveAttribute('aria-level', '2');
  await expect(search).toHaveValue('MDN');
  await tab('Toolbar').press('End');
  await expect(tab('Other')).toBeFocused();
  await expect(pane.getByRole('treeitem')).toHaveCount(0);
  await tab('Other').press('Home');
  await expect(tab('Bookmarks')).toBeFocused();
  await tab('Bookmarks').press('ArrowDown');
  await expect(search).toBeFocused();
  expect(await tree()).toEqual(original);
  await action('New folder…');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tab('Bookmarks')).toBeFocused();
  await expect(search).toHaveValue('MDN');
  await search.press('Escape');

  // The selected root is the default creation destination, including an empty location.
  await action('New folder…');
  await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText('Bookmarks Menu');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Root folder');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const folder = pane.getByRole('treeitem', { name: 'Root folder', exact: true });
  await expect(folder).toBeFocused();
  const folderId = await folder.getAttribute('data-bookmark-id');
  expect((await node(folderId)).parentId).toBe('menu________');
  await folder.click();
  await expect(
    folder.locator('..').getByRole('button', { name: 'New bookmark in Root folder' }),
  ).toBeVisible();
  await tab('Other').click();
  await expect(pane.getByRole('status')).toHaveText('No bookmarks in Other Bookmarks.');
  await search.press('ArrowDown');
  await expect(
    pane.getByRole('button', { name: 'New bookmark in Other Bookmarks', exact: true }),
  ).toBeFocused();
  await pane.getByRole('button', { name: 'New bookmark in Other Bookmarks', exact: true }).click();
  await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText('Other Bookmarks');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Across locations');
  await dialog
    .getByRole('textbox', { name: 'Address', exact: true })
    .fill('https://example.test/across');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const created = pane.getByRole('treeitem', { name: 'Across locations', exact: true });
  await expect(created).toBeFocused();
  const id = await created.getAttribute('data-bookmark-id');
  expect((await node(id)).parentId).toBe('unfiled_____');

  // A cancelled root drop changes neither the location nor the native tree.
  const beforeCancel = await tree();
  await drop(id, 'Toolbar', true);
  await expect(tab('Other')).toHaveAttribute('aria-selected', 'true');
  expect(await tree()).toEqual(beforeCancel);
  await drop(id, 'Bookmarks');
  await expect(tab('Bookmarks')).toHaveAttribute('aria-selected', 'true');
  await expect(row(id)).toBeFocused();
  expect((await node(id)).parentId).toBe('menu________');

  // The existing Move picker still spans every root and reveals the result in its new location.
  await row(id).press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Move…', exact: true }).click();
  await dialog.getByLabel('Bookmark folder', { exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Find a folder' }).fill('Other Bookmarks');
  await dialog.getByRole('treeitem', { name: 'Other Bookmarks', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(tab('Other')).toHaveAttribute('aria-selected', 'true');
  await expect(row(id)).toBeFocused();
  expect((await node(id)).parentId).toBe('unfiled_____');

  // A lost native move response remains recoverable through the existing receipt, without duplicates.
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser.bookmarks;
    const move = api.move;
    api.move = async (...args) => {
      api.move = move;
      await move(...args);
      throw new Error('Lost root move reply');
    };
  });
  await drop(id, 'Toolbar');
  await expect(page.locator('#toast')).toContainText('Lost root move reply');
  await action('Unfinished changes…');
  await dialog.getByRole('button', { name: 'Retry change' }).click();
  await expect(dialog).toContainText('Change completed.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await tab('Toolbar').click();
  await expect(row(id)).toBeVisible();
  expect((await node(id)).parentId).toBe('toolbar_____');
  expect(
    (await tree())[0].children.flatMap((root) => root.children).filter((entry) => entry.id === id),
  ).toHaveLength(1);

  // The last location survives reopening; a new sidebar starts at Bookmarks Menu.
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(tab('Toolbar')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await expect(tab('Bookmarks')).toHaveAttribute('aria-selected', 'true');
  await tab('Toolbar').click();
  await row('design-bookmarks').click();
  await page.screenshot({ path: 'test-results/bookmark-locations-light.png' });
  await page.evaluate(async () =>
    (await tabernacleDemoSession.ready).request({
      type: 'setLook',
      windowId: 1,
      value: { colorScheme: 'dark' },
      partial: true,
    }),
  );
  await page.screenshot({ path: 'test-results/bookmark-locations-dark.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  for (const item of await pane.getByRole('tab').all())
    expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/bookmark-locations-forced-colours.png' });
  expect(errors).toEqual([]);
  console.log(
    '✓ Bookmark locations: default, keyboard, scoped search, contextual creation, cross-root moves, cancellation, lost-reply recovery and narrow themes',
  );
} finally {
  await close();
}
