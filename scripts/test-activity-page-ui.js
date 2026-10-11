import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'light',
});
const errors = [];
page.context().on('page', (tab) => tab.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/extension/activity.html?demo&mockup`);
  await expect(page.getByRole('combobox', { name: 'Layout', exact: true })).toHaveCount(0);
  await expect(page.locator('.activity-row')).toHaveCount(18);
  await page.screenshot({ path: `test-results/activity-timeline.png` });
  await page.getByRole('link', { name: /^Folders/ }).click();
  await page.getByLabel('Folder activity', { exact: true }).selectOption('expanded');
  await expect(page.locator('.activity-row')).toHaveCount(3);
  await page.getByLabel('Folder activity', { exact: true }).selectOption('entered');
  await expect(page.locator('.activity-row')).toHaveCount(3);
  await page.getByRole('link', { name: /^All activity/ }).click();
  await page.getByLabel('Search recent activity').fill('CSS grid');
  await expect(page.locator('.activity-row')).toHaveCount(1);
  await page.getByLabel('Search recent activity').fill('nothing-matches');
  await expect(page.getByText('No matching activity', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.activity-row')).toHaveCount(18);
  await page.getByLabel('Time period').selectOption('yesterday');
  expect(await page.locator('.activity-row').count()).toBeGreaterThan(0);
  await page.getByLabel('Time period').selectOption('all');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `test-results/activity-timeline-dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/activity-timeline-narrow.png` });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.keyboard.press('Tab');
  await page.locator('.item-button').first().focus();
  expect(
    await page
      .locator('.item-button')
      .first()
      .evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe('solid');
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    '✓ Timeline: search, folder filters, dates, dark mode, narrow screens and forced colours',
  );

  // Real document messaging with a shared controller and simulated browser tabs.
  await page.context().addInitScript(() => {
    const shared = window.opener?.activityTest || { listeners: new Set(), tabs: [], calls: [] };
    window.activityTest = shared;
    window.activityWindowId = 1;
    shared.ready ||= import('/preview/activity-demo.js').then(({ createActivityDemo }) =>
      createActivityDemo(() => {
        for (const listener of shared.listeners) listener({ type: 'tabernacle:changed' });
      }),
    );
    window.browser = {
      windows: {
        getCurrent: async () => ({ id: window.activityWindowId, focused: true }),
        update: async (id) => ({ id, focused: true }),
      },
      sidebarAction: {
        open: async () => {
          shared.sidebarOpened = true;
        },
      },
      tabs: {
        query: async ({ windowId }) => shared.tabs.filter((tab) => tab.windowId === windowId),

        create: async ({ windowId, url }) => {
          const tab = { id: shared.tabs.length + 100, windowId, url };
          shared.tabs.push(tab);
          window.open(url, `activity-test-${windowId}`);
          return tab;
        },

        update: async (id, changes) => {
          shared.calls.push({ type: 'activatePage', id, ...changes });
          return Object.assign(
            shared.tabs.find((tab) => tab.id === id),
            changes,
          );
        },
      },
      runtime: {
        id: 'activity-test',
        getURL: (path) => new URL(path, `${location.origin}/extension/`).href,
        onMessage: {
          addListener: (fn) => shared.listeners.add(fn),
          removeListener: (fn) => shared.listeners.delete(fn),
        },

        sendMessage: async (message) => {
          shared.calls.push(message);
          if (shared.fail === message.type) return { ok: false, error: 'Test failure: try again' };
          try {
            if (message.type === 'tabernacle:openPage') {
              const { openInternalPage } = await import('/extension/src/internal-pages.js');
              return {
                ok: true,
                data: await openInternalPage(browser, message.page, message.windowId),
              };
            }
            return {
              ok: true,
              data: await (
                await shared.ready
              ).request({ ...message, type: message.type.replace('tabernacle:', '') }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row').first()).toBeVisible();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  const activity = await opened;
  await expect(activity.locator('.activity-row')).toHaveCount(18);
  await expect(page.locator('#recently-closed')).toBeHidden();
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  expect(await page.evaluate(() => window.activityTest.tabs.length)).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.activityTest.calls.filter((call) => call.type === 'activatePage').length,
      ),
    )
    .toBe(1);
  await activity.getByRole('link', { name: /^Closed tabs/ }).click();
  await page.evaluate(() => {
    window.activityTest.fail = 'tabernacle:restoreClosedTab';
  });
  await activity.getByRole('button', { name: 'Reopen tab: Restaurant Barr', exact: true }).click();
  await expect(activity.getByRole('alert')).toContainText('Test failure');
  await expect(activity.locator('.activity-row')).toHaveCount(5);
  await page.evaluate(() => {
    window.activityTest.fail = null;
  });
  await activity.getByRole('button', { name: 'Reopen tab: Restaurant Barr', exact: true }).click();
  await expect(activity.locator('.activity-row')).toHaveCount(4);
  await expect(page.getByRole('treeitem', { name: /Restaurant Barr/ })).toBeVisible();
  await activity.getByRole('link', { name: /^Viewed tabs/ }).click();
  await activity
    .getByRole('button', { name: 'Switch to tab: Acorn — Firefox design system', exact: true })
    .click();
  await expect(page.locator('.tab-row.active')).toContainText('Acorn');
  await activity.getByRole('link', { name: /^Folders/ }).click();
  await activity.getByRole('button', { name: 'Open folder: Website refresh', exact: true }).click();
  expect(await page.evaluate(() => window.activityTest.sidebarOpened)).toBe(true);
  await expect(page.locator('#group-path')).toContainText('Website refresh');
  await activity.locator('.item-button').first().focus();
  await activity.keyboard.press('ArrowDown');
  await expect(activity.locator('.item-button').nth(1)).toBeFocused();
  // A second view changes the controller and the page refreshes itself.
  await page.evaluate(async () =>
    (await window.activityTest.ready).request({
      type: 'renameGroup',
      windowId: 1,
      id: 'website',
      name: 'Website updates',
    }),
  );
  await expect(
    activity.getByRole('button', { name: 'Open folder: Website updates' }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.activityTest.fail = 'tabernacle:snapshot';
  });
  await activity.reload();
  await expect(activity.getByRole('alert')).toContainText('Test failure');
  await page.evaluate(() => {
    window.activityTest.fail = null;
  });
  await activity.getByRole('button', { name: 'Try again' }).click();
  await expect(activity.getByRole('alert')).toBeHidden();
  await expect(activity.locator('.activity-row').first()).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Launcher opens/reuses one tab; restore, activation, folder navigation, live updates and error recovery',
  );
} finally {
  await close();
}
