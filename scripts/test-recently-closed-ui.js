import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 360, height: 660 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const popup = page.locator('#recently-closed');
const trigger = page.locator('#recently-closed-toggle');
const rows = popup.locator('.recently-closed-row');

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.closedTabsTest = {});
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        events: true,
        groups: [{ id: 'work', name: 'Work', parentId: null }],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            title: 'Nyhavn — Wikipedia',
            url: 'https://en.wikipedia.org/wiki/Nyhavn',
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            title: 'Restaurant Barr — Copenhagen',
            url: 'https://restaurantbarr.com',
          },
          { id: 3, windowId: 1, index: 2, title: 'Keep open', active: true },
        ],
        memberships: { 1: { groupId: 'work' } },
      });
      const history = api.sessions.getRecentlyClosed;
      api.sessions.getRecentlyClosed = async () => {
        if (testing.failHistory) throw new Error('Session access denied');
        return history();
      };
      const restore = api.sessions.restore;
      api.sessions.restore = async (id) => {
        if (testing.failRestore) throw new Error('Firefox refused restore');
        return restore(id);
      };
      testing.api = api;
      return createController(api, () => {
        for (const listener of listeners) listener({ type: 'tabernacle:changed' });
      });
    });
    testing.send = async (type, args = {}) => (await ready).request({ ...args, type, windowId: 1 });
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      runtime: {
        id: 'recently-closed-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          try {
            return {
              ok: true,
              data: await testing.send(message.type.replace('tabernacle:', ''), message),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await trigger.click();
  await expect(popup.getByText('No recently closed tabs.', { exact: true })).toBeVisible();
  await expect(popup.getByRole('heading')).toHaveText('Recently closed');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.evaluate(async () => {
    await window.closedTabsTest.send('closeTab', { id: 1 });
    await window.closedTabsTest.send('closeTab', { id: 2 });
  });
  await trigger.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('.recently-closed-label')).toHaveText([
    'Restaurant Barr — Copenhagen',
    'Nyhavn — Wikipedia',
  ]);
  await expect(rows.first()).toBeFocused();
  expect(await popup.textContent()).not.toMatch(/This window|Newest first|Click a tab|2 tabs/);
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.screenshot({ path: 'test-results/recently-closed-light.png' });
  await page.keyboard.press('Enter');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('[data-key="group:work"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('treeitem', { name: /Nyhavn/ })).toBeVisible();
  await trigger.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('aria-label', 'Reopen Restaurant Barr — Copenhagen');

  // External closes update the open popover without losing the selected row.
  await page.evaluate(() => window.closedTabsTest.api.tabs.remove(3));
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toBeFocused();
  await page.locator('#home').click();
  await expect(popup).toBeHidden();
  await trigger.click();
  await trigger.click();
  await expect(popup).toBeHidden();

  // A failed restore keeps the history entry available for another attempt.
  await page.evaluate(() => {
    window.closedTabsTest.failRestore = true;
  });
  await trigger.click();
  await rows.first().click();
  await expect(page.locator('#toast')).toHaveText('Firefox refused restore');
  await trigger.click();
  await expect(rows).toHaveCount(2);
  await popup.getByRole('button', { name: 'Close recently closed tabs' }).click();
  await page.evaluate(() => {
    window.closedTabsTest.failRestore = false;
    window.closedTabsTest.failHistory = true;
    window.closedTabsTest.api.sessions.onChanged.emit();
  });
  await trigger.click();
  await expect(popup.getByRole('status')).toContainText('Session access denied');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.closedTabsTest.failHistory = false;
    window.closedTabsTest.api.sessions.onChanged.emit();
  });

  // Dense history uses at most half the sidebar and adapts while open on resize.
  await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      const tab = await window.closedTabsTest.api.tabs.create({
        title: `Long recently closed tab title ${i} — detailed page name`,
        favIconUrl: 'data:image/png;base64,broken',
      });
      await window.closedTabsTest.api.tabs.remove(tab.id);
    }
  });
  await trigger.click();
  await expect(rows).toHaveCount(32);
  const fullHeight = await popup.evaluate((node) => node.getBoundingClientRect().height);
  expect(fullHeight).toBeGreaterThan(250);
  expect(fullHeight).toBeLessThanOrEqual(330);
  await page.screenshot({ path: 'test-results/recently-closed-half-height.png' });
  await page.setViewportSize({ width: 220, height: 320 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  const bounds = await popup.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const trigger = document.getElementById('recently-closed-toggle').getBoundingClientRect();
    const list = node.querySelector('.recently-closed-list');
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      triggerTop: trigger.top,
      overflow: node.scrollWidth > node.clientWidth,
      scrolls: list.scrollHeight > list.clientHeight,
      scrolled: list.scrollTop > 0,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(8);
  expect(bounds.right).toBeLessThanOrEqual(212);
  expect(bounds.top).toBeGreaterThanOrEqual(8);
  expect(bounds.bottom).toBeLessThan(bounds.triggerTop);
  expect(bounds.height).toBeLessThanOrEqual(160);
  expect(bounds.overflow).toBe(false);
  expect(bounds.scrolls).toBe(true);
  expect(bounds.scrolled).toBe(true);
  await page.screenshot({ path: 'test-results/recently-closed-narrow-dark.png' });
  await page.keyboard.press('Tab');
  await expect(popup).toBeHidden();
  expect(errors).toEqual([]);
  console.log(
    '✓ Recently closed popover supports ordering, selected restore, live updates, errors, keyboard navigation and narrow layouts',
  );
} finally {
  await close();
}
