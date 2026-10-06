import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 660 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const settleNavigation = () =>
  page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.allSettled(
      document
        .querySelector('#navigation-capsule')
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.locator('[data-key="group:design"]').dblclick();
  const capsule = page.locator('#navigation-capsule');
  const breadcrumbs = page.locator('#breadcrumbs');
  const current = page.locator('#scope-heading');
  const trigger = page.locator('#search-toggle');
  const search = page.getByRole('searchbox');
  const tree = page.locator('#tree');
  const pins = page.locator('#pinned-tabs');
  await expect(current).toHaveText('Design');
  await expect(page.locator('header').getByText('Design', { exact: true })).toHaveCount(1);
  await expect(breadcrumbs.locator('.crumb')).toHaveText(['', 'Work', 'Design']);
  await expect(current).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('footer #search-toggle')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/navigation-capsule-browsing.png' });

  for (const width of [220, 320, 480]) {
    await page.setViewportSize({ width, height: 660 });
    await settleNavigation();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(page.locator('#home')).toHaveAccessibleName('Home');
    await expect(page.locator('#home')).toBeVisible();
    const before = await capsule.boundingBox();
    const treeBefore = await tree.boundingBox();
    const iconBefore = await trigger.boundingBox();
    const currentBox = await current.boundingBox();
    expect(currentBox.x).toBeGreaterThanOrEqual(before.x);
    expect(currentBox.x + currentBox.width).toBeLessThan(iconBefore.x);
    await trigger.click();
    await expect(search).toBeFocused();
    await expect(breadcrumbs).toBeHidden();
    await settleNavigation();
    await expect(breadcrumbs.getByRole('button')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const iconAfter = await trigger.boundingBox();
    const input = await search.boundingBox();
    const closeButton = await page.locator('#search-close').boundingBox();
    expect(iconAfter.x).toBeLessThan(iconBefore.x);
    expect(input.x).toBeGreaterThanOrEqual(iconAfter.x + iconAfter.width);
    expect(input.width).toBeGreaterThan(90);
    expect(closeButton.x + closeButton.width).toBeLessThan(before.x + before.width);
    expect(await capsule.boundingBox()).toEqual(before);
    expect(await tree.boundingBox()).toEqual(treeBefore);
    if (width === 320)
      await page.screenshot({ path: 'test-results/navigation-capsule-search.png' });
    await page.keyboard.press('Tab');
    await expect(page.locator('#search-close')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
    await expect(search).toHaveCount(0);
    await expect(breadcrumbs).toBeVisible();
    await settleNavigation();
    expect(await tree.boundingBox()).toEqual(treeBefore);
  }
  console.log('✓ One folder title, sliding search, stable layout and keyboard focus at 220–480px');

  await page.keyboard.press('Control+k');
  const pinsBefore = await pins.boundingBox();
  const capsuleBefore = await capsule.boundingBox();
  await search.fill('Typography');
  await expect(page.locator('[data-key="tab:2"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:3"]')).toHaveCount(0);
  await expect(pins.locator('.pinned-tab')).toHaveCount(4);
  expect(await pins.boundingBox()).toEqual(pinsBefore);
  expect(await capsule.boundingBox()).toEqual(capsuleBefore);
  await page.keyboard.press('Control+k');
  expect(await search.evaluate((input) => input.selectionEnd - input.selectionStart)).toBe(10);
  await search.fill('notion.so');
  await expect(page.locator('[data-key="tab:3"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:2"]')).toHaveCount(0);
  await search.fill('Copenhagen');
  await expect(tree.locator('.tab-row')).toHaveCount(0);
  await expect(tree.locator('.empty-state')).toContainText('Nothing found');
  await expect(pins.locator('.pinned-tab')).toHaveCount(4);
  expect(await pins.boundingBox()).toEqual(pinsBefore);
  expect(await capsule.boundingBox()).toEqual(capsuleBefore);
  await page.keyboard.press('Escape');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(current).toHaveText('Design');
  await expect(page.locator('[data-key="tab:2"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:3"]')).toBeVisible();
  await expect(trigger).toBeFocused();
  console.log('✓ Title and URL search, repeated shortcut, and Escape restore the current folder');

  // Reverse a transition before it completes, then reopen it immediately.
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(breadcrumbs).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#search-close').click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(breadcrumbs).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await trigger.click();
  await expect(search).toBeFocused();
  await expect(page.locator('.search-toggle-track')).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('#search-wrap')).toHaveCSS('transition-duration', '0s');
  await page.screenshot({ path: 'test-results/navigation-capsule-dark-search.png' });
  await page.keyboard.press('Escape');
  await page.locator('#home').click();
  await expect(page.locator('#home')).toHaveAttribute('aria-current', 'location');
  await expect(current).toHaveCount(0);
  await page.setViewportSize({ width: 220, height: 660 });
  const longName = 'Design references and inspiration for the next website';
  await page.locator('[data-key="group:design"]').focus();
  await page.keyboard.press('F2');
  await page.getByLabel('Folder name', { exact: true }).fill(longName);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-key="group:design"]').dblclick();
  await settleNavigation();
  await expect(current).toHaveAccessibleName(longName);
  expect(
    await current
      .locator('.crumb-label')
      .evaluate((label) => label.scrollWidth > label.clientWidth),
  ).toBe(true);
  const longCrumb = await current.boundingBox();
  const searchButton = await trigger.boundingBox();
  expect(longCrumb.x + longCrumb.width).toBeLessThan(searchButton.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await page.screenshot({ path: 'test-results/navigation-capsule-narrow.png' });
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.setViewportSize({ width: 480, height: 660 });
  await page.locator('[data-key="group:design"]').dblclick();
  await expect(current).toHaveText('Design');
  const path = page.locator('#group-path');
  const pathBox = await path.boundingBox();
  const currentBox = await current.boundingBox();
  const blankX = (currentBox.x + currentBox.width + pathBox.x + pathBox.width) / 2;
  await page.mouse.click(blankX, pathBox.y + pathBox.height / 2);
  await expect(search).toBeFocused();
  await search.fill('Typography');
  await expect(page.locator('[data-key="tab:2"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:3"]')).toHaveCount(0);
  await page.locator('#search-close').click();
  await expect(search).toHaveCount(0);
  await expect(current).toHaveText('Design');
  await expect(page.locator('[data-key="tab:3"]')).toBeVisible();
  await settleNavigation();
  await current.locator('.crumb-label').click();
  await expect(search).toHaveCount(0);
  await breadcrumbs.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(current).toHaveText('Work');
  await expect(search).toHaveCount(0);
  await page.locator('#home svg').click();
  await expect(current).toHaveCount(0);
  await expect(search).toHaveCount(0);
  await capsule.click();
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await page.locator('[data-key="group:design"]').dblclick();
  await expect(current).toHaveText('Design');
  console.log(
    '✓ Empty breadcrumb space opens search; folder, Home and close buttons keep their actions',
  );

  expect(errors).toEqual([]);
  console.log('✓ Rapid reversal, reduced motion, dark mode, Home and long folder names work');
} finally {
  await close();
}
