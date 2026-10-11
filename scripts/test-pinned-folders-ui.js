import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  const demo = await readFile('preview/demo.js', 'utf8');
  await page.route('**/preview/demo.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: demo
        .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
        .replace(
          'return controller;',
          'window.pinTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
        ),
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const shelf = page.getByRole('group', { name: 'Pinned tabs and folders', exact: true });
  const pin = (id) => shelf.locator(`[data-key="pin:group:${id}"]`);
  const tab = (id) => shelf.locator(`[data-key="tab:${id}"]`);
  const row = (id) => page.locator(`#tree [data-key="group:${id}"]`);
  const menu = (name) => page.getByRole('menuitem', { name, exact: true });
  const send = (type, args = {}) =>
    page.evaluate(({ type, args }) => pinTest.send(type, args), { type, args });
  const order = () =>
    shelf
      .locator('.pinned-tab')
      .evaluateAll((nodes) => nodes.map((node) => `${node.dataset.pinKind}:${node.dataset.pinId}`));

  const pinFromMenu = async (id, action = 'open') => {
    await row(id).click({ button: 'right' });
    await menu('Pin folder…').click();
    await expect(page.getByLabel('Default action', { exact: true })).toHaveValue('open');
    await page.getByLabel('Default action', { exact: true }).selectOption(action);
    await page.getByRole('button', { name: 'Pin folder', exact: true }).click();
    await expect(pin(id)).toBeVisible();
  };

  await row('work').click({ button: 'right' });
  await menu('Pin folder…').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(shelf.locator('.pinned-folder')).toHaveCount(0);
  await pinFromMenu('work');
  await pin('work').click();
  await expect(pin('work')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#scope-heading')).toHaveText('Work');
  await pinFromMenu('design', 'reveal');
  const active = (await send('snapshot')).tabs.find((tab) => tab.active).id;
  await pin('design').click();
  await expect(page.locator('#scope-heading')).toHaveText('Work');
  await expect(row('design')).toBeFocused();
  expect((await send('snapshot')).tabs.find((tab) => tab.active).id).toBe(active);
  await pin('design').click();
  expect((await send('snapshot')).view.collapsed).not.toContain('design');
  console.log(
    '✓ Pin dialog cancellation, both defaults and repeatable reveal without activating tabs',
  );

  await pin('design').focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu('Open folder')).toBeVisible();
  await expect(menu('Show in tree')).toBeVisible();
  await expect(menu('Change default action…')).toBeVisible();
  await expect(menu('Unpin folder')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pin('design')).toBeFocused();
  await pin('design').click({ button: 'right' });
  await menu('Change default action…').click();
  await expect(page.getByLabel('Default action', { exact: true })).toHaveValue('reveal');
  await page.getByLabel('Default action', { exact: true }).selectOption('open');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await pin('design').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await pin('design').click({ button: 'right' });
  await menu('Show in tree').click();
  await expect(page.locator('#scope-heading')).toHaveCount(0);
  await expect(row('design')).toBeFocused();
  console.log('✓ Both context actions, updated click behaviour and independent tree/pin focus');

  await send('renameGroup', { id: 'design', name: 'Ideas' });
  await send('setGroupAppearance', { id: 'design', appearance: { icon: 'book' } });
  await send('setGroupAppearance', { id: 'work', appearance: { color: 'purple' } });
  await expect(pin('design')).toHaveAttribute('title', /Work \/ Ideas\nOpen folder/);
  await expect(pin('design').locator('use')).toHaveAttribute('href', /#book-16$/);
  await expect(pin('design').locator('.folder-glyph')).toHaveCSS('color', 'rgb(161, 107, 212)');
  expect(await pin('design').textContent()).toBe('');
  await pin('design').focus();
  await send('renameGroup', { id: 'design', name: 'Design' });
  await expect(pin('design')).toHaveAccessibleName(/Work \/ Design, pinned folder, Open folder/);
  await expect(pin('design')).toBeFocused();
  await send('moveGroup', { id: 'design', parentId: 'personal' });
  await expect(pin('design')).toHaveAttribute('title', /Personal \/ Design/);
  await send('setGroupPin', { id: 'design', action: 'reveal' });
  await send('collapseAll', { collapsed: true });
  await page.getByRole('button', { name: 'Search tabs and folders', exact: true }).click();
  await page.getByRole('searchbox').fill('no matching folder');
  await pin('design').click();
  await expect(page.locator('#search')).toHaveValue('');
  await expect(row('design')).toBeFocused();
  expect((await send('snapshot')).view.collapsed).not.toContain('personal');
  console.log(
    '✓ Icon-only pins track names, inherited colours and moves; reveal clears search and expands ancestors',
  );

  const move = async (source, target, side = 'before') => {
    const bounds = await target.boundingBox();
    await source.dragTo(target, {
      targetPosition: { x: side === 'before' ? 3 : bounds.width - 3, y: bounds.height / 2 },
    });
  };

  const activeBeforeDrag = (await send('snapshot')).tabs.find((tab) => tab.active).id;
  await move(pin('work'), tab(10));
  await expect
    .poll(order)
    .toEqual([
      'group:work',
      'tab:demo-tab-10',
      'tab:demo-tab-11',
      'tab:demo-tab-12',
      'tab:demo-tab-13',
      'group:design',
    ]);
  await move(pin('design'), pin('work'));
  await expect
    .poll(order)
    .toEqual([
      'group:design',
      'group:work',
      'tab:demo-tab-10',
      'tab:demo-tab-11',
      'tab:demo-tab-12',
      'tab:demo-tab-13',
    ]);
  await move(tab(13), pin('work'));
  await expect
    .poll(order)
    .toEqual([
      'group:design',
      'tab:demo-tab-13',
      'group:work',
      'tab:demo-tab-10',
      'tab:demo-tab-11',
      'tab:demo-tab-12',
    ]);
  await move(pin('design'), tab(12), 'after');
  await expect
    .poll(order)
    .toEqual([
      'tab:demo-tab-13',
      'group:work',
      'tab:demo-tab-10',
      'tab:demo-tab-11',
      'tab:demo-tab-12',
      'group:design',
    ]);
  expect((await send('snapshot')).tabs.find((tab) => tab.active).id).toBe(activeBeforeDrag);
  await expect(shelf.locator('.dragging,.drop-before,.drop-after')).toHaveCount(0);

  for (const id of ['research', 'personal', 'later'])
    await send('setGroupPin', { id, action: 'reveal' });
  await page.setViewportSize({ width: 220, height: 660 });
  await expect(shelf.locator('.pinned-folder')).toHaveCount(5);
  expect((await pin('later').boundingBox()).y).toBeGreaterThan((await tab(13).boundingBox()).y);
  await move(pin('later'), tab(13));
  await expect.poll(async () => (await order())[0]).toBe('group:later');
  await page.screenshot({ path: 'test-results/pinned-folders-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/pinned-folders-dark.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  console.log(
    '✓ Freely mixed dragging, shared folder order and wrapped icon-only layout in light/dark',
  );

  await pin('work').click({ button: 'right' });
  await menu('Unpin folder').click();
  await expect(pin('work')).toHaveCount(0);
  expect((await send('snapshot')).groups.some((group) => group.id === 'work')).toBe(true);
  const empty = await send('createGroup', { name: 'Empty' });
  await send('setGroupPin', { id: empty.createdGroupId, action: 'open' });
  await pin(empty.createdGroupId).click();
  await expect(page.locator('#scope-heading')).toHaveText('Empty');
  await pin(empty.createdGroupId).click({ button: 'right' });
  await menu('Show in tree').click();
  await expect(row(empty.createdGroupId)).toBeFocused();
  await send('removeGroup', {
    id: empty.createdGroupId,
    ...(await send('getGroupContents', { id: empty.createdGroupId })),
  });
  await expect(pin(empty.createdGroupId)).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    '✓ Unpin preserves folders, empty folders navigate and deletion removes the shortcut',
  );
} finally {
  await close();
}
