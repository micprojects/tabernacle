import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
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
        `const count = Number(new URLSearchParams(location.search).get('count'));
          while (entries.length < count) entries.push(['Extra tab ' + entries.length, null, 'https://example.com/' + entries.length]);
          const memberships = {};`,
      )
      .replace(
        'return controller;',
        'window.dragTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const tab = (id) => page.locator(`[data-key="tab:${id}"]`);
const group = (id) => page.locator(`[data-key="group:${id}"]`);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => dragTest.send(type, args), [type, args]);
const state = () => send('snapshot');

async function reset() {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(tab(2)).toBeVisible();
}

async function hover(target, fraction = 0.5, x = 50) {
  const rect = await target.boundingBox();
  await page.mouse.move(rect.x + Math.min(x, rect.width / 2), rect.y + rect.height * fraction, {
    steps: 5,
  });
  await page.mouse.move(rect.x + Math.min(x, rect.width / 2), rect.y + rect.height * fraction);
}

async function begin(source, target, fraction = 0.5) {
  await source.scrollIntoViewIfNeeded();
  const rect = await source.boundingBox();
  await page.mouse.move(rect.x + 45, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + 45, rect.y + rect.height / 2 + 6, { steps: 2 });
  await hover(target, fraction);
}

async function finish() {
  await page.mouse.up();
  await expect(page.locator('.move-preview')).toBeHidden();
  await expect(page.locator('.sidebar')).not.toHaveAttribute('aria-busy', 'true');
}

try {
  for (const fraction of [0.05, 0.95]) {
    await reset();
    await begin(tab(2), group('research'), fraction);
    await expect(group('research')).toHaveClass(/drop-inside/);
    await expect(page.locator('.move-preview')).toContainText('into Home / Work / Research');
    await finish();
    expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe('research');
    await expect(tab(2)).toBeVisible();
  }
  console.log('✓ Folder edges agree with the destination and reveal moved tabs');

  await reset();
  await begin(tab(8), tab(1), 0.95);
  const branch = await tab(1).locator('..').boundingBox();
  const marker = await page.locator('.move-marker').boundingBox();
  expect(marker.y).toBeCloseTo(branch.y + branch.height, 0);
  await page.screenshot({ path: 'test-results/drag-after-branch.png' });
  await finish();
  expect((await state()).tabs.find((tab) => tab.id === 8).parentTabId).toBe(null);
  console.log('✓ After-branch insertion appears below the whole expanded subtree');

  for (const [selector, parentTabId, groupId] of [
    ['[data-key="new-tab:null"]', null, null],
    ['[data-key="new-child-tab:1"]', 1, 'design'],
  ]) {
    await reset();
    const target = page.locator(selector).locator('..');
    await begin(tab(8), target);
    await expect(target).toHaveClass(/drop-inside/);
    expect(await target.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('dashed');
    await finish();
    const moved = (await state()).tabs.find((tab) => tab.id === 8);
    expect([moved.groupId, moved.parentTabId]).toEqual([groupId, parentTabId]);
  }
  await reset();
  await begin(tab(2), page.locator('#tree'), 0.9);
  await expect(page.locator('.move-marker')).toBeVisible();
  await finish();
  expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe(null);
  console.log('✓ Plus rows and blank space expose real highlighted destinations');

  await reset();
  await begin(tab(1), tab(4));
  await expect(page.locator('.sidebar')).toHaveClass(/move-invalid/);
  await expect(page.locator('.move-preview')).toContainText('children');
  await finish();
  expect((await state()).tabs.find((tab) => tab.id === 1).groupId).toBe('design');
  console.log('✓ Invalid cycles are explained before release and do not move tabs');

  await reset();
  await send('toggleTab', { id: 5 });
  await send('enterGroup', { id: 'design' });
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  const initial = await state();
  await begin(tab(2), page.locator('#home'));
  await expect(group('research')).toBeVisible();
  await hover(group('research'));
  await expect(tab(5)).toBeVisible();
  await hover(tab(5));
  await expect(tab(6)).toBeVisible();
  expect((await state()).view).toEqual(initial.view);
  expect((await state()).tabs.find((tab) => tab.id === 5).collapsed).toBe(true);
  await hover(tab(6));
  await finish();
  const moved = (await state()).tabs.find((tab) => tab.id === 2);
  expect([moved.groupId, moved.parentTabId]).toEqual(['research', 6]);
  expect((await state()).tabs.find((tab) => tab.active).id).toBe(
    initial.tabs.find((tab) => tab.active).id,
  );
  await expect(tab(2)).toBeVisible();
  console.log(
    '✓ One uninterrupted drag crosses Home, a collapsed folder and a collapsed tab without activating a page',
  );

  await reset();
  await send('enterGroup', { id: 'design' });
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  const beforeCancel = await state();
  await begin(tab(2), page.locator('#home'));
  await expect(group('research')).toBeVisible();
  await hover(group('research'));
  await expect(tab(5)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  expect((await state()).view).toEqual(beforeCancel.view);
  await expect(page.locator('.dragging,.drop-inside,.drop-invalid')).toHaveCount(0);
  console.log('✓ Escape discards temporary navigation and expansion');

  await reset();
  await tab(10).dragTo(group('research'));
  await expect
    .poll(async () => (await state()).tabs.find((tab) => tab.id === 10).pinned)
    .toBe(false);
  await expect(tab(10)).toBeVisible();
  const shelf = page.locator('#pinned-tabs');
  const bounds = await shelf.boundingBox();
  await tab(2).dragTo(shelf, { targetPosition: { x: bounds.width - 2, y: 14 } });
  await expect.poll(async () => (await state()).tabs.find((tab) => tab.id === 2).pinned).toBe(true);
  await send('setGroupPin', { id: 'later', action: 'open' });
  const shortcut = page.locator('[data-pin-kind="group"][data-pin-id="later"]');
  await expect(shortcut).toBeVisible();
  await tab(8).dragTo(shortcut);
  await expect
    .poll(async () => (await state()).tabs.find((tab) => tab.id === 8).groupId)
    .toBe('later');
  console.log('✓ Pinning, unpinning and pinned folder destinations work in both directions');

  await reset();
  await tab(8).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move tab…' }).click();
  await page.getByRole('searchbox', { name: 'Destination', exact: true }).fill('Research');
  await page.getByRole('searchbox', { name: 'Destination', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(tab(8)).toBeVisible();
  await expect(
    group('research').locator('..').locator(':scope > .branch > .tab-node > .row .label'),
  ).toHaveText(['Sidebar patterns', 'Roadmap']);
  console.log('✓ The keyboard dialog appends to a searched folder');

  await reset();
  await tab(8).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move tab…' }).click();
  await page.getByRole('searchbox', { name: 'Destination', exact: true }).fill('Design');
  await page.getByRole('searchbox', { name: 'Destination', exact: true }).press('Enter');
  await send('moveTab', { id: 1, groupId: null });
  await expect(page.locator('#tree > .tab-node > [data-key="tab:1"]')).toBeVisible();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.locator('#dialog-error')).toBeVisible();
  expect((await state()).tabs.find((tab) => tab.id === 8).parentTabId).toBe(null);
  await page.keyboard.press('Escape');
  await send('setGroupPin', { id: 'later', action: 'open' });
  const keyboardShortcut = page.locator('[data-pin-kind="group"][data-pin-id="later"]');
  await expect(keyboardShortcut).toBeVisible();
  await keyboardShortcut.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Move shortcut…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await state()).groups.find((group) => group.id === 'later').parentId).toBe(null);
  console.log(
    '✓ Folder moves reject stale destinations and shortcut menus omit the removed picker',
  );

  for (const selector of ['.tab-icon', '.disclosure']) {
    await reset();
    const icon = tab(1).locator(selector).first();
    const rect = await icon.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 7, rect.y + rect.height / 2);
    await hover(group('research'));
    await finish();
    expect((await state()).tabs.find((tab) => tab.id === 1).groupId).toBe('research');
    expect((await state()).tabs.find((tab) => tab.id === 1).collapsed).toBe(false);
  }
  console.log('✓ Favicon and disclosure drags suppress the resulting click');

  await reset();
  await send('moveTab', { id: 2, groupId: null });
  await expect(page.locator('#tree > .tab-node > [data-key="tab:2"]')).toBeVisible();
  await begin(group('design'), page.locator('#tree'), 0.95);
  const boundary = await page.locator('.move-marker').boundingBox();
  const rootTab = await tab(2).locator('..').boundingBox();
  expect(boundary.y).toBeCloseTo(rootTab.y, 0);
  await finish();
  expect((await state()).groups.find((group) => group.id === 'design').parentId).toBe(null);
  console.log('✓ Folder append feedback respects the folders-first boundary');

  await reset();
  await begin(tab(2), group('later'));
  await page.evaluate(() => {
    const save = dragTest.api.sessions.setWindowValue;
    dragTest.api.sessions.setWindowValue = async (...args) => {
      dragTest.api.sessions.setWindowValue = save;
      throw new Error('View save unavailable');
    };
  });
  await finish();
  await expect(page.locator('#toast')).toContainText('Moved 1 tab');
  await expect(page.locator('#toast')).toContainText('Could not show the destination');
  expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe('later');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(tab(2)).toBeVisible();
  await expect(page.locator('#toast')).not.toContainText('Could not show');
  console.log('✓ A committed move with a failed reveal offers a working Show retry');

  await reset();
  await begin(tab(2), tab(8), 0.05);
  await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) await dragTest.api.tabs.update(8, { title: `Updated ${i}` });
  });
  await finish();
  await expect(tab(8).locator('.label')).toHaveText('Updated 29');
  expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe('work');
  await reset();
  await begin(tab(2), group('research'));
  await send('moveTab', { id: 2, groupId: null });
  await expect(page.locator('.move-preview')).toContainText('source has changed');
  await finish();
  expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe(null);
  console.log('✓ Live titles do not interrupt a drag and external source moves invalidate it');

  for (const mode of ['light', 'dark', 'forced']) {
    await page.setViewportSize({ width: 220, height: 420 });
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
      reducedMotion: 'reduce',
    });
    await reset();
    await begin(tab(2), group('design'));
    await expect(group('design')).toHaveClass(/drop-inside/);
    const preview = await page.locator('.move-preview').boundingBox();
    expect(preview.x).toBeGreaterThanOrEqual(0);
    expect(preview.x + preview.width).toBeLessThanOrEqual(220);
    expect(preview.y + preview.height).toBeLessThanOrEqual(420);
    await page.screenshot({ path: `test-results/drag-${mode}-narrow.png` });
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  console.log(
    '✓ Drag feedback stays visible in narrow light, dark, forced-colour and reduced-motion views',
  );

  await page.setViewportSize({ width: 320, height: 820 });
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  for (const count of [100, 500, 1000]) {
    await page.goto(`${base}/extension/sidebar.html?demo&count=${count}`);
    await expect(tab(2)).toBeVisible();
    expect((await state()).tabs.length).toBe(count);
    await begin(tab(2), page.locator('#tree'), 0.99);
    await expect
      .poll(() => page.locator('#tree').evaluate((node) => node.scrollTop))
      .toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await tab(count).scrollIntoViewIfNeeded();
    const bottom = await page.locator('#tree').evaluate((node) => node.scrollTop);
    await begin(tab(count), page.locator('#tree'), 0.01);
    await expect
      .poll(() => page.locator('#tree').evaluate((node) => node.scrollTop))
      .toBeLessThan(bottom - 100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect((await state()).tabs.length).toBe(count);
    await expect(page.locator('.dragging,.drop-inside,.drop-invalid')).toHaveCount(0);
  }
  console.log('✓ Edge scrolling works in both directions with 100, 500 and 1,000 tabs');

  await reset();
  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('Typography');
  await begin(tab(2), page.locator('#home'));
  await finish();
  expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe(null);
  for (const cancel of ['blur', 'pointercancel', 'outside']) {
    await reset();
    await begin(tab(2), group('research'));
    if (cancel === 'outside') await page.mouse.move(-10, -10);
    else
      await page.evaluate(
        (type) =>
          type === 'blur'
            ? window.dispatchEvent(new Event(type))
            : document.dispatchEvent(new PointerEvent(type)),
        cancel,
      );
    await page.mouse.up();
    await expect(page.locator('.move-preview')).toBeHidden();
    expect((await state()).tabs.find((tab) => tab.id === 2).groupId).toBe('design');
    await expect(page.locator('.dragging,.drop-inside,.drop-invalid')).toHaveCount(0);
  }
  console.log(
    '✓ Search-origin drags, pointer cancellation, window blur and outside release clean up reliably',
  );

  expect(errors).toEqual([]);
} finally {
  await close();
}
