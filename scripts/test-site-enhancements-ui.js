import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 360, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    const listeners = new Set(),
      added = new Set(),
      removed = new Set();
    let controller, api, ready;
    window.accessTest = {
      grants: [],
      requests: [],
      removals: [],
      deny: false,
      fail: false,
      reads: [],
    };
    const event = (listeners) => ({
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    });
    const prepare = () =>
      (ready ??= Promise.all([
        import('/extension/src/controller.js'),
        import('/preview/browser.js'),
        import('/extension/src/site-enhancements.js'),
      ]).then(([{ createController }, { memoryBrowser }, { coversOrigin }]) => {
        api = memoryBrowser({
          tabs: [
            {
              id: 1,
              index: 0,
              windowId: 1,
              active: true,
              title: 'A video - YouTube',
              url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
            },
            {
              id: 2,
              index: 1,
              windowId: 1,
              title: 'A post - Reddit',
              url: 'https://www.reddit.com/r/test/comments/abc123/post/',
            },
          ],
        });
        window.browser.tabs.get = api.tabs.get;
        window.browser.sessions = api.sessions;
        window.browser.permissions.contains = async ({ origins }) =>
          origins.every((origin) => accessTest.grants.some((grant) => coversOrigin(grant, origin)));
        controller = createController(api, (notice) => {
          for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
        });
      }));
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      tabs: {},
      permissions: {
        getAll: async () => ({ origins: [...accessTest.grants] }),
        onAdded: event(added),
        onRemoved: event(removed),

        request: async ({ origins }) => {
          accessTest.requests.push(origins);
          if (accessTest.deny) return false;
          accessTest.grants.push(...origins);
          for (const listener of added) listener({ origins });
          return true;
        },

        remove: async ({ origins }) => {
          accessTest.removals.push(origins);
          accessTest.grants = accessTest.grants.filter((origin) => !origins.includes(origin));
          for (const listener of removed) listener({ origins });
          return true;
        },
      },
      scripting: {
        executeScript: async ({ target }) => {
          accessTest.reads.push(target.tabId);
          return [{ result: null }];
        },
      },
      runtime: {
        id: 'enhancements-test',
        onMessage: event(listeners),

        sendMessage: async (message) => {
          await prepare();
          try {
            if (accessTest.fail && message.type.startsWith('tabernacle:set'))
              throw new Error('Storage unavailable');
            return {
              ok: true,
              data: await controller.request({
                ...message,
                type: message.type.slice('tabernacle:'.length),
              }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row.active')).toBeVisible();
  const open = await prepareSettings(page);
  const settings = await open();
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.setViewportSize({ width: 1180, height: 1100 });
  await settings.getByRole('link', { name: 'Site Enhancements', exact: true }).click();
  const master = settings.getByRole('switch', { name: 'Enable site enhancements', exact: true });
  const youtube = settings.getByRole('switch', { name: 'YouTube', exact: true });
  const reddit = settings.getByRole('switch', { name: 'Reddit', exact: true });
  const siteRow = (id) => settings.locator(`[data-enhancement="${id}"]`);

  const filter = async (id) => {
    await page.locator(`#tree [data-key="tab:${id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  };

  await expect(settings.getByRole('switch')).toHaveCount(10);
  await expect(master).toBeChecked();
  await filter(1);
  await expect(page.locator('.youtube-row')).toHaveCount(1);
  await youtube.uncheck();
  await expect(page.locator('.youtube-row')).toHaveCount(0);
  await expect(page.locator('#youtube-mode')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#youtube-mode').click();
  await settings.bringToFront();
  await expect(youtube).toBeChecked();
  await reddit.uncheck();
  await master.uncheck();
  await expect(page.locator('#youtube-mode')).toBeHidden();
  await expect(page.locator('#youtube-tools')).toBeHidden();
  await expect(page.locator('#youtube-access')).toBeHidden();
  await expect(page.locator('#domain-count')).toBeVisible();
  await expect(page.locator('.youtube-row')).toHaveCount(0);
  await expect(youtube).toBeDisabled();
  await page.locator('#domain-close').click();
  await filter(2);
  await expect(page.locator('#site-mode')).toBeHidden();
  await expect(page.locator('.site-row')).toHaveCount(0);
  await master.check();
  await expect(reddit).not.toBeChecked();
  await expect(page.locator('#site-mode')).toBeVisible();
  await expect(page.locator('#site-mode')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#site-mode').click();
  await settings.bringToFront();
  await expect(reddit).toBeChecked();
  await expect(page.locator('.site-row')).toHaveCount(1);
  await master.uncheck();
  await expect(page.locator('.site-row')).toHaveCount(0);
  await expect(page.locator('#site-access')).toBeHidden();
  await settings.reload();
  await expect(master).not.toBeChecked();
  await expect(reddit).toBeChecked();
  await master.check();
  await page.evaluate(() => {
    accessTest.fail = true;
  });
  await reddit.click();
  await expect(settings.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(reddit).toBeChecked();
  await page.evaluate(() => {
    accessTest.fail = false;
  });
  await reddit.uncheck();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  console.log(
    '✓ Global off hides both domain switches, restores standard rows and preserves individual choices; settings and domain switches stay in sync and survive reload',
  );

  await siteRow('reddit').locator('summary').click();
  await page.evaluate(() => {
    accessTest.deny = true;
  });
  await siteRow('reddit').getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Access was not granted');
  await expect(siteRow('reddit').getByRole('status')).toHaveText('Access not allowed.');
  await page.evaluate(() => {
    accessTest.deny = false;
  });
  await siteRow('reddit').getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(siteRow('reddit').getByRole('status')).toHaveText('Access allowed.');
  expect(await page.evaluate(() => accessTest.requests.at(-1))).toEqual(['https://*.reddit.com/*']);
  await reddit.check();
  await expect(page.locator('#site-access')).toBeHidden();
  await master.uncheck();
  await siteRow('reddit').getByRole('button', { name: 'Revoke access', exact: true }).click();
  await expect(siteRow('reddit').getByRole('status')).toHaveText('Access not allowed.');
  await master.check();
  await expect(page.locator('#site-access')).toBeVisible();
  await siteRow('shopping').locator('summary').click();
  await siteRow('shopping').getByRole('combobox').selectOption('amazon.co.uk');
  await siteRow('shopping').getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(siteRow('shopping').getByRole('status')).toHaveText('Access allowed.');
  expect(await page.evaluate(() => accessTest.requests.at(-1))).toEqual([
    'https://*.amazon.co.uk/*',
  ]);
  await page.evaluate(async () => {
    await browser.permissions.request({ origins: ['https://*/*'] });
  });
  await expect(siteRow('reddit').getByRole('status')).toContainText('Allowed by wider site access');
  await expect(
    siteRow('reddit').getByRole('button', { name: 'Revoke access', exact: true }),
  ).toBeDisabled();
  await page.evaluate(async () => {
    await browser.permissions.remove({ origins: ['https://*/*'] });
  });
  await expect(siteRow('reddit').getByRole('status')).toHaveText('Access not allowed.');
  await expect(siteRow('shopping').getByRole('status')).toHaveText('Access allowed.');
  await siteRow('reddit').locator('summary').click();
  await siteRow('shopping').locator('summary').click();
  console.log(
    '✓ Permissions handle denial, grant, revocation while globally off, scoped shopping access and external permission changes without removing broader grants',
  );

  await settings.screenshot({ path: 'test-results/site-enhancements-light.png', fullPage: true });
  await page.evaluate(() =>
    browser.runtime.sendMessage({
      type: 'tabernacle:setLook',
      windowId: 1,
      partial: true,
      value: { colorScheme: 'dark' },
    }),
  );
  await expect(settings.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await settings.screenshot({ path: 'test-results/site-enhancements-dark.png', fullPage: true });
  await settings.setViewportSize({ width: 360, height: 800 });
  await siteRow('shopping').locator('summary').click();
  expect(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await settings.evaluate(() => window.scrollTo(0, 0));
  await settings.screenshot({ path: 'test-results/site-enhancements-narrow.png', fullPage: true });
  expect(errors).toEqual([]);
} finally {
  await close();
}
