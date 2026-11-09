import { expect } from '@playwright/test';
import { startUiTest, composingKey } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 620 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const send = (type, args = {}) =>
  page.evaluate(
    async ([type, args]) =>
      (await tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    [type, args],
  );
const pane = page.locator('#bookmarks-view');
const trigger = page.getByRole('button', { name: 'Bookmarks', exact: true });
const search = page.getByRole('searchbox', { name: 'Search bookmarks' });
const row = (id) => page.locator(`[data-bookmark-id="${id}"]`);
const fold = page.locator('#tree-toggle');

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Domains', exact: true })).toHaveCount(0);
  await send('setGroupContainer', { id: 'work', cookieStoreId: 'firefox-container-2' });
  const treeStyle = await page
    .locator('#tree .group-row')
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: style.minHeight,
        gap: style.gap,
        font: getComputedStyle(node.querySelector('.label')).fontSize,
      };
    });
  await page.locator('[data-key="group:design"]').dblclick();
  const addStyle = await page
    .locator('#tree .new-tab-action')
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return { height: style.minHeight, padding: style.padding, radius: style.borderRadius };
    });
  const before = await send('snapshot');
  await trigger.click();
  await expect(pane).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.locator('#tree .row')).toHaveCount(0);
  await expect(fold).toBeEnabled();
  await expect(fold).toHaveAttribute('aria-controls', 'bookmarks-tree');
  await expect(pane.locator('.bookmarks-destination-label')).toHaveText('Open in Design');
  await expect(pane.locator('.bookmarks-container')).not.toBeEmpty();
  await expect(pane.getByRole('tab', { name: 'Bookmarks', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(row('reading-bookmarks')).toBeVisible();
  await expect(row('menu________')).toHaveCount(0);
  const originalBookmarks = await page.evaluate(() =>
    tabernacleDemoSession.browser.bookmarks.getTree(),
  );
  await expect(fold).toHaveAccessibleName('Expand all in Bookmarks Menu');
  await fold.focus();
  await fold.press('Enter');
  await expect(pane).toBeVisible();
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toHaveAccessibleName('Collapse all in Bookmarks Menu');
  await expect(fold).toHaveAttribute('data-icon', 'collapse');
  await expect(fold).toBeFocused();
  await fold.press('Space');
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'false');
  await expect(fold).toHaveAttribute('data-icon', 'expand');
  await fold.click();
  await pane.getByRole('tab', { name: 'Other', exact: true }).click();
  await expect(fold).toBeDisabled();
  await expect(fold).toHaveAttribute('title', 'Nothing to expand or collapse here');
  await pane.getByRole('tab', { name: 'Toolbar', exact: true }).click();
  await expect(fold).toHaveAccessibleName('Expand all in Bookmarks Toolbar');
  await fold.click();
  await expect(row('mdn-bookmark')).toBeVisible();
  await fold.click();
  await expect(row('mdn-bookmark')).toHaveCount(0);
  await pane.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
  await expect(row('reading-bookmarks')).toHaveAttribute('aria-expanded', 'true');
  await pane.getByRole('tab', { name: 'Toolbar', exact: true }).click();
  expect((await send('snapshot')).view).toEqual(before.view);
  expect(await page.evaluate(() => tabernacleDemoSession.browser.bookmarks.getTree())).toEqual(
    originalBookmarks,
  );
  await expect(row('design-bookmarks')).toHaveAttribute('aria-expanded', 'false');
  expect(
    await row('design-bookmarks').evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: style.minHeight,
        gap: style.gap,
        font: getComputedStyle(node.querySelector('.label')).fontSize,
      };
    }),
  ).toEqual(treeStyle);
  await row('design-bookmarks').click();
  await expect(page.locator('#toast')).toBeHidden();
  await expect(row('mdn-bookmark')).toBeVisible();
  await expect(pane.locator('.bookmark-row button')).toHaveCount(0);

  // Bookmark counts use the live tab-folder setting and the same visibility rule.
  const bookmarkCount = row('design-bookmarks').locator('.bookmark-count');
  await expect(bookmarkCount).toBeHidden();
  await send('setLook', { value: { folderCounts: true }, partial: true });
  await expect(bookmarkCount).toBeVisible();
  await expect(bookmarkCount).toHaveText('2');
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await expect(fold).toHaveAttribute('aria-controls', 'tree');
  await expect(fold).toHaveAccessibleName(/all in Design$/);
  await expect(page.locator('#tree')).toHaveClass(/show-folder-counts/);
  await send('setLook', { value: { folderCounts: false }, partial: true });
  await expect(page.locator('#tree')).not.toHaveClass(/show-folder-counts/);
  await trigger.click();
  await expect(bookmarkCount).toBeHidden();

  // The shared add row ends the branch with the same curve, including an empty folder.
  const add = pane.getByRole('button', { name: 'New bookmark in Design references', exact: true });
  expect(
    await add.evaluate((node) => {
      const style = getComputedStyle(node);
      return { height: style.minHeight, padding: style.padding, radius: style.borderRadius };
    }),
  ).toEqual(addStyle);
  expect(
    await add.evaluate((node) => getComputedStyle(node.parentElement, '::before').maskImage),
  ).toContain('tree-guide-end.svg');
  await send('setLook', { value: { connectingLines: false }, partial: true });
  expect(
    await add.evaluate((node) => getComputedStyle(node.parentElement, '::before').content),
  ).toBe('none');
  await expect(add).toBeVisible();
  await send('setLook', { value: { connectingLines: true }, partial: true });
  await row('fonts-bookmark').press('ArrowDown');
  await expect(add).toBeFocused();
  expect(await composingKey(add, 'Enter')).toBe(false);
  await add.press('Enter');
  const dialog = page.locator('#dialog');
  await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText(
    'Bookmarks Toolbar / Design references',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row('design-bookmarks')).toBeFocused();
  await add.focus();
  await add.press('ArrowLeft');
  await expect(row('design-bookmarks')).toBeFocused();
  await add.focus();
  await add.press('ArrowUp');
  await expect(row('fonts-bookmark')).toBeFocused();
  await add.press('Shift+F10');
  await page.locator('#menu').getByRole('menuitem', { name: 'New bookmark…', exact: true }).click();
  await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText(
    'Bookmarks Toolbar / Design references',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.screenshot({ path: 'test-results/bookmarks-tree-controls-320.png' });
  await row('design-bookmarks').press('ArrowRight');
  await expect(row('mdn-bookmark')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row('design-bookmarks')).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await search.fill('developer.mozilla');
  await expect(fold).toBeDisabled();
  await expect(fold).toHaveAttribute(
    'title',
    'Clear search to expand or collapse bookmark folders',
  );
  await expect(pane.locator('.bookmark-add')).toHaveCount(0);
  await expect(pane.getByRole('treeitem')).toHaveCount(2);
  await expect(row('mdn-bookmark')).toBeVisible();
  expect(await composingKey(search, 'Escape')).toBe(false);
  await expect(search).toHaveValue('developer.mozilla');
  await search.fill('no match');
  await expect(pane.getByRole('status')).toHaveText('No matching bookmarks.');
  await search.press('Escape');
  await expect(fold).toBeEnabled();
  await expect(search).toHaveValue('');
  await expect(pane).toBeVisible();
  await search.fill('MDN');
  await page.screenshot({ path: 'test-results/bookmarks-search-320.png' });
  await row('mdn-bookmark').click();
  await expect(pane).toBeHidden();
  const after = await send('snapshot');
  const created = after.tabs.find((tab) => !before.tabs.some((old) => old.id === tab.id));
  expect(created.url).toBe('https://developer.mozilla.org/');
  expect(created.groupId).toBe('design');
  expect(created.cookieStoreId).toBe('firefox-container-2');
  expect(after.groups).toEqual(before.groups);
  expect(after.domainPins).toEqual(before.domainPins);
  await expect(page.locator('#scope-heading')).toHaveText('Design');

  // Live bookmark edits retain focus and a failed read leaves the last good tree.
  await trigger.click();
  await expect(search).toHaveValue('MDN');
  await page.getByRole('button', { name: 'Clear bookmark search' }).click();
  await row('mdn-bookmark').focus();
  await page.evaluate(() =>
    tabernacleDemoSession.browser.bookmarks.update('mdn-bookmark', {
      title: 'Mozilla documentation',
    }),
  );
  await expect(row('mdn-bookmark')).toHaveAttribute('aria-label', 'Mozilla documentation');
  await expect(row('mdn-bookmark')).toBeFocused();
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser;
    window.savedBookmarkRead = api.bookmarks.getTree;
    api.bookmarks.getTree = async () => {
      throw new Error('Read failed');
    };
    api.bookmarks.onChanged.emit();
  });
  await expect(pane.getByRole('status')).toContainText('Could not load bookmarks');
  await expect(row('mdn-bookmark')).toBeVisible();
  await search.fill('Mozilla');
  await expect(pane.getByRole('status')).toContainText('Could not load bookmarks');
  await search.fill('');
  await page.evaluate(() => {
    tabernacleDemoSession.browser.bookmarks.getTree = savedBookmarkRead;
  });
  await pane.getByRole('button', { name: 'Try again' }).click();
  await expect(pane.locator('.bookmarks-status')).toBeHidden();

  // Opening errors stay visible and the same user retry cannot duplicate a tab.
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser;
    window.savedBookmarkUpdate = api.tabs.update;
    let failed = false;
    api.tabs.update = async (id, changes) => {
      const result = await savedBookmarkUpdate(id, changes);
      if (changes.url && !failed) {
        failed = true;
        throw new Error('Lost opening reply');
      }
      return result;
    };
  });
  const count = (await send('snapshot')).tabs.length;
  await row('mdn-bookmark').click();
  await expect(page.locator('#toast')).toContainText('Lost opening reply');
  await expect(pane).toBeVisible();
  await row('mdn-bookmark').click();
  await expect(pane).toBeHidden();
  expect((await send('snapshot')).tabs.length).toBe(count + 1);

  await trigger.click();
  await page.evaluate(() =>
    tabernacleDemoSession.browser.permissions.remove({ permissions: ['bookmarks'] }),
  );
  await expect(pane.getByRole('button', { name: 'Allow bookmarks' })).toBeVisible();
  await expect(fold).toBeDisabled();
  await expect(pane.getByRole('treeitem')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Allow bookmarks' }).click();
  await expect(row('design-bookmarks')).toBeVisible();
  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.screenshot({ path: 'test-results/bookmarks-dark-320.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.screenshot({ path: 'test-results/bookmarks-forced-colours-220.png' });
  await search.focus();
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(pane.getByRole('treeitem')).toHaveCount(0);
  await expect(page.locator('#scope-heading')).toHaveText('Design');

  // Domain filtering remains available on ordinary tabs.
  await page.emulateMedia({ forcedColors: 'none' });
  await page.locator(`[data-key="tab:${created.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain' }).click();
  await expect(page.locator('#domain-header')).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Bookmark folders, quick search, tree styling, opening, containers, retry, live edits, permissions, keyboard and themes',
  );
} finally {
  await close();
}
