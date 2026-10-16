import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 340, height: 960 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) =>
      (await window.tabernacleDemoSession.ready).request({ type, windowId: 1, ...args }),
    { type, args },
  );
const row = (key) => page.locator(`[data-key="${key}"]`);

const rail = (key) =>
  row(key).evaluate((row) => {
    const branch = row.parentElement.querySelector(':scope > :is(.branch,.tab-branch)');
    const stem = getComputedStyle(branch, '::before');
    return {
      color: stem.backgroundColor,
      width: parseFloat(stem.maskSize),
      segments: [...branch.children].map(
        (child) => getComputedStyle(child, '::before').backgroundColor,
      ),
      mask: getComputedStyle(branch.lastElementChild, '::before').maskImage,
    };
  });

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row('tab:1')).toBeVisible();
  await send('setGroupAppearance', { id: 'work', appearance: { color: 'green' } });
  const { createdGroupId: third } = await send('createGroup', {
    parentId: 'design',
    name: 'Third depth',
  });
  const { createdGroupId: fourth } = await send('createGroup', {
    parentId: third,
    name: 'Fourth depth',
  });
  let state = await send('reopenInContainer', { id: 1, cookieStoreId: 'firefox-container-1' });
  let parent = state.tabs.find((tab) => tab.title === 'Figma — Website').id;
  state = await send('reopenInContainer', { id: 3, cookieStoreId: 'firefox-container-4' });
  const child = state.tabs.find((tab) => tab.title === 'Brand guidelines').id;
  await expect(row(`tab:${parent}`)).toBeVisible();
  await expect(row(`tab:${child}`)).toBeVisible();

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    const levels = await Promise.all(
      ['work', 'design', third, fourth].map((id) => rail(`group:${id}`)),
    );
    expect(new Set(levels.slice(0, 3).map((r) => r.color)).size).toBe(3);
    expect(levels[2].color).toBe(levels[3].color);
    for (const result of levels) {
      expect(result.width).toBe(1.5);
      expect(new Set(result.segments)).toEqual(new Set([result.color]));
      expect(result.mask).toContain('tree-guide-end.svg');
    }
    const parentRail = await rail(`tab:${parent}`);
    const childRail = await rail(`tab:${child}`);
    expect(parentRail.color).not.toBe(childRail.color);
    const [r, g, b] = parentRail.color.match(/\d+/g).map(Number);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(new Set(parentRail.segments)).toEqual(new Set([parentRail.color]));
    await page.screenshot({ path: `test-results/tree-guides-${theme}.png` });
  }

  const before = await rail(`tab:${parent}`);
  await send('updateContainer', {
    cookieStoreId: 'firefox-container-1',
    name: 'Personal',
    color: 'orange',
    icon: 'briefcase',
  });
  await expect.poll(async () => (await rail(`tab:${parent}`)).color).not.toBe(before.color);
  const updated = await rail(`tab:${parent}`);
  const [r, g, b] = updated.color.match(/\d+/g).map(Number);
  expect(r).toBeGreaterThan(g);
  expect(g).toBeGreaterThan(b);

  // The visible depth resets after focusing a folder; moving it back restores it.
  const rootColour = (await rail('group:work')).color;
  await send('enterGroup', { id: 'design' });
  await expect.poll(async () => (await rail(`group:${third}`)).color).toBe(rootColour);
  await send('enterGroup', { id: null });
  await send('moveGroup', { id: fourth, parentId: null });
  await send('setGroupAppearance', { id: fourth, appearance: { color: 'green' } });
  await expect.poll(async () => (await rail(`group:${fourth}`)).color).toBe(rootColour);
  await send('moveGroup', { id: fourth, parentId: third });
  await expect
    .poll(async () => (await rail(`group:${fourth}`)).color)
    .toBe((await rail(`group:${third}`)).color);

  state = await send('reopenInContainer', { id: parent, cookieStoreId: 'firefox-default' });
  parent = state.tabs.find((tab) => tab.title === 'Figma — Website').id;
  await expect(row(`tab:${parent}`)).toBeVisible();
  const neutral = (await rail(`tab:${parent}`)).color.match(/\d+/g).map(Number);
  expect(new Set(neutral).size).toBe(1);

  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await Promise.all(
    ['group:work', `group:${fourth}`, `tab:${parent}`, `tab:${child}`].map(rail),
  );
  expect(new Set(forced.map((r) => r.color)).size).toBe(1);
  for (const result of forced) expect(new Set(result.segments)).toEqual(new Set([result.color]));
  await send('setLook', { partial: true, value: { connectingLines: false } });
  await expect
    .poll(() =>
      row(`tab:${parent}`).evaluate(
        (r) => getComputedStyle(r.parentElement.querySelector('.tab-branch'), '::before').content,
      ),
    )
    .toBe('none');
  expect(errors).toEqual([]);
  console.log(
    '✓ Three-level guide fade, parent-tab colour ownership, live container edits, scope/move changes and forced colours',
  );
} finally {
  await close();
}
