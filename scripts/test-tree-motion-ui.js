import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 340, height: 820 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) =>
      (await window.tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    { type, args },
  );

const finish = async () => {
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
  await expect(page.locator('[data-tree-motion]')).toHaveCount(0);
};

const calls = () => page.evaluate(() => window.motionCalls);
const reset = () =>
  page.evaluate(() => {
    window.motionCalls = [];
  });
const fold = (row) => row.dispatchEvent('keydown', { key: ' ', bubbles: true });

try {
  // Pause branch animations after they start, so assertions cover intermediate
  // states without relying on machine speed or broad timing tolerances.
  await page.addInitScript(() => {
    window.motionCalls = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      const branch = this.matches('.branch, .tab-branch');
      window.motionCalls.push({
        branch,
        key: branch
          ? this.parentElement.querySelector('.row')?.dataset.key
          : this.closest('button')?.dataset.key,
        mode: this.dataset.treeMotion,
        frames,
        duration: options.duration,
      });
      if (branch) {
        animation.pause();
        animation.currentTime = 20;
      }
      return animation;
    };
  });
  await page.goto(`${base}/extension/sidebar.html?demo`);
  const design = page.locator('[data-key="group:design"]');
  const work = page.locator('[data-key="group:work"]');
  const branch = design.locator('..').locator(':scope > .branch');
  await expect(design).toBeVisible();
  expect(await calls()).toEqual([]);

  await fold(design);
  await expect(design).toHaveAttribute('aria-expanded', 'false');
  await expect(branch).toHaveAttribute('data-tree-motion', 'unfold');
  await expect(branch).toHaveAttribute('inert', '');
  await expect(branch).toHaveAttribute('aria-hidden', 'true');
  expect((await calls()).at(-1).duration).toBe(80);
  // Acknowledging the optimistic change must not remove the paused exit.
  await expect
    .poll(async () => (await send('snapshot')).view.collapsed.includes('design'))
    .toBe(true);
  await design.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="group:research"]')).toBeFocused();

  await fold(design);
  await expect(design).toHaveAttribute('aria-expanded', 'true');
  await expect(branch).not.toHaveAttribute('inert');
  expect((await calls()).at(-1).duration).toBe(100);
  expect(await page.locator('[data-key="tab:4"]').count()).toBe(1);
  await finish();
  await expect(branch).toHaveCSS('opacity', '1');
  await expect(branch).toHaveCSS('transform', 'none');
  console.log(
    '✓ Small branches unfold; reversals preserve rows; closing content leaves keyboard navigation',
  );

  await reset();
  await fold(work);
  await expect(work).toHaveAttribute('aria-expanded', 'false');
  const large = work.locator('..').locator(':scope > .branch');
  await expect(large).toHaveAttribute('data-tree-motion', 'reveal');
  expect((await calls()).at(-1).frames.every((frame) => !('height' in frame))).toBe(true);
  await finish();
  await expect(large).toHaveCount(0);
  await fold(work);
  await expect(large).toHaveAttribute('data-tree-motion', 'reveal');
  await finish();
  console.log(
    '✓ Large branches use opacity and a tiny translation, without animating their height',
  );

  await reset();
  await page
    .locator('[data-key="tab:1"]')
    .dispatchEvent('keydown', { key: 'ArrowLeft', bubbles: true });
  await expect(page.locator('.tab-branch[data-tree-motion]')).toHaveCount(1);
  await finish();
  await page
    .locator('[data-key="tab:1"]')
    .dispatchEvent('keydown', { key: 'ArrowRight', bubbles: true });
  await expect(page.locator('.tab-branch[data-tree-motion]')).toHaveCount(1);
  await finish();

  // A background state change and both bulk directions remain immediate.
  await reset();
  await send('toggleGroup', { id: 'design' });
  await expect(design).toHaveAttribute('aria-expanded', 'false');
  expect(await calls()).toEqual([]);
  await page.locator('#tree-toggle').click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(0);
  await page.locator('#tree-toggle').click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(13);
  expect(await calls()).toEqual([]);
  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('checklist');
  await expect(page.locator('[data-key="tab:4"]')).toBeVisible();
  expect(await calls()).toEqual([]);
  await page.keyboard.press('Escape');
  console.log('✓ Nested tab folding animates; background, search and bulk expansion do not');

  // Inert content cannot keep focus when a branch closes around it.
  await page.locator('[data-key="tab:4"]').focus();
  await fold(design);
  await expect(design).toBeFocused();
  await finish();
  await fold(design);
  await expect(branch).toHaveAttribute('data-tree-motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass(/motion-off/);
  await expect(page.locator('[data-tree-motion]')).toHaveCount(0);
  await reset();
  await fold(design);
  await expect(branch).toHaveCount(0);
  await fold(design);
  await expect(branch).toBeVisible();
  await page.getByRole('button', { name: 'New tab in Design', exact: true }).click();
  expect(await calls()).toEqual([]);
  await expect(page.locator('.navigation-capsule')).toHaveCSS('transition-duration', '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).not.toHaveClass(/motion-off/);
  console.log(
    '✓ Live reduced-motion changes finish current motion and suppress new animation and + feedback',
  );

  await reset();
  await page.getByRole('button', { name: 'New tab in Design', exact: true }).click();
  expect((await calls()).some((call) => !call.branch && call.duration === 100)).toBe(true);
  await reset();
  await page.locator('#new-tab').click();
  expect((await calls()).some((call) => !call.branch && call.duration === 100)).toBe(true);

  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await popup;
  const animations = settings.getByRole('checkbox', { name: 'Show animations', exact: true });
  await expect(animations).toBeChecked();
  await animations.uncheck();
  await settings.locator('#appearance-save').click();
  await expect(page.locator('html')).toHaveClass(/motion-off/);
  await settings.reload();
  await expect(animations).not.toBeChecked();
  await reset();
  await fold(design);
  await expect(branch).toHaveCount(0);
  await fold(design);
  await expect(branch).toBeVisible();
  await page.getByRole('button', { name: 'New tab in Design', exact: true }).click();
  expect(await calls()).toEqual([]);
  await expect(page.locator('.navigation-capsule')).toHaveCSS('transition-duration', '0s');
  await animations.check();
  await settings.locator('#appearance-save').click();
  await expect(page.locator('html')).not.toHaveClass(/motion-off/);
  await fold(design);
  await expect(branch).toHaveAttribute('data-tree-motion');
  await animations.uncheck();
  await settings.locator('#appearance-save').click();
  await expect(branch).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    '✓ Inline/footer + feedback and saved settings switch work, including mid-animation disabling',
  );
} finally {
  await close();
}
