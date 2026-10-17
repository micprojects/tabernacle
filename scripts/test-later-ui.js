import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 400, height: 740 } });
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
      entries.splice(0, 7,
        ['A practical guide to CSS container queries', 'design', 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries'],
        ['How the London Underground map was designed', 'design', 'https://www.youtube.com/watch?v=abcdefghijk'],
        ['Ideas for the next release', 'design', 'https://docs.google.com/document/d/example/edit'],
        ['The history of the World Wide Web', 'design', 'https://en.wikipedia.org/wiki/World_Wide_Web'],
        ['Building a small desk from solid oak', 'research', 'https://www.youtube.com/watch?v=lmnopqrstuv'],
        ['Why we keep coming back to old technology', 'research', 'https://www.bbc.co.uk/news/articles/example'],
        ['Places for a weekend in Copenhagen', 'research', 'https://maps.google.com/']
      );
      const memberships = {};`,
      )
      .replace(
        'return controller;',
        'window.laterTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
      ),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => laterTest.send(type, args), [type, args]);
const pane = page.locator('#later-view');
const trigger = page.getByRole('button', { name: 'Saved for Later', exact: true });
const row = (id) => pane.locator(`.later-row[data-id="${id}"]`);
const filter = (name) => pane.getByRole('button', { name, exact: true });
const search = pane.getByRole('searchbox');

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(trigger).toBeEnabled();
  expect(
    await page
      .locator('footer button')
      .evaluateAll((buttons) => buttons.map((button) => button.id)),
  ).toEqual([
    'new-tab',
    'new-group',
    'tree-toggle',
    'later-toggle',
    'domains-toggle',
    'recently-closed-toggle',
    'settings',
  ]);
  await trigger.click();
  await expect(pane.getByRole('heading', { name: 'Saved for Later', exact: true })).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Nothing saved for later' })).toBeVisible();
  await expect(page.locator('#tree')).toBeHidden();
  await expect(page.locator('#navigation-capsule')).toBeHidden();
  await expect(page.locator('#tree-toggle')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();

  await page.locator('#tree .tab-row[data-id="1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save for later', exact: true }).click();
  await expect(page.locator('#tree .tab-row[data-id="1"]')).toHaveCount(0);
  await expect(page.locator('#tree .tab-row[data-id="2"]')).toBeVisible();
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree .tab-row[data-id="1"]')).toBeVisible();

  for (const id of [7, 6, 5, 4, 3, 2, 1]) await send('saveForLater', { id });
  await trigger.click();
  await expect(pane.locator('.later-row')).toHaveCount(7);
  await expect(pane.locator('.later-row').first()).toHaveAttribute('data-id', '1');
  await expect(pane.getByRole('status')).toHaveText('7 tabs');
  await expect(row(7)).toBeVisible();
  await row(1).hover();
  await expect(page.locator('#toast')).toBeHidden({ timeout: 6000 });
  await page.screenshot({ path: 'test-results/later-all-400.png' });

  await filter('Articles').click();
  await expect(pane.locator('.later-row')).toHaveCount(3);
  await expect(pane.getByRole('status')).toHaveText('3 of 7 tabs');
  await filter('Videos').click();
  await expect(pane.locator('.later-row')).toHaveCount(2);
  await row(2).locator('.later-open-tab').click();
  await expect(row(2).locator('.later-open-tab')).toHaveAttribute('aria-current', 'true');
  await expect(pane).toBeVisible();
  await search.fill('OAK');
  await expect(pane.locator('.later-row')).toHaveCount(1);
  await expect(row(5)).toBeVisible();
  await search.fill('nothing matches');
  await expect(pane.getByRole('heading', { name: 'No matching tabs' })).toBeVisible();
  await search.fill('');
  await filter('Documents').click();
  await expect(pane.locator('.later-row')).toHaveCount(1);
  await expect(row(3)).toBeVisible();
  await filter('All').click();
  await pane.getByRole('combobox').selectOption('oldest');
  const times = await send('snapshot');
  const first = await pane.locator('.later-row').first().getAttribute('data-id');
  expect(times.tabs.find((tab) => tab.id === Number(first)).savedForLaterAt).toBe(
    Math.min(...times.tabs.filter((tab) => tab.savedForLaterAt).map((tab) => tab.savedForLaterAt)),
  );
  await pane.getByRole('combobox').selectOption('newest');

  await pane.locator('#later-close').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(1).locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('End');
  await expect(pane.locator('.later-row').last().locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(1).locator('.later-open-tab')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Return to original folder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toBeVisible();
  await row(1).getByRole('button', { name: 'Return to Design', exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator('#tree .tab-row[data-id="1"]')).toBeVisible();
  expect((await send('snapshot')).tabs.find((tab) => tab.id === 1).savedForLaterAt).toBeUndefined();

  await trigger.click();
  await expect(pane.locator('.later-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Domains', exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator('#domains-view')).toBeVisible();
  await trigger.click();
  await expect(page.locator('#domains-view')).toBeHidden();
  await expect(pane).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(pane).toBeHidden();
  await expect(page.locator('#search')).toBeFocused();
  await trigger.click();
  await expect(search).toBeVisible();

  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.setViewportSize({ width: 320, height: 620 });
  await page.screenshot({ path: 'test-results/later-dark-320.png' });
  await page.setViewportSize({ width: 220, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  expect(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const boxes = await page.locator('footer button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  expect(boxes.every((box) => box.left >= 0 && box.right <= 220)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: 'test-results/later-forced-colours-220.png' });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.setViewportSize({ width: 400, height: 740 });

  await row(2).locator('.later-open-tab').click();
  await row(2).getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect(row(2)).toHaveCount(0);
  await expect(pane.locator('.later-row')).toHaveCount(5);
  expect((await send('snapshot')).tabs.some((tab) => tab.id === 3)).toBe(true);
  for (const id of [3, 4, 5, 6, 7]) await send('closeTab', { id });
  await expect(pane.getByRole('heading', { name: 'Nothing saved for later' })).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Saved for Later: save/undo, filters, search, sorting, return, safe close, footer order, keyboard and themes',
  );
} finally {
  await close();
}
