import { instrumentDemo } from '../helpers/probes/move-dialog.js';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 360, height: 720 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: instrumentDemo(demo),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => moveTest.send(type, args), [type, args]);
const state = () => send('snapshot');
const dialog = page.getByRole('dialog');
const search = dialog.getByRole('searchbox', { name: 'Destination', exact: true });
const tree = dialog.getByRole('tree', { name: 'Destination folders' });
const folder = (name) => tree.getByRole('treeitem', { name, exact: true });
const move = dialog.getByRole('button', { name: 'Move', exact: true });

async function reset() {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('[data-key="tab:1"]')).toBeVisible();
}

async function open(kind = 'tab', id = 1) {
  await page.locator(`[data-key="${kind}:${id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: kind === 'tab' ? 'Move tab…' : 'Move folder…' }).click();
  await expect(search).toBeFocused();
}

async function choose(name) {
  await folder(name).locator(':scope > .move-tree-row').click();
}

try {
  await reset();
  const before = await state();
  await open();
  await expect(dialog).toHaveAccessibleName('Move tab');
  await expect(dialog.locator('.move-source')).toContainText('Includes 3 child tabs');
  await expect(folder('Design')).toHaveAttribute('aria-selected', 'true');
  await expect(move).toBeDisabled();
  await expect(dialog.locator('select')).toBeHidden();
  await expect(dialog).not.toContainText('Pinned items');
  await expect(dialog).not.toContainText('Added at the end');
  await expect(dialog).not.toContainText('Home /');
  await expect(tree).not.toContainText('Figma');
  await expect(tree).not.toContainText('Typography');
  await tree.getByRole('button', { name: 'Collapse Work', exact: true }).click();
  await expect(folder('Design')).toHaveCount(0);
  await expect(move).toBeDisabled();
  expect((await state()).view).toEqual(before.view);
  await tree.getByRole('button', { name: 'Expand Work', exact: true }).click();
  await search.fill('no such folder');
  await expect(dialog.getByText('No folders found.', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(move).toBeDisabled();
  await expect(dialog).toBeVisible();
  await search.fill('rEsEaRcH');
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(folder('Home')).toBeVisible();
  await expect(folder('Work')).toBeVisible();
  await expect(folder('Research')).toBeVisible();
  await expect(move).toBeDisabled();
  // IME confirmation/navigation belongs to text composition, not the picker.
  for (const key of ['Enter', 'ArrowDown', 'ArrowUp']) {
    expect(
      await search.evaluate((node, key) => {
        const event = new KeyboardEvent('keydown', {
          key,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      }, key),
    ).toBe(false);
    await expect(search).toBeFocused();
    await expect(move).toBeDisabled();
    await expect(folder('Research')).toHaveAttribute('aria-selected', 'false');
  }
  await search.press('Enter');
  await expect(folder('Research')).toBeFocused();
  await expect(folder('Research')).toHaveAttribute('aria-selected', 'true');
  await expect(dialog).toBeVisible();
  await move.click();
  await expect(dialog).toBeHidden();
  const after = await state();
  for (const id of [1, 2, 3, 4])
    expect(after.tabs.find((tab) => tab.id === id).groupId).toBe('research');
  expect(after.tabs.find((tab) => tab.id === 3).parentTabId).toBe(1);
  expect(after.tabs.find((tab) => tab.id === 4).parentTabId).toBe(3);
  const roots = after.tabs
    .filter((tab) => tab.groupId === 'research' && tab.parentTabId === null && !tab.pinned)
    .sort((a, b) => a.order - b.order);
  expect(roots.map((tab) => tab.id)).toEqual([5, 1]);
  expect(after.tabs.find((tab) => tab.active).id).toBe(before.tabs.find((tab) => tab.active).id);
  console.log('✓ Folder-only search preserves ancestors and appends the complete tab branch');

  await reset();
  await open('tab', 8);
  await search.press('ArrowDown');
  await expect(folder('Home')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(folder('Work')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(folder('Work')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(folder('Design')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(folder('Design')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(folder('Later')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(folder('Home')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-key="tab:8"]')).toBeFocused();
  await open('tab', 8);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('[data-key="tab:8"]')).toBeFocused();
  console.log('✓ Keyboard tree navigation, selection, Escape and Close return focus');

  await reset();
  const duplicate = await send('createGroup', { name: 'Design', parentId: 'personal' });
  await open('tab', 8);
  await search.fill('Design');
  await expect(folder('Design')).toHaveCount(2);
  await expect(folder('Personal')).toBeVisible();
  await folder('Personal')
    .getByRole('treeitem', { name: 'Design', exact: true })
    .locator(':scope > .move-tree-row')
    .click();
  await move.click();
  await expect(dialog).toBeHidden();
  expect((await state()).tabs.find((tab) => tab.id === 8).groupId).toBe(duplicate.createdGroupId);
  console.log('✓ Duplicate folder names remain distinguishable through their ancestors');

  await reset();
  await open('tab', 8);
  await choose('Design');
  await send('moveTab', { id: 1, groupId: null });
  await expect(page.locator('#tree > .tab-node > [data-key="tab:1"]')).toBeVisible();
  await move.click();
  await expect(dialog.locator('#dialog-error')).toContainText('destination has changed');
  expect((await state()).tabs.find((tab) => tab.id === 8).groupId).toBe('work');
  await choose('Design');
  await move.click();
  await expect(dialog).toBeHidden();
  expect((await state()).tabs.find((tab) => tab.id === 8).groupId).toBe('design');
  console.log('✓ A stale destination is rejected and can be reselected safely');

  await reset();
  await open('tab', 8);
  await choose('Design');
  await send('moveTab', { id: 8, groupId: 'personal' });
  await expect(page.locator('[data-key="tab:8"]')).toHaveCount(0);
  await choose('Design');
  await expect(dialog.locator('#dialog-error')).toContainText('source has moved');
  await expect(move).toBeDisabled();
  await page.keyboard.press('Escape');

  await reset();
  await open('tab', 10);
  await choose('Work');
  await move.click();
  await expect(dialog).toBeHidden();
  const unpinned = (await state()).tabs.find((tab) => tab.id === 10);
  expect([unpinned.groupId, unpinned.pinned]).toEqual(['work', false]);
  console.log('✓ Source changes are explained and pinned source tabs can still move into folders');

  await reset();
  await open('group', 'work');
  await expect(folder('Work')).toHaveCount(0);
  await expect(folder('Design')).toHaveCount(0);
  await expect(folder('Research')).toHaveCount(0);
  await choose('Personal');
  await move.click();
  await expect(dialog).toBeHidden();
  expect((await state()).groups.find((group) => group.id === 'work').parentId).toBe('personal');
  console.log('✓ Folder moves exclude their own subtree');

  await reset();
  await open('tab', 8);
  await page.mouse.move(0, 0);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await dialog.screenshot({ path: `test-results/move-dialog-${colorScheme}.png` });
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const longName = 'A long folder name that must stay inside a narrow sidebar';
  await send('createGroup', { name: longName, parentId: 'work' });
  for (let i = 0; i < 24; i++) await send('createGroup', { name: `Folder ${i}`, parentId: null });
  await open('tab', 8);
  for (const viewport of [
    { width: 320, height: 600 },
    { width: 220, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await choose(longName);
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(move).toBeInViewport();
    await expect(search).toBeInViewport();
    await dialog.screenshot({ path: `test-results/move-dialog-${viewport.width}.png` });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(folder(longName)).toHaveAttribute('aria-selected', 'true');
  await expect(
    folder(longName).locator(':scope > .move-tree-row > .move-folder-check'),
  ).toBeVisible();
  await dialog.screenshot({ path: 'test-results/move-dialog-forced-colors.png' });
  await page.keyboard.press('Escape');
  await page.locator('#new-group').click();
  await expect(dialog).not.toHaveClass(/move-dialog/);
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    '✓ Light/dark, short/narrow sidebars, long lists and forced colours retain usable controls',
  );
} finally {
  await close();
}
