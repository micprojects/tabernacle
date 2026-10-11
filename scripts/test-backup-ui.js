import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';
import { exportFolderBackup } from '../extension/src/folder-backup.js';

const { page, base, close } = await startUiTest({ viewport: { width: 1180, height: 980 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) =>
      (await window.tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    { type, args },
  );
const chooseFile = (value) =>
  page.locator('#backup-file').setInputFiles({
    name: 'folders.json',
    mimeType: 'application/json',
    buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  });
const preview = () => page.getByRole('button', { name: 'Preview import', exact: true }).click();
const commit = () => page.getByRole('button', { name: 'Import folders', exact: true }).click();
const value = exportFolderBackup(
  [
    { id: 'work', name: 'Work', parentId: null, appearance: { icon: 'keyboard', color: 'blue' } },
    {
      id: 'new',
      name: 'Saved research',
      parentId: 'work',
      defaultCookieStoreId: 'source-container',
      appearance: { icon: 'book', color: 'purple' },
    },
    { id: 'child', name: 'Articles', parentId: 'new' },
  ],
  [{ cookieStoreId: 'source-container', name: 'Archive', color: 'blue', icon: 'briefcase' }],
);

try {
  await page.goto(`${base}/extension/settings.html?demo#backup`);
  await expect(
    page.getByRole('heading', { name: 'Backup and restore', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#backup-export')).toBeEnabled();
  const before = await send('snapshot');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^tabernacle-folders-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.folders).toHaveLength(before.groups.length);
  expect(exported.tabs).toBeUndefined();
  await chooseFile('{bad');
  await expect(page.locator('#backup-error')).toContainText('invalid');
  await expect(page.locator('#backup-preview')).toBeHidden();
  await chooseFile(value);
  await expect(page.locator('#backup-file-status')).toContainText('3 folders');
  await preview();
  await expect(page.locator('#backup-preview-counts')).toHaveText(
    '2 folders to create · 1 folder to reuse',
  );
  await expect(page.locator('#backup-preview-tree li')).toHaveCount(3);
  await expect(page.locator('#backup-import')).toBeDisabled();
  expect((await send('getFolderBackupState')).groups).toEqual(before.groups);
  await page.getByLabel('Archive', { exact: true }).selectOption('create');
  await expect(page.locator('#backup-import')).toBeEnabled();
  await page.screenshot({ path: 'test-results/backup-preview-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await send('getFolderBackupState')).groups).toEqual(before.groups);
  await expect(page.locator('#backup-preview-button')).toBeFocused();
  await preview();
  await page.getByLabel('Archive', { exact: true }).selectOption('create');
  await commit();
  await expect(page.locator('#backup-status')).toContainText('Imported 2 folders · Reused 1');
  let state = await send('snapshot');
  expect(state.tabs).toEqual(before.tabs);
  expect(state.groups.find((group) => group.id === 'work').appearance).toBeUndefined();
  expect(state.groups.find((group) => group.name === 'Saved research').appearance).toEqual({
    icon: 'book',
    color: 'purple',
  });
  await preview();
  await expect(page.locator('#backup-preview-counts')).toHaveText(
    '0 folders to create · 3 folders to reuse',
  );
  await expect(page.locator('#backup-container-mappings select')).toHaveCount(0);
  await commit();
  expect((await send('getFolderBackupState')).groups).toHaveLength(before.groups.length + 2);
  console.log(
    '✓ JSON download/upload, preview, cancellation, additive import and repeat import preserve tabs and existing settings',
  );

  await page.locator('#backup-destination').selectOption('existing');
  await page.getByLabel('Destination folder', { exact: true }).press('ArrowDown');
  await page.getByRole('searchbox', { name: 'Find a folder' }).fill('Personal');
  await page.getByRole('searchbox', { name: 'Find a folder' }).press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Destination folder', { exact: true })).toHaveText(
    'Home / Personal',
  );
  await preview();
  await expect(page.locator('#backup-preview-destination')).toHaveText(
    'Import into Home / Personal',
  );
  await expect(page.getByLabel('Archive', { exact: true })).toHaveValue(
    state.containers.find((item) => item.name === 'Archive').cookieStoreId,
  );
  // Change the tree from another surface after this preview was prepared.
  await send('createGroup', { name: 'Concurrent folder' });
  await commit();
  await expect(page.locator('#backup-status')).toContainText('Review the updated preview');
  expect(
    (await send('getFolderBackupState')).groups.some(
      (group) => group.parentId === 'personal' && group.name === 'Work',
    ),
  ).toBe(false);
  await commit();
  await expect(page.locator('#backup-status')).toContainText('Imported 3 folders');
  expect(
    (await send('getFolderBackupState')).groups.some(
      (group) => group.parentId === 'personal' && group.name === 'Work',
    ),
  ).toBe(true);

  await page.locator('#backup-destination').selectOption('new');
  await page.getByLabel('New folder name', { exact: true }).fill('From another computer');
  await preview();
  await expect(page.locator('#backup-preview-destination')).toHaveText(
    'Import into Home / Personal / From another computer',
  );
  for (const width of [720, 360, 220]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('#backup-import')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/backup-preview-dark-${width}.png`,
      fullPage: true,
    });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: 'test-results/backup-forced-colours.png', fullPage: true });
  await commit();
  await expect(page.locator('#backup-status')).toContainText('Created destination folder');
  state = await send('getFolderBackupState');
  expect(state.groups.find((group) => group.name === 'From another computer').parentId).toBe(
    'personal',
  );
  expect(errors).toEqual([]);
  console.log(
    '✓ Existing/new destinations, keyboard picker, container suggestions, stale preview and responsive themes work',
  );
} finally {
  await close();
}
