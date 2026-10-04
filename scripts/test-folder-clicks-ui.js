import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 920 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const group = page.locator('[data-key="group:research"]');
  const child = page.locator('[data-key="tab:5"]');
  const heading = page.locator('#scope-heading');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));

  const click = async (target) => {
    const box = await target.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  const home = async () => {
    await page.evaluate(() => document.querySelector('#home').click());
    await expect(heading).toHaveCount(0);
    await expect(group).toHaveAttribute('aria-expanded', 'false');
  };

  for (const selector of ['.label', '.disclosure']) {
    const target = group.locator(selector);
    await click(target);
    await expect(group).toHaveClass(/selected/);
    await expect(group).toBeFocused();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await page.clock.runFor(119);
    await expect(child).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(child).toBeVisible();
    await click(target);
    await page.clock.runFor(120);
    await expect(group).toHaveAttribute('aria-expanded', 'false');

    // A second press within the grace period cancels the toggle even when
    // its release comes later. The folder must stay collapsed throughout.
    await click(target);
    await page.clock.runFor(60);
    await page.mouse.down({ clickCount: 2 });
    await page.clock.runFor(200);
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(child).toHaveCount(0);
    await page.mouse.up({ clickCount: 2 });
    await expect(heading).toHaveText('Research');
    await expect(child).toBeVisible();
    await page.clock.runFor(200);
    await home();
  }
  console.log(
    '✓ Folder names and icons highlight immediately, wait 120 ms, and skip fast double-click toggles',
  );

  // Slower double-clicks still enter immediately and restore the folder's
  // original collapsed state when returning Home.
  await click(group.locator('.label'));
  await page.clock.runFor(180);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(heading).toHaveText('Research');
  await home();

  await group.focus();
  await page.keyboard.press('ArrowRight');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await click(group.locator('.label'));
  await page.keyboard.press('Enter');
  await expect(heading).toHaveText('Research');
  await page.clock.runFor(200);
  await home();
  console.log(
    '✓ Slower double-clicks and keyboard navigation preserve expansion state without stray timers',
  );

  // Two separate single clicks must both work, even within the grace period.
  const later = page.locator('[data-key="group:later"]');
  await click(group.locator('.label'));
  await click(later.locator('.label'));
  await page.clock.runFor(120);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(later).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
  console.log('✓ Rapid single clicks on different folders both expand their targets');
} finally {
  await close();
}
