import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 360, height: 800 } });
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) => {
      const session = await window.tabernacleDemoSession.ready;
      return session.request({ type, windowId: 1, ...args });
    },
    { type, args },
  );

const expectFolderColours = async (id, rawColor) => {
  const expected = await page.evaluate(async (color) => {
    const { appearanceColor } = await import('/extension/src/appearance-colors.js');
    const probe = document.createElement('span');
    probe.style.color = appearanceColor(color, true) || 'var(--folder-icon)';
    document.body.append(probe);
    const shade = getComputedStyle(probe).color;
    probe.remove();
    return shade;
  }, rawColor);
  const folder = page.locator(`[data-key="group:${id}"]`);
  await expect(folder.locator('.folder-glyph')).toHaveCSS('color', expected);
  const colours = await folder.evaluate((row) => {
    const branch = row.parentElement.querySelector(':scope > .branch');
    return {
      label: getComputedStyle(row.querySelector('.label')).color,
      text: getComputedStyle(row).color,
      rails: [...branch.children].map(
        (child) => getComputedStyle(child, '::before').backgroundColor,
      ),
      plus: getComputedStyle(branch.querySelector(':scope > .new-tab-item > button')).color,
    };
  });
  expect(colours.label).toBe(colours.text);
  expect(colours.plus).toBe(expected);
  expect(new Set(colours.rails)).toEqual(new Set([expected]));
  return expected;
};

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();
  await send('setGroupContainer', { id: 'work', cookieStoreId: 'firefox-container-1' });
  const state = await send('reopenInContainer', { id: 1, cookieStoreId: 'firefox-container-2' });
  const parent = state.tabs.find((tab) => tab.title === 'Figma — Website');
  const row = page.locator(`[data-key="tab:${parent.id}"]`);
  const active = page.locator('[data-key="tab:2"]');
  const folder = page.locator('[data-key="group:design"]');
  const total = '4';
  await expect(folder.locator('.group-count')).toHaveText(total);
  await expect(folder.locator('.group-count')).toHaveAttribute('aria-hidden', 'true');
  await expect(folder).toHaveAccessibleName(new RegExp(`${total} tabs`));
  await send('activateTab', { id: 2 });

  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode });
    await send('setGroupAppearance', { id: 'work', appearance: {} });
    await send('setGroupAppearance', { id: 'design', appearance: {} });
    await send('setGroupContainer', { id: 'work', cookieStoreId: 'firefox-container-1' });
    const blue = await expectFolderColours('work', '#00a7e0');
    expect(await expectFolderColours('design', '#00a7e0')).toBe(blue);
    await expect(page.locator('.container-indicator')).toHaveCount(0);
    await expect(row).toHaveAccessibleName(new RegExp(`container: ${parent.container.name}`));
    await expect(active).toHaveCSS('box-shadow', 'none');
    const activeBackground = await active.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );

    await send('setGroupAppearance', {
      id: 'work',
      appearance: { color: 'green', icon: 'settings' },
    });
    const green = await expectFolderColours('work', '#45994d');
    expect(green).not.toBe(blue);
    expect(await expectFolderColours('design', '#45994d')).toBe(green);
    await send('setGroupAppearance', { id: 'design', appearance: { color: 'purple' } });
    expect(await expectFolderColours('design', '#a16bd4')).not.toBe(green);
    // Every parent segment stays green, including the segment alongside a purple child.
    expect(await expectFolderColours('work', '#45994d')).toBe(green);
    await expect(active).toHaveCSS('background-color', activeBackground);

    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(folder.locator('.group-count')).toHaveText(total);
    await expect(folder).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await folder.locator('.label').hover();
    await expect(folder).toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Tab');
    await folder.focus();
    await expect(folder).toHaveCSS('outline-width', '2px');
    await folder.evaluate((node) => node.blur());

    for (const target of [row, page.locator('[data-key="tab:8"]')]) {
      const before = await target.locator('.tab-icon').boundingBox();
      await target.hover();
      await expect(target).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(target).toHaveCSS('box-shadow', 'none');
      expect(await target.locator('.tab-icon').boundingBox()).toEqual(before);
      await expect(active).toHaveCSS('background-color', activeBackground);
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `test-results/ink-and-rails-${mode}.png` });

    await send('setGroupAppearance', { id: 'design', appearance: {} });
    expect(await expectFolderColours('design', '#45994d')).toBe(green);
    await send('setGroupAppearance', { id: 'work', appearance: {} });
    expect(await expectFolderColours('design', '#00a7e0')).toBe(blue);
    await send('setGroupContainer', { id: 'work', cookieStoreId: null });
    const neutral = await expectFolderColours('work');
    expect(await expectFolderColours('design')).toBe(neutral);
  }

  // Counts refresh after the retained inline plus creates a tab.
  await page.getByRole('button', { name: 'New tab in Design', exact: true }).click();
  await expect(folder.locator('.group-count')).toHaveText('5');
  await expect(page.locator('[data-key="group:work"] .group-count')).toHaveText('10');
  await page.locator('.tab-row.active .close-tab').click();
  await expect(folder.locator('.group-count')).toHaveText(total);
  await expect(page.locator('[data-key="group:work"] .group-count')).toHaveText('9');
  await send('activateTab', { id: 2 });

  // Ungrouped tabs stay directly below folders, without a section heading.
  await page.locator('#new-tab').click();
  await expect(page.locator('#tree > .tab-node > .row')).toHaveCount(1);
  await expect(page.locator('.root-tabs-label')).toHaveCount(0);
  await folder.dblclick();
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await expect(page.locator('.root-tabs-label')).toHaveCount(0);
  await page.locator('#home').click();
  await expect(page.locator('.root-tabs-label')).toHaveCount(0);
  await page.locator('#tree > .tab-node > .row .close-tab').click();
  await expect(page.locator('.root-tabs-label')).toHaveCount(0);

  // Narrow and RTL rails stay outside the tab's selection surface.
  await page.setViewportSize({ width: 220, height: 800 });
  for (const dir of ['ltr', 'rtl']) {
    await page.evaluate((dir) => (document.documentElement.dir = dir), dir);
    expect(
      await active.evaluate((node) => {
        const wrapper = node.parentElement;
        const mark = getComputedStyle(wrapper, '::before');
        const offset = parseFloat(mark.insetInlineStart);
        return offset + parseFloat(mark.width) <= 0;
      }),
    ).toBe(true);
    expect(
      await page.locator('#tree').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(active).toHaveCSS('box-shadow', 'none');
  }
  await send('setLook', { partial: true, value: { connectingLines: false } });
  await expect
    .poll(() => active.evaluate((node) => getComputedStyle(node.parentElement, '::before').content))
    .toBe('none');
  await expect(page.locator('.container-indicator')).toHaveCount(0);
  await send('pinTab', { id: parent.id });
  const pin = page.locator(`.pinned-tab[data-key="tab:${parent.id}"]`);
  await expect(pin).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  const background = await pin.evaluate((node) => getComputedStyle(node).backgroundColor);
  await send('activateTab', { id: parent.id });
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).not.toHaveCSS('background-color', background);
  await expect(pin).toHaveCSS('box-shadow', 'none');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(folder.locator('.label')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(pin).toHaveCSS('outline-width', '2px');
  console.log(
    '✓ Neutral labels and tabs, matching folder icons and continuous rails, inherited/custom colours, totals, RTL, narrow and high-contrast views',
  );
} finally {
  await close();
}
