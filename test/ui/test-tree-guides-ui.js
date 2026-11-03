import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

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

const highlight = (key) =>
  row(key).evaluate((row) => {
    const style = getComputedStyle(row);
    const wrapper = row.parentElement;
    const line = getComputedStyle(wrapper, '::before');
    const bounds = wrapper.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const rtl = style.direction === 'rtl';
    const offset = parseFloat(line.insetInlineStart) + parseFloat(line.maskSize);
    const context = document.createElement('canvas').getContext('2d');
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return {
      colour: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
      gap: rtl ? bounds.right - offset - rect.right : rect.left - bounds.left - offset,
      startRadius: style.borderStartStartRadius,
      endRadius: style.borderStartEndRadius,
      icon: row.querySelector('.tab-icon').getBoundingClientRect().x,
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

    // A blue container overrides its green folder; an ordinary child uses the
    // blue parent line, while a pink child keeps its own container colour.
    await send('activateTab', { id: parent });
    await expect(row(`tab:${parent}`)).toHaveClass(/active/);
    const own = (await highlight(`tab:${parent}`)).colour;
    expect(own[2]).toBeGreaterThan(own[1]);
    await send('activateTab', { id: 2 });
    await expect(row('tab:2')).toHaveClass(/active/);
    const inherited = (await highlight('tab:2')).colour;
    expect(inherited[2]).toBeGreaterThan(inherited[1]);
    const inactiveIcon = (await highlight(`tab:${child}`)).icon;
    await send('activateTab', { id: child });
    await expect(row(`tab:${child}`)).toHaveClass(/active/);
    const attached = await highlight(`tab:${child}`);
    expect(attached.colour[0]).toBeGreaterThan(attached.colour[2]);
    expect(attached.colour[2]).toBeGreaterThan(attached.colour[1]);
    expect(Math.abs(attached.gap)).toBeLessThan(0.02);
    expect(attached.startRadius).toBe('0px');
    expect(attached.endRadius).toBe('6px');
    expect(attached.icon).toBe(inactiveIcon);
    expect((await rail(`tab:${parent}`)).color).toBe(parentRail.color);
    await page.screenshot({ path: `test-results/tree-guides-${theme}.png` });
  }

  await page.setViewportSize({ width: 220, height: 960 });
  for (const sidebarSize of ['default', 'comfortable', 'large']) {
    for (const domains of [false, true]) {
      await send('setLook', { partial: true, value: { sidebarSize, domains } });
      await expect(page.locator('#tree')).toHaveClass(
        domains ? /show-domains/ : /^(?!.*show-domains)/,
      );
      for (const dir of ['ltr', 'rtl']) {
        await page.evaluate((dir) => (document.documentElement.dir = dir), dir);
        expect(Math.abs((await highlight(`tab:${child}`)).gap)).toBeLessThan(0.02);
      }
    }
  }
  await page.evaluate(() => (document.documentElement.dir = 'ltr'));
  await page.setViewportSize({ width: 340, height: 960 });
  await send('setLook', { partial: true, value: { sidebarSize: 'default', domains: false } });

  const before = await rail(`tab:${parent}`);
  await send('activateTab', { id: parent });
  await expect(row(`tab:${parent}`)).toHaveClass(/active/);
  const beforeHighlight = (await highlight(`tab:${parent}`)).colour;
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
  await expect
    .poll(async () => (await highlight(`tab:${parent}`)).colour)
    .not.toEqual(beforeHighlight);
  const orange = (await highlight(`tab:${parent}`)).colour;
  expect(orange[0]).toBeGreaterThan(orange[1]);
  expect(orange[1]).toBeGreaterThan(orange[2]);

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
  // Reopening without a container removes the old orange tint and uses the
  // containing green folder instead, including when a row is reused.
  await send('activateTab', { id: parent });
  await expect(row(`tab:${parent}`)).toHaveClass(/active/);
  const fallback = (await highlight(`tab:${parent}`)).colour;
  expect(fallback[1]).toBeGreaterThan(fallback[0]);
  expect(fallback[1]).toBeGreaterThan(fallback[2]);

  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await Promise.all(
    ['group:work', `group:${fourth}`, `tab:${parent}`, `tab:${child}`].map(rail),
  );
  expect(new Set(forced.map((r) => r.color)).size).toBe(1);
  for (const result of forced) expect(new Set(result.segments)).toEqual(new Set([result.color]));
  expect(new Set((await highlight(`tab:${parent}`)).colour).size).toBe(1);
  await send('setLook', { partial: true, value: { connectingLines: false } });
  await expect
    .poll(() =>
      row(`tab:${parent}`).evaluate(
        (r) => getComputedStyle(r.parentElement.querySelector('.tab-branch'), '::before').content,
      ),
    )
    .toBe('none');
  expect((await highlight(`tab:${parent}`)).startRadius).toBe('6px');
  expect(errors).toEqual([]);
  console.log(
    '✓ Guide ownership and fading; flush active highlights with container precedence, live edits, all sizes, RTL and forced colours',
  );
} finally {
  await close();
}
