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
  const shelf = page.locator('#pinned-tabs');
  const pin = (id) => shelf.locator(`[data-key="tab:${id}"]`);
  const order = () =>
    shelf
      .locator('.pinned-tab')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.key.slice(4))));
  const snapshot = () => page.evaluate(() => pinTest.send('snapshot'));

  const move = async (source, target, side) => {
    const bounds = await pin(target).boundingBox();
    await pin(source).dragTo(pin(target), {
      targetPosition: { x: side === 'before' ? 3 : bounds.width - 3, y: bounds.height / 2 },
    });
  };

  const marker = () =>
    shelf.locator('.drop-before, .drop-after').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node, '::before');
      return {
        x: rect.left + node.clientLeft + parseFloat(style.left),
        y: rect.top + node.clientTop + parseFloat(style.top),
        width: parseFloat(style.width),
      };
    });

  await expect(shelf.locator('.pinned-tab')).toHaveCount(4);
  const before = await snapshot();
  await move(13, 10, 'before');
  await expect.poll(order).toEqual([13, 10, 11, 12]);
  await move(13, 12, 'after');
  await expect.poll(order).toEqual([10, 11, 12, 13]);
  const bounds = await shelf.boundingBox();
  await pin(10).dragTo(shelf, { targetPosition: { x: bounds.width - 2, y: 14 } });
  await expect.poll(order).toEqual([11, 12, 13, 10]);
  const after = await snapshot();
  expect(after.tabs.find((tab) => tab.active).id).toBe(before.tabs.find((tab) => tab.active).id);
  expect(after.tabs.filter((tab) => !tab.pinned)).toEqual(before.tabs.filter((tab) => !tab.pinned));
  expect(after.view).toEqual(before.view);
  console.log(
    '✓ Holding and dragging pins reorders both directions and into empty space without activating',
  );

  await pin(12).click();
  await expect(pin(12)).toHaveAttribute('aria-pressed', 'true');
  await move(12, 12, 'before');
  await expect.poll(order).toEqual([11, 12, 13, 10]);
  await pin(12).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Unpin tab', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await pin(13).focus();
  await page.keyboard.press('Enter');
  await expect(pin(13)).toHaveAttribute('aria-pressed', 'true');
  console.log('✓ Normal clicks, keyboard activation, context menus and self drops still work');

  const left = await pin(11).boundingBox();
  const right = await pin(12).boundingBox();
  const gapCenter = (left.x + left.width + right.x) / 2;
  for (const dropX of [left.x + left.width - 3, right.x + 3]) {
    const source = await pin(10).boundingBox();
    await page.mouse.move(source.x + 14, source.y + 14);
    await page.mouse.down();
    await page.mouse.move(source.x + 14, source.y + 3, { steps: 4 });
    for (const x of [left.x + left.width - 3, gapCenter, right.x + 3, dropX]) {
      await page.mouse.move(x, left.y + 14, { steps: 4 });
      // A new native drag target receives dragenter before its first dragover.
      await page.mouse.move(x, left.y + 14);
      await expect(shelf.locator('.drop-before, .drop-after')).toHaveCount(1);
      const position = await marker();
      expect(position.x).toBeCloseTo(gapCenter, 1);
      expect(position.width).toBe(2);
    }
    await page.screenshot({ path: 'test-results/pinned-tab-centered-insertion.png' });
    await page.mouse.up();
    await expect.poll(order).toEqual([11, 10, 12, 13]);
    await expect(shelf.locator('.dragging, .drop-before, .drop-after')).toHaveCount(0);
    await move(10, 13, 'after');
    await expect.poll(order).toEqual([11, 12, 13, 10]);
  }
  console.log('✓ Both sides of a gap show one centered marker and produce the same pinned order');

  await page.setViewportSize({ width: 220, height: 820 });
  const extra = await page.evaluate(async () => {
    const ids = [];
    for (let index = 0; index < 8; index++) {
      const tab = await pinTest.api.tabs.create({
        windowId: 1,
        pinned: true,
        title: `Extra pin ${index}`,
        active: false,
      });
      ids.push(tab.id);
    }
    await pinTest.send('snapshot');
    return ids;
  });
  await expect(shelf.locator('.pinned-tab')).toHaveCount(12);
  const last = extra.at(-1);
  expect((await pin(last).boundingBox()).y).toBeGreaterThan((await pin(11).boundingBox()).y);
  const source = await pin(last).boundingBox();
  const target = await pin(11).boundingBox();
  await page.mouse.move(source.x + 14, source.y + 14);
  await page.mouse.down();
  await page.mouse.move(source.x + 14, source.y + 3, { steps: 4 });
  const rowEnd = await pin(extra[1]).boundingBox();
  const rowStart = await pin(extra[2]).boundingBox();
  expect(rowStart.y).toBeGreaterThan(rowEnd.y);
  await page.mouse.move(rowEnd.x + rowEnd.width - 3, rowEnd.y + 14, { steps: 8 });
  await page.mouse.move(rowEnd.x + rowEnd.width - 3, rowEnd.y + 14);
  await expect(pin(extra[2])).toHaveClass(/drop-before/);
  const rowMarker = await marker();
  await page.mouse.move(rowStart.x + 3, rowStart.y + 14, { steps: 8 });
  await page.mouse.move(rowStart.x + 3, rowStart.y + 14);
  await expect(pin(extra[2])).toHaveClass(/drop-before/);
  expect(await marker()).toEqual(rowMarker);
  await page.mouse.move(target.x + 3, target.y + 14, { steps: 8 });
  await expect(pin(last)).toHaveClass(/dragging/);
  await expect(pin(11)).toHaveClass(/drop-before/);
  const startMarker = await marker();
  expect(startMarker.x - startMarker.width / 2).toBeGreaterThanOrEqual(
    (await shelf.boundingBox()).x,
  );
  await page.screenshot({ path: 'test-results/pinned-tab-reordering.png' });
  await page.mouse.up();
  await expect.poll(order).toEqual([last, 11, 12, 13, 10, ...extra.slice(0, -1)]);
  await expect(shelf.locator('.dragging, .drop-before, .drop-after')).toHaveCount(0);
  console.log('✓ Wrapped pins share one marker at row boundaries and keep the first slot visible');

  const savedOrder = await order();
  await pin(last).dragTo(page.locator('#home'));
  await expect.poll(order).toEqual(savedOrder);
  await expect(shelf.locator('.dragging, .drop-before, .drop-after')).toHaveCount(0);
  expect((await snapshot()).tabs.find((tab) => tab.id === last).pinned).toBe(true);
  await page.evaluate(() => {
    pinTest.api.tabs.move = async () => {
      throw new Error('Move refused');
    };
  });
  await move(last, 11, 'after');
  await expect(page.locator('#toast')).toHaveText('Move refused');
  await expect.poll(order).toEqual(savedOrder);
  await expect(shelf.locator('.dragging, .drop-before, .drop-after')).toHaveCount(0);
  console.log('✓ Dropping outside the pins or a failed move leaves the order intact');
  expect(errors).toEqual([]);
} finally {
  await close();
}
