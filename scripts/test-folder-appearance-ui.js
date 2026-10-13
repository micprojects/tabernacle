import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const button = (name) => page.getByRole('button', { name, exact: true });
const choice = (name) => page.getByRole('radio', { name, exact: true });
const row = (id) => page.locator(`[data-key="group:${id}"]`);
const glyph = (id) => row(id).locator('.disclosure .folder-glyph');
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) => {
      const session = await window.tabernacleDemoSession.ready;
      return session.request({ type, windowId: 1, ...args });
    },
    { type, args },
  );

async function open(id) {
  await row(id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Icon and colour…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row('work')).toBeVisible();
  await expect(glyph('work')).toHaveAttribute('data-icon', 'folder-open-16');
  await open('work');
  await expect(choice('Folder icon')).toHaveAttribute('aria-checked', 'true');
  await expect(button('Use folder icon and colour')).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Find an icon' }).fill('holiday');
  await expect(choice('Plane')).toBeVisible();
  await expect(choice('Keyboard')).toBeHidden();
  await choice('Plane').click();
  await choice('Purple').click();
  await expect(page.locator('.appearance-sample svg')).toHaveAttribute('data-icon', 'plane-16');
  await page.getByRole('searchbox', { name: 'Find an icon' }).fill('no-such-icon');
  await expect(page.getByText('No icons found. Try another word or category.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find an icon' }).press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await button('Save').click();
  await expect(glyph('work')).toHaveAttribute('data-icon', 'plane-16');
  await expect(glyph('work')).toHaveCSS('color', 'rgb(161, 107, 212)');
  await expect(glyph('design')).toHaveAttribute('data-icon', 'folder-open-16');
  await expect(glyph('design')).toHaveCSS('color', 'rgb(161, 107, 212)');
  const { createdGroupId: leaf } = await send('createGroup', {
    name: 'Nested folder',
    parentId: 'design',
  });
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(161, 107, 212)');
  await open('design');
  await expect(choice('Inherited colour')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.appearance-sample .folder-glyph')).toHaveCSS(
    'color',
    'rgb(161, 107, 212)',
  );
  await expect(button('Reset icon and colour')).toBeDisabled();
  await page.screenshot({ path: 'test-results/folder-appearance-inherited.png' });
  await choice('Book').click();
  await choice('Teal').click();
  await button('Save').click();
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(36, 155, 135)');
  await send('setGroupAppearance', { id: 'work', appearance: { icon: 'plane', color: 'blue' } });
  await expect(glyph('research')).toHaveCSS('color', 'rgb(76, 141, 224)');
  await expect(glyph('design')).toHaveCSS('color', 'rgb(36, 155, 135)');
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(36, 155, 135)');
  await open('design');
  await choice('Inherited colour').click();
  await expect(page.locator('.appearance-sample .folder-glyph')).toHaveCSS(
    'color',
    'rgb(76, 141, 224)',
  );
  await button('Save').click();
  await expect(glyph('design')).toHaveAttribute('data-icon', 'book-16');
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(76, 141, 224)');
  await send('setGroupAppearance', { id: 'personal', appearance: { color: 'red' } });
  await send('moveGroup', { id: 'design', parentId: 'personal' });
  await button('Expand Personal').click();
  await expect(glyph('design')).toHaveCSS('color', 'rgb(224, 82, 82)');
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(224, 82, 82)');
  await send('moveGroup', { id: 'design', parentId: 'work' });
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(76, 141, 224)');
  console.log(
    '✓ Cascading colours, independent icons, child overrides, clearing colours and moves',
  );

  await button('New folder').click();
  await page.getByLabel('Folder name', { exact: true }).fill('Inherited colour draft');

  async function destination(name, color) {
    await page.getByLabel('Create in', { exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a folder', exact: true }).fill(name);
    const entry = page.getByRole('treeitem', { name, exact: true });
    await expect(entry.locator('.folder-glyph')).toHaveCSS('color', color);
    await entry.click();
    await expect(page.locator('#create-in .folder-glyph')).toHaveCSS('color', color);
    await expect(page.locator('#change-group-appearance .folder-glyph')).toHaveCSS('color', color);
  }

  await destination('Design', 'rgb(76, 141, 224)');
  await destination('Personal', 'rgb(224, 82, 82)');
  await destination('Design', 'rgb(76, 141, 224)');
  await button('Change folder appearance').click();
  await expect(choice('Inherited colour')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.appearance-sample .folder-glyph')).toHaveCSS(
    'color',
    'rgb(76, 141, 224)',
  );
  await button('Save').click();
  await button('Create folder').click();
  const draftState = await send('snapshot');
  const inherited = draftState.groups.find((group) => group.name === 'Inherited colour draft');
  expect(inherited.appearance).toBeUndefined();
  await expect(glyph(inherited.id)).toHaveCSS('color', 'rgb(76, 141, 224)');
  console.log('✓ Destination picker and new-folder previews inherit without saving an override');

  await row('work').click();
  await expect(row('work')).toHaveAttribute('aria-expanded', 'false');
  await expect(glyph('work')).toHaveAttribute('data-icon', 'plane-16');
  await open('work');
  await button('Use folder icon and colour').click();
  await button('Cancel').click();
  await expect(glyph('work')).toHaveAttribute('data-icon', 'plane-16');
  await open('work');
  await button('Use folder icon and colour').click();
  await button('Save').click();
  await expect(glyph('work')).toHaveAttribute('data-icon', 'folder-16');
  await row('work').click();
  expect(await glyph(leaf).evaluate((node) => node.style.color)).toBe('');
  await row('work').click();
  console.log('✓ Search, independent colour, preview, Save, Cancel, collapse and reset');

  const created = await send('createContainer', { name: 'Team', icon: 'briefcase', color: 'blue' });
  await send('setGroupContainer', { id: 'work', cookieStoreId: created.createdCookieStoreId });
  await expect(glyph('work')).toHaveClass(/group-container-icon/);
  await row('work').click();
  await expect(glyph('design')).toHaveAttribute('data-icon', 'book-16');
  await expect(glyph(leaf)).toHaveAttribute('data-icon', 'folder-open-16');
  await expect(glyph(leaf)).toHaveCSS('color', 'rgb(55, 173, 255)');
  await expect(glyph('research')).toHaveAttribute('data-icon', 'folder-16');
  await button('Expand Research').click();
  await expect(glyph('research')).toHaveAttribute('data-icon', 'folder-open-16');
  await expect(glyph('research')).toHaveCSS('color', 'rgb(55, 173, 255)');
  await open('research');
  await expect(choice('Folder icon')).toHaveAttribute('aria-checked', 'true');
  await expect(choice('Container icon')).toHaveCount(0);
  await expect(choice('Container colour')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.appearance-summary')).toHaveText('Folder icon · container colour');
  await choice('Music').click();
  await button('Save').click();
  await expect(glyph('research')).toHaveAttribute('data-icon', 'musical-note-16');
  await expect(glyph('research')).toHaveCSS('color', 'rgb(55, 173, 255)');
  await open('research');
  await button('Reset icon and colour').click();
  await button('Save').click();

  // Selecting the same inherited container explicitly must invalidate both icon caches.
  await send('setGroupPin', { id: 'research', action: 'open' });
  const pinnedGlyph = page.locator('[data-key="pin:group:research"] .folder-glyph');
  await expect(pinnedGlyph).toHaveAttribute('data-icon', 'folder-16');
  await send('setGroupContainer', { id: 'research', cookieStoreId: created.createdCookieStoreId });
  await expect(glyph('research')).toHaveClass(/group-container-icon/);
  await expect(pinnedGlyph).toHaveClass(/group-container-icon/);
  await open('research');
  await choice('Folder').click();
  await button('Save').click();
  await expect(glyph('research')).toHaveAttribute('data-icon', 'folder-open-16');
  await expect(pinnedGlyph).toHaveAttribute('data-icon', 'folder-16');
  await send('setGroupAppearance', { id: 'research', appearance: {} });
  await expect(pinnedGlyph).toHaveClass(/group-container-icon/);
  await send('setGroupContainer', { id: 'research', cookieStoreId: null });
  await expect(glyph('research')).toHaveAttribute('data-icon', 'folder-open-16');
  await expect(pinnedGlyph).toHaveAttribute('data-icon', 'folder-16');
  await expect(pinnedGlyph).toHaveCSS('color', 'rgb(55, 173, 255)');
  await send('setGroupPin', { id: 'research', action: null });
  await page.screenshot({ path: 'test-results/folder-container-icon-inheritance.png' });
  console.log(
    '✓ Inherited colour, local icons, explicit container toggles and pinned icon updates',
  );

  await open('work');
  await page.getByRole('combobox', { name: 'Icon category' }).selectOption('Technology');
  await expect(choice('Keyboard')).toBeVisible();
  await expect(choice('Plane')).toBeHidden();
  await choice('Keyboard').click();
  await button('Save').click();
  await expect(glyph('work')).toHaveAttribute('data-icon', 'keyboard-16');
  await expect(glyph('work')).toHaveCSS('color', 'rgb(55, 173, 255)');
  await send('updateContainer', {
    cookieStoreId: created.createdCookieStoreId,
    name: 'Team',
    icon: 'cart',
    color: 'green',
  });
  await expect(glyph('work')).toHaveCSS('color', 'rgb(81, 205, 0)');
  await open('work');
  await choice('Container icon').click();
  await choice('Pink').click();
  await button('Save').click();
  await expect(glyph('work')).toHaveClass(/group-container-icon/);
  await expect(glyph('work')).toHaveCSS('color', 'rgb(212, 94, 170)');
  await open('work');
  await button('Use container icon and colour').click();
  await button('Save').click();
  await expect(glyph('work')).toHaveCSS('color', 'rgb(81, 205, 0)');
  expect(await glyph('work').evaluate((node) => node.style.maskImage)).toContain('cart.svg');
  console.log('✓ Container inheritance, independent overrides and reset to an updated container');

  await button('New folder').click();
  await page.getByLabel('Folder name', { exact: true }).fill('Holiday plans');
  await button('Change folder appearance').click();
  await page.getByRole('searchbox', { name: 'Find an icon' }).fill('travel flights');
  await page.getByRole('searchbox', { name: 'Find an icon' }).press('ArrowDown');
  await expect(choice('Plane')).toBeFocused();
  await page.keyboard.press('Space');
  await choice('Teal').click();
  await button('Save').click();
  await expect(page.getByLabel('Folder name', { exact: true })).toHaveValue('Holiday plans');
  await expect(page.locator('#change-group-appearance svg').first()).toHaveAttribute(
    'data-icon',
    'plane-16',
  );
  await button('Create folder').click();
  const state = await send('snapshot');
  const holiday = state.groups.find((group) => group.name === 'Holiday plans');
  expect(holiday.appearance).toEqual({ icon: 'plane', color: 'teal' });
  expect(state.containers).toHaveLength(5);
  await expect(glyph(holiday.id)).toHaveAttribute('data-icon', 'plane-16');
  await button('New folder').click();
  await page.getByLabel('Create in', { exact: true }).click();
  await expect(
    page.getByRole('treeitem', { name: 'Holiday plans', exact: true }).locator('.folder-glyph'),
  ).toHaveAttribute('data-icon', 'plane-16');
  await page.keyboard.press('Escape');
  await button('Cancel').click();
  console.log('✓ New-folder draft, keyboard selection and destination folder icons');

  await open(holiday.id);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `test-results/folder-appearance-${colorScheme}.png` });
  }
  for (const viewport of [
    { width: 180, height: 780 },
    { width: 260, height: 540 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.locator('#dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await button('Save').scrollIntoViewIfNeeded();
    await expect(button('Save')).toBeInViewport();
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('.appearance-sample .folder-glyph')).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  expect(errors).toEqual([]);
  console.log('✓ Light, dark, narrow sidebar, short viewport and forced colours');
} finally {
  await close();
}
