import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 620 } });
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
        `
      entries[0] = ['One', 'design', 'https://www.example.com/one'];
      entries[1] = ['Two', 'design', 'https://example.com/two'];
      entries[2] = ['Three', 'research', 'https://example.com/three'];
      entries[3] = ['Four', 'research', 'https://child.example.com/four'];
      entries[4] = ['Five', 'later', 'https://other.test/five'];
      entries[5] = ['Six', 'personal', 'https://other.test/six'];
      for (let i = 6; i < entries.length; i++) entries[i][2] = 'https://single' + i + '.test/';
      const memberships = {};`,
      )
      .replace(
        'return controller;',
        'window.domainsTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => domainsTest.send(type, args), [type, args]);
const pane = page.locator('#domains-view');
const trigger = page.getByRole('button', { name: 'Domains', exact: true });
const row = (domain) => pane.locator(`li[data-domain="${domain}"]`);
const ordered = () =>
  pane.locator('li').evaluateAll((rows) => rows.map((row) => row.dataset.domain));

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  await page.locator('[data-key="group:design"]').dblclick();
  const before = await send('snapshot');
  await trigger.click();
  await expect(pane).toBeVisible();
  await expect(page.locator('#tree')).toBeHidden();
  await expect(page.locator('#navigation-capsule')).toBeHidden();
  await expect(page.locator('#pinned-tabs')).toBeHidden();
  await expect(page.locator('#tree-toggle')).toBeDisabled();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(await ordered()).toEqual(['example.com', 'other.test']);
  await expect(row('example.com').locator('.domains-tab-count')).toHaveText('4');
  await expect(pane.getByRole('status')).toHaveText('2 domains');
  await expect(pane.getByRole('heading', { name: 'Pinned', exact: true })).toBeHidden();

  await pane.getByRole('button', { name: 'Pin other.test', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Unpin other.test', exact: true })).toBeFocused();
  expect(await ordered()).toEqual(['other.test', 'example.com']);
  await expect(pane.getByRole('list', { name: 'Pinned domains' }).locator('li')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/domains-pinned-320.png' });
  const after = await send('snapshot');
  expect(after.tabs).toEqual(before.tabs);
  expect(after.view).toEqual(before.view);
  expect(after.pins).toEqual(before.pins);

  // Directory navigation uses the existing filter untouched: no added back/pin UI.
  await row('example.com').locator('.domains-open-domain').click();
  await expect(pane).toBeHidden();
  await expect(page.locator('#domain-name')).toHaveText('example.com');
  await expect(page.locator('#domain-count')).toHaveText('4 tabs');
  await expect(page.locator('#tree .tab-row')).toHaveCount(4);
  await expect(page.locator('#domain-close')).toBeFocused();
  await expect(page.locator('#domain-header button')).toHaveCount(1);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  expect((await send('snapshot')).view).toEqual(before.view);

  await trigger.click();
  await page.keyboard.press('ArrowDown');
  await expect(row('other.test').locator('.domains-open-domain')).toBeFocused();
  await page.keyboard.press('End');
  await expect(row('example.com').locator('.domains-open-domain')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row('other.test').locator('.domains-open-domain')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(pane).toBeHidden();
  await trigger.press('Enter');
  await page.keyboard.press('Control+k');
  await expect(pane).toBeHidden();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill('missing result');
  await trigger.click();
  await expect(pane).toBeVisible();
  expect(await ordered()).toEqual(['other.test', 'example.com']);

  // A navigation below the two-tab threshold removes the row but retains its pin.
  await row('other.test').locator('.domains-open-domain').focus();
  await page.evaluate(() => domainsTest.api.tabs.update(6, { url: 'https://single-new.test/' }));
  await expect(row('other.test')).toHaveCount(0);
  await expect(row('example.com').locator('.domains-open-domain')).toBeFocused();
  expect((await send('snapshot')).domainPins).toEqual(['other.test']);
  await page.evaluate(() => domainsTest.api.tabs.update(6, { url: 'https://other.test/returned' }));
  await expect(row('other.test')).toBeVisible();
  await expect(row('other.test').locator('.domains-pin')).toHaveAttribute('aria-pressed', 'true');
  await pane.getByRole('button', { name: 'Unpin other.test', exact: true }).click();
  expect(await ordered()).toEqual(['example.com', 'other.test']);

  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.screenshot({ path: 'test-results/domains-dark-320.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  expect(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: 'test-results/domains-forced-colours-220.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.setViewportSize({ width: 320, height: 620 });

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await trigger.click();
  await page.evaluate(async () => {
    const tabs = (await domainsTest.send('snapshot')).tabs;
    for (const tab of tabs)
      await domainsTest.api.tabs.update(tab.id, { url: `https://single-${tab.id}.test/` });
  });
  await expect(pane.getByRole('heading', { name: 'No domains with multiple tabs' })).toBeVisible();
  await expect(pane.getByRole('status')).toHaveText('0 domains');
  expect(errors).toEqual([]);
  console.log(
    '✓ Domains navigation, counts, persistent pins, live changes, keyboard, empty state and themes',
  );
} finally {
  await close();
}
