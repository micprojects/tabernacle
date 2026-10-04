import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 360, height: 720 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const name = page.getByLabel('Group name', { exact: true });
const destination = page.getByLabel('Create in', { exact: true });
const search = page.getByRole('searchbox', { name: 'Find a group' });
const tree = page.getByRole('tree', { name: 'Destination groups' });
const folder = (label) => tree.getByRole('treeitem', { name: label, exact: true });

try {
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source +
        '\nwindow.pickerTest = { request: (...args) => request(...args), getState: () => state };',
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.locator('#new-group').click();
  await expect(destination).toHaveText('Home');
  await expect(name).toBeFocused();
  await name.fill('Reading');
  await page.screenshot({ path: 'test-results/create-folder-default.png' });
  await destination.click();
  await expect(search).toBeFocused();
  await expect(folder('Home')).toHaveAttribute('aria-selected', 'true');
  await tree.getByRole('button', { name: 'Expand Work' }).click();
  await expect(folder('Design')).toBeVisible();
  await expect(destination).toHaveText('Home');
  await page.screenshot({ path: 'test-results/create-folder-picker.png' });
  await folder('Design').click();
  await expect(destination).toHaveText('Home / Work / Design');
  await expect(destination).toBeFocused();
  await expect(tree).toBeHidden();
  await expect(name).toHaveValue('Reading');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  expect(
    await page.evaluate(
      () => window.pickerTest.getState().groups.find((g) => g.name === 'Reading').parentId,
    ),
  ).toBe('design');
  console.log(
    '✓ The field defaults to Home, browses nested folders, and creates in the chosen parent',
  );

  await page.locator('[data-key="group:design"]').dblclick();
  await page.locator('#new-group').click();
  await expect(destination).toHaveText('Home / Work / Design');
  await name.fill('Keyboard group');
  await destination.press('ArrowDown');
  await expect(search).toBeFocused();
  await search.fill('not a folder');
  await expect(page.getByText('No groups found.', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(page.locator('#dialog')).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.pickerTest.getState().groups.some((g) => g.name === 'Keyboard group'),
    ),
  ).toBe(false);
  await search.fill('wOrK / reSeArCh');
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(folder('Research').locator('.folder-picker-path')).toHaveText(
    'Home / Work / Research',
  );
  await search.press('ArrowDown');
  await expect(folder('Research')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(destination).toHaveText('Home / Work / Research');
  await expect(name).toHaveValue('Keyboard group');
  await destination.click();
  await search.press('Escape');
  await expect(tree).toBeHidden();
  await expect(destination).toBeFocused();
  await expect(page.locator('#dialog')).toBeVisible();
  await destination.click();
  await page.locator('#dialog').click({ position: { x: 5, y: 5 } });
  await expect(tree).toBeHidden();
  await expect(name).toHaveValue('Keyboard group');
  await destination.click();
  await search.fill('Home');
  await search.press('Enter');
  await expect(destination).toHaveText('Home');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  expect(
    await page.evaluate(
      () => window.pickerTest.getState().groups.find((g) => g.name === 'Keyboard group').parentId,
    ),
  ).toBe(null);
  console.log(
    '✓ Nested defaults, path search, keyboard selection, Escape and outside clicks preserve the name',
  );

  await page.locator('#new-group').click();
  await expect(destination).toHaveText('Home / Work / Design');
  await destination.click();
  await search.press('ArrowDown');
  await expect(folder('Home')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(folder('Work')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(folder('Work')).toHaveAttribute('aria-expanded', 'false');
  await expect(folder('Design')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(folder('Work')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(folder('Design')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(folder('Work')).toBeFocused();
  await page.keyboard.press('End');
  await expect(folder('Keyboard group')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(folder('Home')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).toBeHidden();
  console.log('✓ Tree arrows, Home and End work; a new form resets to the current folder');

  const longName = 'A very long destination folder name that should fit inside a narrow sidebar';
  const duplicate = await page.evaluate(async (longName) => {
    const { request } = window.pickerTest;
    const other = await request('createGroup', { name: 'Design', parentId: 'personal' });
    await request('createGroup', { name: longName, parentId: 'personal' });
    for (let i = 0; i < 25; i++)
      await request('createGroup', { name: `Folder ${i}`, parentId: null });
    return other.createdGroupId;
  }, longName);
  await page.locator('#new-group').click();
  await name.fill('Keep this name');
  await destination.click();
  await search.fill('Design');
  await expect(folder('Design')).toHaveCount(2);
  await folder('Design').filter({ hasText: 'Home / Personal / Design' }).click();
  await expect(destination).toHaveText('Home / Personal / Design');
  await page.evaluate(
    (id) => window.pickerTest.request('removeGroup', { id, groupIds: [id], tabIds: [] }),
    duplicate,
  );
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('no longer exists');
  await expect(name).toHaveValue('Keep this name');
  await destination.click();
  await search.fill(longName);
  await folder(longName).click();
  await expect(destination).toHaveText(`Home / Personal / ${longName}`);
  for (const viewport of [
    { width: 320, height: 660 },
    { width: 220, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'dark' });
    await destination.click();
    const popup = page.locator('.folder-picker-popup');
    const box = await popup.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await popup.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await search.fill('Folder 24');
    await expect(folder('Folder 24')).toBeVisible();
    await page.screenshot({ path: `test-results/create-folder-dark-${viewport.width}.png` });
    await search.press('Escape');
  }
  await page.locator('#dialog-cancel').click();
  await page.setViewportSize({ width: 360, height: 720 });
  await page.locator('#home').click();
  await page.locator('[data-key="group:design"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
  await expect(destination).toHaveCount(0);
  await expect(name).toHaveValue('Design');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).toBeHidden();
  expect(errors).toEqual([]);
  console.log(
    '✓ Duplicate names, deleted destinations, dark/narrow layouts and dialog cleanup work',
  );
} finally {
  await close();
}
