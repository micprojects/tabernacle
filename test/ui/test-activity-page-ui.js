import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

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
  await page.evaluate(() => {
    window.retainedActivityRow = document.querySelectorAll('.activity-row')[1];
  });
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
  expect(await page.evaluate(() => retainedActivityRow.isConnected)).toBe(true);
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
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  await expect(page.locator('#recently-closed')).toBeVisible();
  await expect(page.locator('.recently-closed-row')).toHaveCount(18);
  expect(await page.evaluate(() => window.activityTest.tabs.length)).toBe(0);
  await page.setViewportSize({ width: 360, height: 760 });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'test-results/recent-popup-light.png', animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/recent-popup-dark.png', animations: 'disabled' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({
    path: 'test-results/recent-popup-forced-colours.png',
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  const popupOrder = await page
    .locator('.recently-closed-row')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.recentKey));
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const activity = await opened;
  await expect(activity.locator('.activity-row')).toHaveCount(18);
  expect(
    await activity
      .locator('.item-button')
      .evaluateAll((nodes) => nodes.slice(0, 50).map((node) => node.dataset.key)),
  ).toEqual(popupOrder);
  await expect(activity.locator('[data-key="folder:research"] .item-kind')).toHaveText('Expanded');
  const times = await activity
    .locator('.item-time')
    .evaluateAll((nodes) => nodes.map((node) => Date.parse(node.dateTime)));
  expect(times.every((time, i) => i === 0 || time <= times[i - 1])).toBe(true);
  await expect(page.locator('#recently-closed')).toBeHidden();
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  expect(await page.evaluate(() => window.activityTest.tabs.length)).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.activityTest.calls.filter((call) => call.type === 'activatePage').length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    window.activityTest.fail = 'tabernacle:openPage';
  });
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Could not open recent activity');
  await expect(page.locator('#recently-closed-toggle')).toBeFocused();
  await page.evaluate(() => {
    window.activityTest.fail = null;
  });
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

  // A folder expanded in the sidebar becomes the latest activity on both screens.
  await activity.getByRole('link', { name: /^All activity/ }).click();
  await page.evaluate(async () => {
    const controller = await window.activityTest.ready;
    const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
    const state = await send('snapshot');
    if (!state.view.collapsed.includes('personal')) await send('toggleGroup', { id: 'personal' });
    await send('toggleGroup', { id: 'personal' });
  });
  await expect(activity.locator('.item-button').first()).toHaveAttribute(
    'data-key',
    'folder:personal',
  );
  await expect(activity.locator('.item-kind').first()).toHaveText('Expanded');
  await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
  await expect(page.locator('.recently-closed-row').first()).toHaveAttribute(
    'data-recent-key',
    'folder:personal',
  );
  expect(
    await page
      .locator('.recently-closed-row')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.recentKey)),
  ).toEqual(
    await activity
      .locator('.item-button')
      .evaluateAll((nodes) => nodes.slice(0, 50).map((node) => node.dataset.key)),
  );
  for (const options of [
    { locale: 'en-US', timezoneId: 'America/New_York' },
    { locale: 'ar-EG', timezoneId: 'Africa/Cairo' },
    { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  ]) {
    const context = await page.context().browser().newContext(options);
    try {
      const localPage = await context.newPage();
      localPage.on('pageerror', (error) => errors.push(error.message));
      await localPage.goto(`${base}/extension/activity.html?demo&mockup`);
      await expect(localPage.locator('.activity-row')).toHaveCount(18);

      const checkTimes = async () => {
        const result = await localPage.locator('.item-time').evaluateAll((nodes) => {
          const older = nodes.filter((node) => Date.now() - Date.parse(node.dateTime) >= 86400000);
          return {
            older: older.length,
            mismatches: older.filter(
              (node) =>
                node.textContent !==
                new Date(node.dateTime).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
            ).length,
            changedTooltips: nodes.filter(
              (node) => node.title !== new Date(node.dateTime).toLocaleString(),
            ).length,
            locale: new Intl.DateTimeFormat().resolvedOptions().locale,
            timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          };
        });
        expect(result.older).toBeGreaterThan(0);
        expect(result.mismatches).toBe(0);
        expect(result.changedTooltips).toBe(0);
        expect(result.locale).toBe(options.locale);
        expect(result.timeZone).toBe(options.timezoneId);
      };

      await checkTimes();
      await localPage.getByLabel('Search recent activity').fill('nothing-matches');
      await expect(localPage.getByText('No matching activity', { exact: true })).toBeVisible();
      await localPage.getByRole('button', { name: 'Clear filters' }).click();
      await expect(localPage.locator('.activity-row')).toHaveCount(18);
      await checkTimes();
    } finally {
      await context.close();
    }
  }
  expect(errors).toEqual([]);
  console.log('✓ Activity clock labels and tooltips preserve locale and time zone after filtering');
  console.log(
    '✓ Recent popup opens first; More opens/reuses the activity page with launcher errors, item actions and live updates covered',
  );
} finally {
  await close();
}
