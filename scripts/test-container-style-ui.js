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

const folderColours = (id) =>
  page.locator(`[data-key="group:${id}"]`).evaluate((row) => {
    const branch = row.parentElement.querySelector(':scope > .branch');
    return {
      icon: getComputedStyle(row.querySelector('.folder-glyph')).color,
      label: getComputedStyle(row.querySelector('.label')).color,
      rail: getComputedStyle(branch.firstElementChild, '::before').backgroundColor,
      plus: getComputedStyle(branch.querySelector(':scope > .new-tab-item > button')).color,
      plusMarker: getComputedStyle(branch.lastElementChild, '::before').backgroundColor,
    };
  });

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
  await expect(page.locator(`[data-key="group:${id}"] .folder-glyph`)).toHaveCSS('color', expected);
  const colours = await folderColours(id);
  for (const key of ['rail', 'plus', 'plusMarker', ...(rawColor ? ['label'] : [])])
    expect(colours[key], `${id}: ${key} matches its icon`).toBe(colours.icon);
  return colours.icon;
};

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();
  await send('setGroupContainer', { id: 'work', cookieStoreId: 'firefox-container-1' });
  const state = await send('reopenInContainer', { id: 1, cookieStoreId: 'firefox-container-2' });
  const parent = state.tabs.find((tab) => tab.title === 'Figma — Website');
  const leafState = await send('reopenInContainer', {
    id: 4,
    cookieStoreId: 'firefox-container-3',
  });
  const leafId = leafState.tabs.find((tab) => tab.title === 'Launch checklist').id;
  const leaf = page.locator(`[data-key="tab:${leafId}"]`);
  await send('activateTab', { id: 2 });
  const row = page.locator(`[data-key="tab:${parent.id}"]`);
  const add = page.locator(`[data-key="new-child-tab:${parent.id}"]`);
  const folder = page.locator('[data-key="group:design"]');

  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode });
    await send('setGroupAppearance', { id: 'work', appearance: {} });
    await send('setGroupAppearance', { id: 'design', appearance: {} });
    await send('setGroupContainer', { id: 'work', cookieStoreId: 'firefox-container-1' });
    await expectFolderColours('work', '#00a7e0');
    await expectFolderColours('design', '#00a7e0');
    await expect(row.locator('.container-indicator')).toBeVisible();
    await expect(row.locator('.tab-icon .container-indicator')).toHaveCount(0);
    const [rail, indicator, plus] = await row.evaluate((row) => [
      getComputedStyle(row.parentElement, '::before').backgroundColor,
      getComputedStyle(row.querySelector('.container-indicator')).backgroundColor,
      getComputedStyle(document.querySelector(`[data-key="new-child-tab:${row.dataset.id}"]`))
        .color,
    ]);
    expect(indicator).not.toBe(rail);
    expect(plus).toBe(rail); // The folder's appearance wins over the parent tab.
    expect(await expectFolderColours('design', '#00a7e0')).toBe(rail);
    await expect(add.locator('svg')).toHaveCSS('stroke-width', '0.65px');
    const active = page.locator('[data-key="tab:2"]');
    const bounds = await active.evaluate((row) => ({
      row: row.getBoundingClientRect().left,
      wrapper: row.parentElement.getBoundingClientRect().left,
      shadow: getComputedStyle(row).boxShadow,
    }));
    expect(bounds.row - bounds.wrapper).toBe(6);
    expect(bounds.shadow).toContain('inset');
    await send('setGroupAppearance', {
      id: 'work',
      appearance: { color: 'green', icon: 'settings' },
    });
    const green = await expectFolderColours('work', '#45994d');
    expect(green).not.toBe(rail);
    expect(await expectFolderColours('design', '#45994d')).toBe(green);
    await expect(add).toHaveCSS('color', green);
    await expect(row.locator('.container-indicator')).toHaveCSS('background-color', indicator);
    // Both mouse selection and hover leave the folder surface clear.
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(folder).toHaveClass(/selected/);
    await expect(folder).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(folder).toHaveCSS('box-shadow', 'none');
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await folder.locator('.label').hover();
    await expect(folder).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.keyboard.press('Tab');
    await folder.focus();
    await expect(folder).toHaveCSS('outline-style', 'solid');
    await expect(folder).toHaveCSS('outline-width', '2px');
    await folder.evaluate((node) => node.blur());
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `test-results/container-style-${mode}.png` });

    // Hover retains the existing neutral fill and shows the tab's own colour,
    // both beside a continuous parent guide and on a segmented leaf row.
    const activeBackground = await active.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    for (const target of [row, leaf]) {
      const before = await target.locator('.tab-icon').boundingBox();
      const { colour, background } = await target.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.background = 'var(--hover)';
        node.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          colour: getComputedStyle(node.querySelector('.container-indicator')).backgroundColor,
          background,
        };
      });
      await target.hover();
      await expect(target).toHaveCSS('background-color', background);
      await expect(target).toHaveCSS('box-shadow', `${colour} 3px 0px 0px 0px inset`);
      await expect(target.locator('.container-indicator')).toBeVisible();
      await expect(target.locator('.container-indicator')).toHaveCSS('background-color', colour);
      expect(await target.locator('.tab-icon').boundingBox()).toEqual(before);
      await expect(active).toHaveCSS('background-color', activeBackground);
    }
    await page.screenshot({ path: `test-results/container-hover-${mode}.png` });
    await page.mouse.move(0, 0);
    await expect(leaf).toHaveCSS('box-shadow', 'none');
    for (const id of [3, 8]) {
      const uncontained = page.locator(`[data-key="tab:${id}"]`);
      await expect(uncontained.locator('.container-indicator')).toHaveCount(0);
      const before = await uncontained.locator('.tab-icon').boundingBox();
      await uncontained.hover();
      await expect(uncontained).toHaveCSS('box-shadow', 'none');
      await expect(uncontained).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect(await uncontained.locator('.tab-icon').boundingBox()).toEqual(before);
    }
    await page.screenshot({ path: `test-results/no-container-hover-${mode}.png` });
    await page.mouse.move(0, 0);

    await send('setGroupAppearance', { id: 'design', appearance: { color: 'purple' } });
    expect(await expectFolderColours('design', '#a16bd4')).not.toBe(green);
    expect(await expectFolderColours('work', '#45994d')).toBe(green);
    await send('setGroupAppearance', { id: 'design', appearance: {} });
    expect(await expectFolderColours('design', '#45994d')).toBe(green);
    await send('setGroupAppearance', { id: 'work', appearance: {} });
    expect(await expectFolderColours('design', '#00a7e0')).toBe(rail);
    // Removing the container returns both folders' guides to the default icon shade.
    await send('setGroupContainer', { id: 'work', cookieStoreId: null });
    const neutral = await expectFolderColours('work');
    expect(await expectFolderColours('design')).toBe(neutral);
    await expect(add).toHaveCSS('color', indicator);
  }
  await send('setLook', { partial: true, value: { connectingLines: false } });
  await expect(row.locator('.container-indicator')).toBeVisible();
  await page.evaluate(() => (document.documentElement.dir = 'rtl'));
  await expect(page.locator('[data-key="tab:2"]')).toHaveCSS('box-shadow', /-3px/);
  await leaf.hover();
  await expect(leaf).toHaveCSS('box-shadow', /-3px/);
  await expect(leaf.locator('.container-indicator')).toBeVisible();
  const uncontained = page.locator('[data-key="tab:8"]');
  await uncontained.hover();
  await expect(uncontained).toHaveCSS('box-shadow', 'none');
  await page.mouse.move(0, 0);
  await send('pinTab', { id: parent.id });
  const pin = page.locator(`.pinned-tab[data-key="tab:${parent.id}"]`);
  const background = await pin.evaluate((node) => getComputedStyle(node).backgroundColor);
  await send('activateTab', { id: parent.id });
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).not.toHaveCSS('background-color', background);
  await expect(pin).toHaveCSS('box-shadow', /inset/);
  await expect(pin.locator('.container-indicator')).toHaveCount(0);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(folder.locator('.label')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await leaf.hover();
  await expect(leaf.locator('.container-indicator')).toBeVisible();
  console.log(
    '✓ Folder colours and clear surfaces; hover indicators appear only for container tabs, preserving the highlight fill and alignment in light/dark, RTL and high contrast',
  );
} finally {
  await close();
}
