import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 740 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const row = (id) => page.locator(`[data-bookmark-id="${id}"]`);
const dialog = page.locator('#dialog');
const menu = page.locator('#menu');
const search = page.getByRole('searchbox', { name: 'Search bookmarks' });
const recovery = page.locator('.bookmark-recovery-status');
const review = recovery.getByRole('button', { name: 'Review changes', exact: true });
const send = (type, args = {}) =>
  page.evaluate(
    async ([type, args]) =>
      (await tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    [type, args],
  );
const nodes = () =>
  page.evaluate(async () => {
    const { indexBookmarks } = await import('/extension/src/bookmark-edit.js');
    return [
      ...indexBookmarks(await tabernacleDemoSession.browser.bookmarks.getTree()).byId.values(),
    ];
  });

const itemMenu = async (id, action) => {
  await row(id).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
};

const save = async (label = 'Save') => {
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).not.toBeVisible();
};

async function drag(id, targetId, fraction = 0.5, cancel = false) {
  const from = await row(id).boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 7, { steps: 3 });
  const to = await row(targetId).boundingBox();
  await page.mouse.move(to.x + 40, to.y + to.height * fraction, { steps: 5 });
  if (fraction === 0.5) await expect(row(targetId)).toHaveClass(/drop-inside/);
  else
    await expect(page.locator('#bookmarks-view .move-preview')).toContainText(
      'Already in this folder.',
    );
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('tab', { name: 'Toolbar', exact: true }).click();
  await expect(recovery).toBeHidden();
  await page.getByRole('button', { name: 'Bookmark actions', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Unfinished changes…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row('design-bookmarks').click();
  await expect(row('design-bookmarks').locator('..').locator('.bookmark-row .label')).toHaveText([
    'Design references',
    'Google Fonts',
    'MDN Web Docs',
  ]);
  const savedOrder = await nodes();
  await row('mdn-bookmark').focus();
  await page.evaluate(() =>
    tabernacleDemoSession.browser.bookmarks.update('mdn-bookmark', { title: 'A reference' }),
  );
  await expect(row('design-bookmarks').locator('..').locator('.bookmark-row .label')).toHaveText([
    'Design references',
    'A reference',
    'Google Fonts',
  ]);
  await expect(row('mdn-bookmark')).toBeFocused();
  expect((await nodes()).find((node) => node.id === 'mdn-bookmark').index).toBe(
    savedOrder.find((node) => node.id === 'mdn-bookmark').index,
  );
  const tabs = (await send('snapshot')).tabs;
  await row('mdn-bookmark').press('F2');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Web reference');
  await dialog
    .getByRole('textbox', { name: 'Address', exact: true })
    .fill('https://reference.test/edited');
  await save();
  await expect(row('mdn-bookmark')).toBeFocused();
  expect((await nodes()).find((node) => node.id === 'mdn-bookmark').url).toBe(
    'https://reference.test/edited',
  );

  await row('design-bookmarks').press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Rename folder…' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Project references');
  await save();
  await expect(row('design-bookmarks')).toHaveAttribute('aria-label', 'Project references');

  // Empty folders delete immediately through both the menu and the keyboard.
  for (const method of ['menu', 'keyboard']) {
    await itemMenu('design-bookmarks', 'New folder…');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Empty folder');
    await save('Create');
    const empty = (await nodes()).find((node) => node.title === 'Empty folder');
    await expect(row(empty.id)).toBeFocused();
    if (method === 'menu') await itemMenu(empty.id, 'Delete folder');
    else {
      await page.evaluate((id) => {
        const api = tabernacleDemoSession.browser.bookmarks;
        const remove = api.remove;
        api.remove = async (target) => {
          api.remove = remove;
          if (target === id) throw new Error('Folder deletion failed');
          return remove(target);
        };
      }, empty.id);
      await row(empty.id).press('Delete');
      await expect(page.locator('#toast')).toContainText('Folder deletion failed');
      await expect(dialog).not.toBeVisible();
      await expect(row(empty.id)).toBeVisible();
      await review.click();
      await dialog.getByRole('button', { name: 'Retry change' }).click();
      await expect(dialog).toContainText('Change completed.');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await expect(row(empty.id)).toHaveCount(0);
    await expect(dialog).not.toBeVisible();
    if (method === 'menu') await expect(row('design-bookmarks')).toBeFocused();
  }

  // An empty subfolder or a hidden separator still makes its parent non-empty.
  for (const type of ['folder', 'separator']) {
    const parent = await page.evaluate(async (type) => {
      const api = tabernacleDemoSession.browser.bookmarks;
      const parent = await api.create({ parentId: 'design-bookmarks', title: 'Contains an item' });
      await api.create({
        parentId: parent.id,
        type,
        title: type === 'folder' ? 'Empty child' : '',
      });
      return parent.id;
    }, type);
    await itemMenu(parent, 'Delete folder…');
    await expect(page.locator('#dialog-description')).toContainText(
      type === 'folder' ? '0 bookmarks, 1 folder' : '1 separator',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await nodes()).some((node) => node.id === parent)).toBe(true);
    await row(parent).press('Delete');
    await save('Delete');
    await expect(row(parent)).toHaveCount(0);
  }

  await itemMenu('design-bookmarks', 'New folder…');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Saved reading');
  await save('Create');
  const folder = (await nodes()).find((node) => node.title === 'Saved reading');
  expect(folder.parentId).toBe('design-bookmarks');
  await row(folder.id).press('ArrowRight');
  await page.getByRole('button', { name: `New bookmark in ${folder.title}`, exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Useful page');
  await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill('not an address');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('complete bookmark address');
  await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill('https://useful.test/');
  await save('Create');
  const bookmark = (await nodes()).find((node) => node.title === 'Useful page');
  expect(bookmark.parentId).toBe(folder.id);

  // Moves choose a folder; the alphabetical projection never rewrites sibling order.
  await row(bookmark.id).press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Move…' }).click();
  await dialog.getByLabel('Bookmark folder', { exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Find a folder' }).fill('Project references');
  await dialog.getByRole('treeitem', { name: 'Project references', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Position' })).toHaveCount(0);
  await save('Move');
  const beforeReorder = await nodes();
  await search.fill('Web reference');
  await expect(row('mdn-bookmark')).toBeVisible();
  await search.fill('');

  // Dragging within a folder leaves Firefox order intact; crossing folders still moves.
  await drag(bookmark.id, 'mdn-bookmark', 0.95);
  expect(await nodes()).toEqual(beforeReorder);
  await itemMenu(bookmark.id, 'Move…');
  await save('Move');
  expect(await nodes()).toEqual(beforeReorder);
  await drag(bookmark.id, folder.id);
  await expect
    .poll(async () => (await nodes()).find((node) => node.id === bookmark.id).parentId)
    .toBe(folder.id);
  await expect(row(bookmark.id)).toBeVisible();
  const beforeCancel = await nodes();
  await drag(bookmark.id, 'design-bookmarks', 0.5, true);
  expect(await nodes()).toEqual(beforeCancel);
  expect((await send('snapshot')).tabs).toEqual(tabs);

  await page.getByRole('tab', { name: 'Toolbar', exact: true }).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: /Delete|Rename|Move/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A changed external bookmark is protected and the user's draft stays visible.
  await itemMenu('mdn-bookmark', 'Edit bookmark…');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Draft change');
  await page.evaluate(() =>
    tabernacleDemoSession.browser.bookmarks.update('mdn-bookmark', { title: 'Changed in Firefox' }),
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('have changed');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Draft change',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await nodes()).find((node) => node.id === 'mdn-bookmark').title).toBe(
    'Changed in Firefox',
  );

  // Lost replies keep a retryable record; reopening the pane can finish it once.
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser.bookmarks;
    const original = api.create;
    let failed = false;
    api.create = async (args) => {
      const result = await original(args);
      if (!failed) {
        failed = true;
        throw new Error('Lost create reply');
      }
      return result;
    };
  });
  await row(folder.id).press('ArrowRight');
  await page.getByRole('button', { name: `New bookmark in ${folder.title}`, exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Retry reference');
  await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill('https://retry.test/');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('Lost create reply');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(review).toBeVisible();
  const pending = await send('getBookmarkEdits');
  await page.evaluate(() => {
    const api = tabernacleDemoSession.browser;
    window.recoveryRead = api.storage.local.get;
    api.storage.local.get = async (key) => {
      if (key === 'tabernacle.bookmark-edits.v1') throw new Error('Recovery read failed');
      return recoveryRead(key);
    };
    api.storage.onChanged.emit({ 'tabernacle.bookmark-edits.v1': {} }, 'local');
  });
  await expect(recovery).toContainText('Could not check bookmark changes. Recovery read failed');
  await expect(review).toBeVisible();
  await page.evaluate(() => {
    tabernacleDemoSession.browser.storage.local.get = recoveryRead;
  });
  await recovery.getByRole('button', { name: 'Check changes again' }).click();
  await expect(recovery).toContainText('A bookmark change needs attention.');
  expect(await send('getBookmarkEdits')).toEqual(pending);
  await page.getByRole('button', { name: 'Back to tabs' }).click();
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await review.click();
  await dialog.getByRole('button', { name: 'Retry change' }).click();
  await expect(dialog).toContainText('Change completed.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(recovery).toBeHidden();
  expect((await nodes()).filter((node) => node.title === 'Retry reference')).toHaveLength(1);

  await row(folder.id).press('Delete');
  await expect(page.locator('#dialog-description')).toContainText('2 bookmarks, 0 folders');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row(folder.id)).toBeVisible();
  await row(folder.id).press('Delete');
  await save('Delete');
  await expect(row(folder.id)).toHaveCount(0);
  expect((await nodes()).some((node) => node.id === bookmark.id)).toBe(false);

  await row('fonts-bookmark').click({ button: 'right' });
  await page.evaluate(() => tabernacleDemoSession.browser.bookmarks.remove('fonts-bookmark'));
  await expect(row('fonts-bookmark')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Move…' }).click();
  await expect(page.locator('#toast')).toContainText('no longer available');
  await expect(dialog).not.toBeVisible();

  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  await itemMenu('mdn-bookmark', 'Edit bookmark…');
  await page.screenshot({ path: 'test-results/bookmark-editing-dark.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/bookmark-editing-forced-colours.png' });
  expect(errors).toEqual([]);
  console.log(
    '✓ Alphabetical bookmarks, preserved native order and focus, folder moves, cancellation, contextual recovery, protected roots, deletion and narrow themes',
  );
} finally {
  await close();
}
