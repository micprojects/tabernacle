import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 740 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: demo
      .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
      .replace(
        'const memberships = {};',
        `
      entries[0] = ['Shared page first', 'design', 'https://example.test/same'];
      entries[1] = ['Shared page second', 'design', 'https://example.test/same'];
      entries[2] = ['Shared page third', 'research', 'https://example.test/same'];
      entries[3] = ['Shared article', 'design', 'https://example.test/article'];
      entries[4] = ['Shared other folder', 'personal', 'https://example.test/other'];
      const memberships = {};`,
      )
      .replace(
        'return controller;',
        'window.collectionTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => collectionTest.send(type, args), [type, args]);
const row = (id) => page.locator(`#tree .tab-row[data-id="${id}"]`);
const later = page.locator('#later-view');
const snapshot = () => send('snapshot');

const captureLayouts = async (name) => {
  for (const mode of ['light', 'dark', 'forced']) {
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
    });
    for (const width of [220, 320, 480]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `test-results/collection-${name}-${mode}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await page.setViewportSize({ width: 320, height: 740 });
};

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row(1)).toBeVisible();
  await send('saveForLater', { id: 4 });
  await send('saveForLater', { id: 5 });
  await send('enterGroup', { id: 'work' });
  await page.keyboard.press('Control+k');
  await page.locator('#search').fill('Shared');
  await expect(page.locator('.saved-search-results .tab-row')).toHaveCount(1);
  await expect(row(4)).toBeVisible();
  await captureLayouts('saved-search');
  await row(4).click();
  await expect(page.locator('#search')).toHaveValue('Shared');
  expect((await snapshot()).tabs.find((tab) => tab.id === 4).savedForLaterAt).toBeTruthy();
  await row(4).click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#search')).toHaveValue('Shared');
  await row(4).getByRole('button', { name: 'Return to original folder' }).click();
  await expect(page.locator('#search')).toHaveValue('Shared');
  await expect(page.locator('.saved-search-results')).toHaveCount(0);
  await expect(row(4)).toBeVisible();
  await page.keyboard.press('Escape');

  await row(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#domain-search')).toBeFocused();
  await page.locator('#domain-search').fill('Shared');
  await expect(page.locator('#domain-count')).toHaveText('4 of 4 tabs');
  await page.locator('#domain-search').fill('page');
  await expect(page.locator('#tree .tab-row')).toHaveCount(3);
  await page.locator('#domain-sort').selectOption('least-viewed');
  await captureLayouts('domain-search');
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Save 3 tabs for later', exact: true }).click();
  await expect(page.locator('#domain-count')).toHaveText('0 of 1 tab');
  const saved = (await snapshot()).tabs.filter((tab) => tab.savedForLaterAt);
  expect(saved.map((tab) => tab.id).sort()).toEqual([1, 2, 3, 5]);
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(3);
  expect((await snapshot()).tabs.filter((tab) => tab.savedForLaterAt).map((tab) => tab.id)).toEqual(
    [5],
  );

  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Review duplicates…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(
    dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Close 2 tabs', exact: true })).toBeEnabled();
  await dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }).check();
  await expect(page.locator('#dialog-submit')).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }).uncheck();
  // Navigation removes stale candidates; a new duplicate is never silently added.
  await page.evaluate(() =>
    collectionTest.api.tabs.update(3, { url: 'https://example.test/changed' }),
  );
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
  await page.evaluate(() =>
    collectionTest.api.tabs.create({
      windowId: 1,
      url: 'https://example.test/same',
      title: 'New duplicate',
      active: false,
    }),
  );
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
  for (const mode of ['light', 'dark', 'forced']) {
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
    });
    for (const width of [220, 320, 480]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/collection-duplicates-${mode}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await dialog.getByRole('button', { name: 'Close 1 tab', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await snapshot()).tabs.some((tab) => tab.id === 2)).toBe(false);
  expect((await snapshot()).tabs.some((tab) => tab.id === 3)).toBe(true);
  await page.locator('#domain-search').fill('article');
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Close 1 tab…', exact: true }).click();
  await expect(page.locator('#dialog-cancel')).toBeFocused();
  await page.getByRole('button', { name: 'Close 1 tab', exact: true }).click();
  expect((await snapshot()).tabs.some((tab) => tab.id === 4)).toBe(false);

  await page.locator('#later-toggle').click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#later-search')).toBeFocused();
  await page.locator('#later-search').fill('Shared');
  await later
    .locator('.later-row')
    .getByRole('button', { name: 'Return to Personal', exact: true })
    .click();
  await expect(later).toBeVisible();
  await expect(page.locator('#later-search')).toHaveValue('Shared');
  await expect(page.locator('#later-search')).toBeFocused();
  await page.locator('#toast').getByRole('button', { name: 'Show in folder' }).click();
  await expect(later).toBeHidden();
  await expect(page.locator('#scope-heading')).toHaveText('Personal');
  // The result set includes rows outside the viewport. A batch must process them all.
  await page.evaluate(async () => {
    for (let i = 0; i < 240; i++)
      await collectionTest.api.tabs.create({
        windowId: 1,
        url: `https://large.test/${i}`,
        title: `Large collection ${i}`,
        active: false,
      });
  });
  await send('enterGroup', { id: null });
  const large = page.locator('#tree .tab-row').filter({ hasText: 'Large collection 0' }).first();
  await expect(large).toBeVisible();
  await large.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(240);
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Save 240 tabs for later', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(0);
  expect((await snapshot()).tabs.filter((tab) => tab.savedForLaterAt).length).toBe(240);
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(240);
  await page.locator('#domain-close').click();
  await send('enterGroup', { id: null });
  const folderState = await snapshot();
  const expectedFolderIds = folderState.tabs
    .filter((tab) => ['work', 'design', 'research'].includes(tab.groupId) && !tab.savedForLaterAt)
    .map((tab) => tab.id);
  await page.locator('[data-key="group:work"]').click({ button: 'right' });
  const folderSave = page.getByRole('menuitem', {
    name: `Save tabs for later (${expectedFolderIds.length})`,
    exact: true,
  });
  await expect(folderSave).toBeVisible();
  const opened = await send('newTab', { groupId: 'work' });
  const newId = opened.tabs.find(
    (tab) => !folderState.tabs.some((before) => before.id === tab.id),
  ).id;
  await folderSave.click();
  const afterFolderSave = await snapshot();
  expect(
    afterFolderSave.tabs
      .filter((tab) => tab.savedForLaterAt)
      .map((tab) => tab.id)
      .sort(),
  ).toEqual(expectedFolderIds.sort());
  expect(afterFolderSave.tabs.find((tab) => tab.id === newId).savedForLaterAt).toBeFalsy();
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await snapshot()).tabs.some((tab) => tab.savedForLaterAt)).toBe(false);
  expect(errors).toEqual([]);
  console.log(
    '✓ Scoped saved search, domain search/sort, batch save/undo/close, stable duplicate review and Later return',
  );
} finally {
  await close();
}
