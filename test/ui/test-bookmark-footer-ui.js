import { expect } from '@playwright/test';
import { startUiTest, composingKey } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 620 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pane = page.locator('#bookmarks-view');
const add = page.locator('#new-tab');
const folder = page.locator('#new-group');
const dialog = page.locator('#dialog');
const menu = page.locator('#menu');
const search = pane.getByRole('searchbox');
const trigger = page.getByRole('button', { name: 'Bookmarks', exact: true });
const send = (type, args = {}) =>
  page.evaluate(
    async ([type, args]) =>
      (await tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    [type, args],
  );
const bookmarks = () => page.evaluate(() => tabernacleDemoSession.browser.bookmarks.getTree());
const cancel = () => dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  const before = await send('snapshot');
  await trigger.click();
  await expect(add).toHaveAccessibleName('New bookmark');
  await expect(folder).toHaveAccessibleName('New bookmark folder');
  for (const [name, rootId, title] of [
    ['Bookmarks', 'menu________', 'Bookmarks Menu'],
    ['Toolbar', 'toolbar_____', 'Bookmarks Toolbar'],
    ['Other', 'unfiled_____', 'Other Bookmarks'],
  ]) {
    await pane.getByRole('tab', { name, exact: true }).click();
    await expect(add).toHaveAttribute('title', `New bookmark in ${title}`);
    await expect(folder).toHaveAttribute('title', `New bookmark folder in ${title}`);
    await folder.press('Space');
    await expect(pane).toBeVisible();
    await expect(dialog.locator('#dialog-title')).toHaveText('New bookmark folder');
    await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText(title);
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} folder`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    const createdFolder = pane.getByRole('treeitem', { name: `${name} folder`, exact: true });
    await expect(createdFolder).toBeFocused();
    await createdFolder.click();
    // Focusing a nested folder does not change the footer's selected root destination.
    await add.press('Enter');
    await expect(pane).toBeVisible();
    await expect(dialog.locator('#dialog-title')).toHaveText('New bookmark');
    await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText(title);
    await expect(dialog.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue(
      before.tabs.find((tab) => tab.active).url,
    );
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} bookmark`);
    await dialog
      .getByRole('textbox', { name: 'Address', exact: true })
      .fill('https://example.test/footer');
    if (name === 'Other') {
      await page.evaluate(() => {
        const api = tabernacleDemoSession.browser.bookmarks;
        const create = api.create;
        api.create = async (...args) => {
          api.create = create;
          await create(...args);
          throw new Error('Lost footer creation reply');
        };
      });
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(dialog.locator('#dialog-error')).toContainText('Lost footer creation reply');
    }
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      pane.getByRole('treeitem', { name: `${name} bookmark`, exact: true }),
    ).toBeFocused();
    const root = (await bookmarks())[0].children.find((node) => node.id === rootId);
    expect(root.children.filter((node) => node.title === `${name} folder`)).toHaveLength(1);
    expect(root.children.filter((node) => node.title === `${name} bookmark`)).toHaveLength(1);
  }
  const after = await send('snapshot');
  expect(after.tabs).toEqual(before.tabs);
  expect(after.groups).toEqual(before.groups);
  expect(after.view).toEqual(before.view);

  // Searching and cancelling keep both the panel and query; right-click never offers tab actions.
  await search.fill('missing result');
  await add.click();
  await expect(dialog).toBeVisible();
  await cancel();
  await expect(search).toHaveValue('missing result');
  await expect(pane).toBeVisible();
  expect(await composingKey(add, 'F10')).toBe(false);
  for (const keyboard of [true, false]) {
    if (keyboard) await add.press('Shift+F10');
    else await add.click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['New bookmark…', 'New folder…']);
    await menu.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
    await expect(dialog.getByLabel('Bookmark folder', { exact: true })).toHaveText(
      'Other Bookmarks',
    );
    await cancel();
  }
  await search.fill('');

  // Missing permission disables creation even after unrelated tab-state updates.
  await page.evaluate(() =>
    tabernacleDemoSession.browser.permissions.remove({ permissions: ['bookmarks'] }),
  );
  await expect(pane.getByRole('button', { name: 'Allow bookmarks' })).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(folder).toBeDisabled();
  await send('setLook', { value: { folderCounts: true }, partial: true });
  await expect(add).toBeDisabled();
  await expect(folder).toBeDisabled();
  await pane.getByRole('button', { name: 'Allow bookmarks' }).click();
  await expect(add).toBeEnabled();
  await expect(folder).toBeEnabled();

  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser.bookmarks;
    window.savedFooterRead = api.getTree;
    api.getTree = async () => {
      throw new Error('Footer bookmark read failed');
    };
  });
  await trigger.click();
  await expect(pane.getByRole('status')).toContainText('Footer bookmark read failed');
  await expect(add).toBeDisabled();
  await expect(folder).toBeDisabled();
  await page.evaluate(() => {
    tabernacleDemoSession.browser.bookmarks.getTree = savedFooterRead;
  });
  await pane.getByRole('button', { name: 'Try again' }).click();
  await expect(add).toBeEnabled();
  await expect(folder).toBeEnabled();
  await page.screenshot({ path: 'test-results/bookmark-footer-320.png' });

  // Returning to tabs restores their actions and labels without touching the bookmarks.
  const saved = await bookmarks();
  await pane.getByRole('button', { name: 'Back to tabs' }).click();
  await expect(add).toHaveAccessibleName('New tab');
  await expect(folder).toHaveAccessibleName('New folder');
  await add.press('Shift+F10');
  await expect(menu.getByRole('menuitem')).toHaveText(['New tab', 'New folder…']);
  await page.keyboard.press('Escape');
  await folder.click();
  await expect(dialog.getByLabel('Folder name', { exact: true })).toBeFocused();
  await cancel();
  await add.click();
  expect((await send('snapshot')).tabs.length).toBe(before.tabs.length + 1);
  expect(await bookmarks()).toEqual(saved);
  expect(errors).toEqual([]);
  console.log(
    '✓ Bookmark footer creation: roots, keyboard, search, menus, retry, permissions, failed reads and restored tab actions',
  );
} finally {
  await close();
}
