import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const toggle = page.locator('#tree-toggle');
  const work = page.locator('[data-key="group:work"]');
  const design = page.locator('[data-key="group:design"]');
  const parent = page.locator('[data-key="tab:1"]');
  const pins = page.locator('.pinned-tab');

  await expect(toggle).toHaveAccessibleName('Collapse all in Home');
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Expand all in Home');
  await expect(page.locator('#tree .group-row')).toHaveCount(3);
  await expect(page.locator('#tree .tab-row')).toHaveCount(0);
  await expect(pins).toHaveCount(4);
  await expect(page.locator('#reveal')).toBeVisible();
  await page.screenshot({ path: 'test-results/tree-collapsed.png' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tree .tab-row')).toHaveCount(13);
  await expect(page.locator('#tree [aria-expanded="false"]')).toHaveCount(0);
  await expect(toggle).toHaveAccessibleName('Collapse all in Home');
  await expect(toggle).toBeFocused();
  console.log('✓ Home toggle folds groups and tab trees, preserves pins and expands every depth');

  // Folding all through the old group-only menu leaves hidden tab branches open.
  await page.locator('#more').click();
  await page.getByRole('menuitem', { name: 'Collapse all groups', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Expand all in Home');
  await work.getByRole('button', { name: 'Expand Work', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Collapse all in Home');
  await work.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go into group', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Expand all in Work');
  await toggle.click();
  await expect(design).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(design).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#home').click();
  await expect(work).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-key="group:personal"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  console.log(
    '✓ Mixed states choose collapse; focused changes preserve the enclosing and unrelated groups',
  );

  await design.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go into group', exact: true }).click();
  await expect(toggle).toHaveAccessibleName('Expand all in Design');
  await toggle.click();
  await expect(page.locator('.tab-row')).toHaveCount(4);
  await parent.getByRole('button', { name: 'Collapse child tabs of Figma — Website' }).click();
  await expect(toggle).toHaveAccessibleName('Expand all in Design');
  await toggle.click();
  await expect(page.locator('.tab-row')).toHaveCount(4);
  console.log(
    '✓ A group with only nested tabs can fold, and hidden open descendants do not confuse the toggle',
  );

  await toggle.click();
  await page.keyboard.press('Control+k');
  // Opening an empty search does not disable the button.
  await expect(toggle).toBeEnabled();
  await page.getByRole('searchbox').fill('checklist');
  await expect(page.locator('[data-key="tab:4"]')).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute(
    'title',
    'Clear search to expand or collapse groups and tabs',
  );
  await page.keyboard.press('Escape');
  await expect(toggle).toBeEnabled();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-key="tab:4"]')).toHaveCount(0);
  console.log('✓ Search temporarily disables folding and preserves the saved tree when cleared');

  await page.locator('#home').click();
  await page.locator('[data-key="group:later"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go into group', exact: true }).click();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('title', 'Nothing to expand or collapse here');
  await page.locator('#home').click();
  await expect(toggle).toBeEnabled();
  for (const viewport of [
    { width: 220, height: 360 },
    { width: 320, height: 820 },
  ]) {
    await page.setViewportSize(viewport);
    const dock = await page.locator('.footer-actions').boundingBox();
    const buttons = await page.locator('.footer-actions > button').all();
    let right = dock.x;
    for (const button of buttons) {
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(right);
      expect(box.x + box.width).toBeLessThanOrEqual(dock.x + dock.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      right = box.x + box.width;
    }
    expect(dock.x + dock.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `test-results/tree-toggle-${viewport.width}.png` });
  }
  console.log('✓ Flat views disable folding and footer controls fit a 220px sidebar');
  expect(errors).toEqual([]);
} finally {
  await close();
}
