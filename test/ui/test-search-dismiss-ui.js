import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 820 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const search = page.getByRole('searchbox');
const row = (key) => page.locator(`[data-key="${key}"]`);

const reset = async () => {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row('tab:1')).toBeVisible();
};

const open = async (query = 'Typography') => {
  await page.keyboard.press('Control+k');
  await search.fill(query);
  await expect(search).toBeFocused();
};

const closed = async () => {
  await expect(page.locator('#breadcrumbs')).toBeVisible();
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(search).toHaveCount(0);
};

try {
  for (const method of ['pointer', 'keyboard']) {
    await reset();
    await open('Sprint');
    const result = row('tab:9');

    const openMenu = async () => {
      if (method === 'pointer') await result.click({ button: 'right' });
      else {
        await result.focus();
        await page.keyboard.press('Shift+F10');
      }
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(search).toHaveValue('Sprint');
      await expect(row('tab:1')).toHaveCount(0);
    };

    await openMenu();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(search).toHaveValue('Sprint');
    await expect(result).toBeFocused();

    await openMenu();
    const mute = page.getByRole('menuitem', { name: 'Mute tab', exact: true });
    if (method === 'pointer') await mute.click();
    else {
      await mute.focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(search).toHaveValue('Sprint');
    await openMenu();
    await expect(page.getByRole('menuitem', { name: 'Unmute tab', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
    await expect(result).toHaveCount(0);
    await expect(search).toHaveValue('Sprint');
    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(row('tab:1')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await closed();
  }
  console.log(
    '✓ Result menus preserve search when opened, dismissed or used by mouse and keyboard',
  );

  await reset();
  await open('Sprint');
  await row('tab:9').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move tab…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(search).toHaveValue('Sprint');
  await expect(row('tab:1')).toHaveCount(0);
  console.log('✓ Cancelling a result menu dialog keeps the original search');

  await reset();
  await open('Sprint');
  await search.click();
  await page.locator('#navigation-capsule').click({ position: { x: 2, y: 1 } });
  await expect(search).toHaveValue('Sprint');
  await expect(row('tab:1')).toHaveCount(0);

  // Keep a filtered result under the pointer until mouseup, even though clearing
  // the query will restore earlier siblings and change the layout.
  const result = row('tab:9');
  const target = await result.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await closed();
  expect(await result.boundingBox()).toEqual(target);
  await expect(row('tab:1')).toHaveCount(0);
  await page.mouse.up();
  await expect(result).toHaveAttribute('aria-selected', 'true');
  await expect(result).toBeFocused();
  await expect(row('tab:1')).toBeVisible();
  console.log('✓ Clicking a filtered tab closes search and activates the original result');

  for (const selector of ['.label', '.disclosure']) {
    await reset();
    await open('Research');
    await row('group:research').locator(selector).click();
    await closed();
    await expect(row('group:research')).toBeFocused();
    await expect(row('tab:5')).toBeVisible();
    await expect(page.locator('#scope-heading')).toHaveCount(0);
  }
  await reset();
  await open('Launch');
  await row('tab:3').locator('.tab-disclosure').click();
  await closed();
  await expect(row('tab:3')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('tab:4')).toHaveCount(0);
  console.log('✓ Folder clicks and nested-tab disclosure controls keep their folding actions');

  for (const method of ['double-click', 'keyboard', 'menu']) {
    await reset();
    await open('Research');
    const group = row('group:research');
    if (method === 'double-click') await group.locator('.label').dblclick();
    else if (method === 'keyboard') {
      await group.focus();
      await page.keyboard.press('Enter');
    } else {
      await group.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
    }
    await closed();
    await expect(page.locator('#scope-heading')).toHaveText('Research');
    await expect(row('tab:5')).toBeVisible();
  }
  await reset();
  await row('group:design').dblclick();
  await open();
  await page.keyboard.press('Alt+ArrowLeft');
  await closed();
  await expect(page.locator('#scope-heading')).toHaveText('Work');
  console.log('✓ Folder entry and parent navigation restore breadcrumbs by mouse and keyboard');

  for (const keyboard of [false, true]) {
    await reset();
    await open();
    const pin = row('tab:10');
    if (keyboard) {
      await pin.focus();
      await page.keyboard.press('Enter');
    } else await pin.click();
    await closed();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(pin).toBeFocused();
    await expect(page.locator('#scope-heading')).toHaveCount(0);
  }
  await reset();
  await open('nothing matches');
  await expect(page.locator('.empty-state')).toBeVisible();
  const tree = await page.locator('#tree').boundingBox();
  await page.mouse.click(tree.x + tree.width - 8, tree.y + tree.height - 8);
  await closed();
  await expect(row('tab:1')).toHaveAttribute('aria-selected', 'true');
  await open();
  await page.locator('#pinned-tabs').click({ position: { x: 280, y: 12 } });
  await closed();
  console.log('✓ Pins and empty sidebar space dismiss search without changing folder scope');

  for (const id of ['new-tab', 'new-group', 'settings', 'tree-toggle']) {
    await reset();
    await open();
    const button = page.locator(`#${id}`);
    // The fold control is disabled while filtering. The outside press must
    // restore it in time for this same click to perform the requested action.
    const popup = id === 'settings' ? page.waitForEvent('popup') : null;
    const bounds = await button.boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await closed();
    if (id === 'new-tab')
      await expect(page.locator('.tab-row.active .label')).toHaveText('New tab');
    else if (id === 'new-group') {
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Folder name', { exact: true })).toBeFocused();
    } else if (id === 'settings') {
      const settings = await popup;
      await expect(settings.locator('#appearance-fields')).toBeEnabled();
      await expect(page.getByRole('menu')).toBeHidden();
      await settings.close();
    } else {
      await expect(button).toHaveAccessibleName('Expand all in Home');
      await expect(row('group:work')).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toBeFocused();
    }
  }
  console.log(
    '✓ Every bottom-bar button dismisses search and performs its action on the same click',
  );
  expect(errors).toEqual([]);
} finally {
  await close();
}
