import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.addInitScript(() => {
    const messages = new Set();
    const focusListeners = new Set();
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        events: true,
        tabs: [
          { id: 1, windowId: 1, index: 0, title: 'Parent' },
          { id: 2, windowId: 1, index: 1, title: 'Child' },
          { id: 3, windowId: 1, index: 2, title: 'Other', active: true },
        ],
        memberships: {
          1: { groupId: null, treeId: 'parent', ancestors: [] },
          2: { groupId: null, treeId: 'child', ancestors: ['parent'] },
          3: { groupId: null, treeId: 'other', ancestors: [] },
        },
      });
      const controller = createController(api, (notice) => {
        for (const listener of messages) listener({ type: 'tabernacle:changed', ...notice });
      });
      api.windows.onFocusChanged.addListener((id) => {
        for (const listener of focusListeners) listener(id);
      });
      window.tabClickTest = {
        focus: (focused) => api.windows.update(1, { focused }),
        send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }),
      };
      return { api, controller };
    });
    window.browser = {
      windows: {
        getCurrent: async () => (await ready).api.windows.get(1),
        onFocusChanged: { addListener: (listener) => focusListeners.add(listener) },
      },
      runtime: {
        id: 'tabernacle-tab-click-test',
        onMessage: { addListener: (listener) => messages.add(listener) },

        sendMessage: async (message) => {
          try {
            const data = await (
              await ready
            ).controller.request({
              ...message,
              type: message.type.slice('tabernacle:'.length),
            });
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  const parent = page.locator('[data-key="tab:1"]');
  const child = page.locator('[data-key="tab:2"]');
  const other = page.locator('[data-key="tab:3"]');
  const label = parent.locator('.label');
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await label.click();
  await expect(parent).toHaveAttribute('aria-selected', 'true');
  await expect(child).toBeVisible();
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await other.locator('.label').click();
  await label.click();
  await expect(parent).toHaveAttribute('aria-selected', 'true');
  await expect(child).toHaveCount(0);
  await label.click();
  await expect(child).toBeVisible();
  console.log('✓ Tab titles activate without folding, then toggle on repeated clicks');

  await other.locator('.label').click();
  await parent.locator('.tab-icon').click();
  await expect(parent).toHaveAttribute('aria-selected', 'true');
  await expect(child).toHaveCount(0);
  await other.locator('.label').click();
  await parent.locator('.tab-disclosure').click();
  await expect(parent).toHaveAttribute('aria-selected', 'true');
  await expect(child).toBeVisible();
  await parent.focus();
  await page.keyboard.press('Enter');
  await expect(child).toBeVisible();
  await page.keyboard.press('Space');
  await expect(child).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(child).toBeVisible();
  console.log(
    '✓ Favicons and disclosure controls activate and toggle; keyboard controls still work',
  );

  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => tabClickTest.focus(false));
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => page.evaluate(async () => (await browser.windows.getCurrent()).focused))
    .toBe(true);
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');

  // Native focus can also arrive before pointerdown. Holding the button must
  // retain the original intent even after the activation grace period expires.
  await page.evaluate(async () => {
    await tabClickTest.focus(false);
    await tabClickTest.focus(true);
  });
  const bounds = await label.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.clock.runFor(500);
  await page.mouse.up();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(async () => {
    await tabClickTest.focus(false);
    await tabClickTest.focus(true);
  });
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await label.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  console.log('✓ Returning window focus preserves children, including a held activation click');

  await page.evaluate(async () => {
    await tabClickTest.send('activateTab', { id: 3 });
    await tabClickTest.focus(false);
  });
  await parent.locator('.tab-icon').click();
  await expect(parent).toHaveAttribute('aria-selected', 'true');
  await expect(child).toBeVisible();
  console.log('✓ A favicon click in an unfocused window both activates and unfolds the parent');
  expect(errors).toEqual([]);
} finally {
  await close();
}
