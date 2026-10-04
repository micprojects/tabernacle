import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 660 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const createFolder = async (name) => {
  await page.locator('#new-group').click();
  await page.getByLabel('Group name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.locator('.group-row').filter({ hasText: name }).dblclick();
  await expect(page.locator('#scope-heading')).toHaveText(name);
};

try {
  // Simulate changes from another sidebar without adding hooks to the extension.
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: source + '\nwindow.breadcrumbRequest = (type, args) => request(type, args);',
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const crumbs = page.locator('#breadcrumbs .crumb');
  const overflow = page.locator('#path-overflow');
  const menu = page.getByRole('menu', { name: 'Full group path' });
  const current = page.locator('#scope-heading');
  await expect(crumbs).toHaveText(['']);
  await page.locator('[data-key="group:design"]').dblclick();
  await expect(crumbs).toHaveText(['', 'Work', 'Design']);
  await expect(overflow).toHaveCount(0);
  const homeFolders = page.getByRole('button', { name: 'Show groups in Home', exact: true });
  const workFolders = page.getByRole('button', { name: 'Show groups in Work', exact: true });
  const workMenu = page.getByRole('menu', { name: 'Groups in Work', exact: true });
  const homeMenu = page.getByRole('menu', { name: 'Groups in Home', exact: true });
  await workFolders.click();
  await expect(workFolders).toHaveAttribute('aria-expanded', 'true');
  await expect(workMenu.getByRole('menuitem')).toHaveText(['Design', 'Research']);
  await expect(workMenu.getByRole('menuitem', { name: 'Design', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/breadcrumbs-child-folders.png' });
  await workFolders.click();
  await expect(workMenu).toBeHidden();
  await expect(workFolders).toHaveAttribute('aria-expanded', 'false');
  await expect(workFolders).toBeFocused();
  await workFolders.press('ArrowDown');
  await expect(workMenu.getByRole('menuitem', { name: 'Design', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(current).toHaveText('Research');
  await expect(current).toBeFocused();
  await expect(workMenu).toBeHidden();
  await homeFolders.click();
  await expect(homeMenu.getByRole('menuitem')).toHaveText([
    'Work',
    'Design',
    'Research',
    'Personal',
    'Later',
  ]);
  const workLabel = await homeMenu
    .getByRole('menuitem', { name: 'Work', exact: true })
    .locator('.path-label')
    .boundingBox();
  const designLabel = await homeMenu
    .getByRole('menuitem', { name: 'Design', exact: true })
    .locator('.path-label')
    .boundingBox();
  expect(designLabel.x).toBeGreaterThan(workLabel.x);
  await page.screenshot({ path: 'test-results/breadcrumbs-nested-folders.png' });
  await homeMenu.getByRole('menuitem', { name: 'Design', exact: true }).click();
  await expect(current).toHaveText('Design');
  await expect(current).toBeFocused();
  console.log(
    '✓ Chevrons list only their parent’s folders, indent descendants and navigate directly',
  );

  await workFolders.click();
  await page.keyboard.press('Escape');
  await expect(workFolders).toBeFocused();
  await expect(workFolders).toHaveAttribute('aria-expanded', 'false');
  await workFolders.press('Space');
  await expect(workMenu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(workMenu).toBeHidden();
  await expect(current).toBeFocused();
  await workFolders.click();
  await workMenu.getByRole('menuitem', { name: 'Design', exact: true }).click();
  await expect(current).toHaveText('Design');
  await expect(current).toBeFocused();
  await workFolders.click();
  await homeFolders.click();
  await expect(workFolders).toHaveAttribute('aria-expanded', 'false');
  await expect(homeFolders).toHaveAttribute('aria-expanded', 'true');
  await expect(homeMenu).toBeVisible();
  await page.locator('footer').click({ position: { x: 2, y: 2 } });
  await expect(homeMenu).toBeHidden();
  await expect(homeFolders).toHaveAttribute('aria-expanded', 'false');
  await workFolders.click();
  await page.keyboard.press('Control+k');
  await expect(workMenu).toBeHidden();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(workFolders).toHaveAttribute('aria-expanded', 'false');
  console.log('✓ Folder menus toggle, switch and dismiss with mouse, keyboard and search');

  await workFolders.click();
  await page.evaluate(() => window.breadcrumbRequest('newTab', { groupId: 'design' }));
  await expect(workMenu).toBeVisible();
  await expect(workMenu.getByRole('menuitem', { name: 'Design', exact: true })).toBeFocused();
  await page.evaluate(() =>
    window.breadcrumbRequest('renameGroup', { id: 'research', name: 'Reference' }),
  );
  await expect(workMenu).toBeHidden();
  await expect(workFolders).toBeFocused();
  await expect(workFolders).toHaveAttribute('aria-expanded', 'false');
  await workFolders.click();
  await expect(workMenu.getByRole('menuitem')).toHaveText(['Design', 'Reference']);
  await page.evaluate(() =>
    window.breadcrumbRequest('renameGroup', { id: 'research', name: 'Research' }),
  );
  await expect(workMenu).toBeHidden();
  await workFolders.click();
  const added = await page.evaluate(() =>
    window.breadcrumbRequest('createGroup', { name: 'New sibling', parentId: 'work' }),
  );
  await expect(workMenu).toBeHidden();
  await workFolders.click();
  await expect(workMenu.getByRole('menuitem')).toHaveText(['Design', 'Research', 'New sibling']);
  await page.evaluate(
    (id) => window.breadcrumbRequest('removeGroup', { id, groupIds: [id], tabIds: [] }),
    added.createdGroupId,
  );
  await expect(workMenu).toBeHidden();
  await workFolders.click();
  await expect(workMenu.getByRole('menuitem')).toHaveText(['Design', 'Research']);
  await page.keyboard.press('Escape');
  console.log('✓ Tab updates preserve open menus; folder changes dismiss stale destinations');

  await page.locator('#home').click();
  for (const name of ['General', 'Other', 'Robocop', 'Star Trek']) await createFolder(name);
  const fullPath = ['Home', 'General', 'Other', 'Robocop', 'Star Trek'];
  await expect(crumbs).toHaveText(['', '…', 'Star Trek']);
  const robocopFolders = page.getByRole('button', { name: 'Show groups in Robocop', exact: true });
  await robocopFolders.click();
  const robocopMenu = page.getByRole('menu', { name: 'Groups in Robocop', exact: true });
  await expect(robocopMenu.getByRole('menuitem')).toHaveText(['Star Trek']);
  await homeFolders.click();
  await expect(robocopFolders).toHaveAttribute('aria-expanded', 'false');
  await expect(homeMenu.getByRole('menuitem')).toHaveText([
    'Work',
    'Design',
    'Research',
    'Personal',
    'Later',
    ...fullPath.slice(1),
  ]);
  const nestedLabels = await homeMenu
    .locator('.path-label')
    .evaluateAll((nodes) => nodes.slice(-4).map((node) => node.getBoundingClientRect().x));
  expect(nestedLabels.every((x, i) => i === 0 || x > nestedLabels[i - 1])).toBe(true);
  await overflow.click();
  await expect(homeFolders).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.getByRole('menuitem')).toHaveText(fullPath);
  await robocopFolders.click();
  await expect(overflow).toHaveAttribute('aria-expanded', 'false');
  await expect(robocopMenu).toBeVisible();
  await page.setViewportSize({ width: 900, height: 660 });
  await expect(robocopMenu).toBeHidden();
  await expect(robocopFolders).toBeFocused();
  await page.setViewportSize({ width: 320, height: 660 });
  console.log(
    '✓ Collapsed chevrons retain the correct parent, switch with ellipsis and close on resize',
  );
  const header = await page.locator('#navigation-capsule').boundingBox();
  await page.mouse.move(1, 1);
  await page.screenshot({ path: 'test-results/breadcrumbs-collapsed.png' });
  await overflow.click();
  await expect(menu.getByRole('menuitem')).toHaveText(fullPath);
  await expect(menu.getByRole('menuitem', { name: 'Star Trek', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  expect(await page.locator('#navigation-capsule').boundingBox()).toEqual(header);
  await page.screenshot({ path: 'test-results/breadcrumbs-path-menu.png' });
  await overflow.click();
  await expect(menu).toBeHidden();
  await expect(overflow).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Star Trek', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Robocop', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(overflow).toBeFocused();
  console.log(
    '✓ Only overflowing paths collapse; the full hierarchy is accessible by mouse and keyboard',
  );

  await page.setViewportSize({ width: 900, height: 660 });
  await expect(crumbs).toHaveText(['', ...fullPath.slice(1)]);
  await expect(overflow).toHaveCount(0);
  expect(
    await page
      .locator('.crumb-label')
      .evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)),
  ).toBe(true);
  // Derive the actual fit threshold from rendered labels, rather than testing
  // a fixed breakpoint that could silently truncate longer folder names.
  const threshold = await page.locator('#group-path').evaluate((path) => {
    const gap = parseFloat(getComputedStyle(path).gap);
    const content = [...path.children].reduce(
      (sum, child) => sum + child.getBoundingClientRect().width,
      0,
    );
    return Math.ceil(innerWidth - path.clientWidth + content + gap * (path.children.length - 1));
  });
  await page.setViewportSize({ width: threshold + 2, height: 660 });
  await expect(crumbs).toHaveText(['', ...fullPath.slice(1)]);
  await page.setViewportSize({ width: threshold - 2, height: 660 });
  await expect(crumbs).toHaveText(['', '…', 'Star Trek']);
  await overflow.click();
  await page.setViewportSize({ width: 900, height: 660 });
  await expect(menu).toBeHidden();
  await expect(crumbs).toHaveText(['', ...fullPath.slice(1)]);
  await expect(current).toBeFocused();
  console.log(
    '✓ Resizing switches at the measured fit threshold and restores focus when the menu disappears',
  );

  await page.setViewportSize({ width: 320, height: 660 });
  await overflow.click();
  await page.keyboard.press('Control+k');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(crumbs).toHaveText(['', '…', 'Star Trek']);
  await overflow.click();
  await menu.getByRole('menuitem', { name: 'Other', exact: true }).click();
  await expect(crumbs).toHaveText(['', 'General', 'Other']);
  await expect(current).toBeFocused();
  await expect(page.locator('.group-row').filter({ hasText: 'Robocop' })).toBeVisible();
  console.log(
    '✓ Search restores the collapsed path and selecting an ancestor navigates to that folder',
  );

  const longName = 'Reference material and production notes for the next Star Trek project';
  await createFolder(longName);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 220, height: 360 });
  await overflow.click();
  const item = menu.getByRole('menuitem', { name: longName, exact: true });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-current', 'location');
  expect(
    await item.locator('.path-label').evaluate((label) => label.scrollWidth <= label.clientWidth),
  ).toBe(true);
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(220);
  expect(box.y + box.height).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await page.screenshot({ path: 'test-results/breadcrumbs-narrow-menu.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show groups in Other', exact: true }).click();
  const otherMenu = page.getByRole('menu', { name: 'Groups in Other', exact: true });
  await expect(otherMenu.getByRole('menuitem')).toHaveText(['Robocop', 'Star Trek', longName]);
  const childItem = otherMenu.getByRole('menuitem', { name: longName, exact: true });
  await expect(childItem).toHaveAttribute('aria-current', 'location');
  expect(
    await childItem
      .locator('.path-label')
      .evaluate((label) => label.scrollWidth <= label.clientWidth),
  ).toBe(true);
  const folderBox = await otherMenu.boundingBox();
  expect(folderBox.x).toBeGreaterThanOrEqual(8);
  expect(folderBox.x + folderBox.width).toBeLessThanOrEqual(212);
  expect(folderBox.y + folderBox.height).toBeLessThanOrEqual(352);
  await page.screenshot({ path: 'test-results/breadcrumbs-child-folders-dark-narrow.png' });
  await otherMenu.getByRole('menuitem', { name: 'Star Trek', exact: true }).click();
  await expect(current).toHaveText('Star Trek');
  await expect(current).toBeFocused();
  await page.locator('#home').click();
  await expect(crumbs).toHaveText(['']);
  await expect(overflow).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    '✓ Long names wrap in the path menu, narrow dark sidebars fit, and Home clears the path',
  );
} finally {
  await close();
}
