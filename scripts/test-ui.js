import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 820 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let checks = 0;

const check = (message) => {
  checks++;
  console.log(`✓ ${message}`);
};

try {
  // Capture writes in memory so these checks never inspect or replace the user's clipboard.
  await page.addInitScript(() => {
    window.clipboardTest = { writes: [], fail: false };
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          if (window.clipboardTest.fail) throw new Error('Clipboard denied');
          window.clipboardTest.writes.push(text);
        },
      },
    });
  });
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/sidebar-overview.png' });
  check('Finder overview shows expanded nested groups and tabs at Home');

  for (const viewport of [
    { width: 220, height: 360 },
    { width: 320, height: 820 },
  ]) {
    await page.setViewportSize(viewport);
    const dock = await page.locator('.footer-actions').boundingBox();
    expect(dock.x).toBeGreaterThanOrEqual(0);
    expect(dock.x + dock.width).toBeLessThanOrEqual(viewport.width);
    expect(dock.y + dock.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Control+k');
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'true');
    const search = await page.locator('#search-wrap').boundingBox();
    expect(search.y).toBeGreaterThanOrEqual(0);
    expect(search.y + search.height).toBeLessThan(dock.y);
    expect(await page.locator('.footer-actions').boundingBox()).toEqual(dock);
    if (viewport.width === 320)
      await page.screenshot({ path: 'test-results/navigation-capsule-search-home.png' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-toggle')).toBeFocused();
    await page.locator('#more').click();
    await expect(page.locator('#more')).toHaveAttribute('aria-expanded', 'true');
    const menu = await page.locator('#menu').boundingBox();
    expect(menu.y).toBeGreaterThanOrEqual(8);
    expect(menu.y + menu.height).toBeLessThan(dock.y);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
    if (viewport.width === 320)
      await page.screenshot({ path: 'test-results/floating-dock-menu.png' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#more')).toBeFocused();
    await expect(page.locator('#more')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#more').click();
    await page.locator('#more').click();
    await expect(page.locator('#menu')).toBeHidden();
  }
  check('Header search and footer menus fit narrow and short sidebars without moving the dock');

  const inlineActions = page.locator('#tree .new-tab-action');
  const homeAdd = page.locator('#tree > .new-tab-item .new-tab-action');
  const designAdd = page.getByRole('button', { name: 'New tab in Design', exact: true });
  await expect(inlineActions).toHaveText(['', '', '', '', '']);
  await expect(homeAdd).toHaveAccessibleName('New tab');
  await designAdd.click();
  await expect(page.locator('.tab-row')).toHaveCount(7);
  const inlineTab = page.locator('.tab-row.active');
  await expect(inlineTab.locator('.label')).toHaveText('New tab');
  await expect(inlineTab.locator('../../..').locator(':scope > .group-row')).toHaveAttribute(
    'data-key',
    'group:design',
  );
  expect(
    await designAdd.evaluate((button) =>
      button.parentElement.previousElementSibling
        ?.querySelector('.tab-row')
        ?.classList.contains('active'),
    ),
  ).toBe(true);
  await expect(designAdd).toBeVisible();
  await expect(page.locator('#scope-heading')).toBeHidden();
  await designAdd.focus();
  await page.keyboard.press('ArrowUp');
  await expect(inlineTab).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(designAdd).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-key="group:design"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(homeAdd).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.tab-row')).toHaveCount(8);
  await expect(inlineTab.locator('../..')).toHaveAttribute('id', 'tree');
  await expect(homeAdd).toBeFocused();
  await page.locator('[data-key="group:design"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go into folder', exact: true }).click();
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await expect(inlineActions).toHaveText(['', '', '']);
  await designAdd.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await expect(inlineTab.locator('../..')).toHaveAttribute('id', 'tree');
  await expect(designAdd).toBeVisible();
  check('Quiet actions append to Home or the named folder and remain available by keyboard');

  for (const { selector, scope, destination } of [
    { selector: '#tree > .new-tab-item .new-tab-action', scope: null, destination: 'Home' },
    { selector: '[data-key="new-tab:design"]', scope: null, destination: 'Design' },
    { selector: '#new-tab', scope: 'design', destination: 'Design' },
  ]) {
    await page.goto(`${base}/extension/sidebar.html?demo`);
    if (scope) await page.locator(`[data-key="group:${scope}"]`).dblclick();
    const trigger = page.locator(selector);
    const target =
      destination === 'Home' || scope
        ? page.locator('#tree')
        : page.locator('[data-key="group:design"] + .branch');
    await expect(trigger).toBeVisible();
    const count = await page.locator('.tab-row').count();
    await trigger.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['New tab', 'New folder…']);
    await expect(page.locator('.tab-row')).toHaveCount(count);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'New tab', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.tab-row')).toHaveCount(count + 1);
    await expect(target.locator(':scope > .tab-node > .tab-row.active .label')).toHaveText(
      'New tab',
    );
    await trigger.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
    await expect(page.getByLabel('Create in', { exact: true })).toHaveText(
      destination === 'Home' ? 'Home' : `Home / Work / ${destination}`,
    );
    await page.getByLabel('Folder name', { exact: true }).fill('From the plus menu');
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(target.locator(':scope > .group-node > .group-row > .label')).toContainText([
      'From the plus menu',
    ]);
    await trigger.focus();
    await trigger.press('ContextMenu');
    await expect(page.getByRole('menuitem')).toHaveText(['New tab', 'New folder…']);
    await page.screenshot({ path: `test-results/new-tab-menu-${scope || destination}.png` });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  check('Plus menus create tabs and groups in Home, nested folders and the current footer scope');
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.tab-row')).toHaveCount(6);

  const copied = () => page.evaluate(() => window.clipboardTest.writes.at(-1));
  await page.locator('[data-key="tab:1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  expect(await copied()).toBe('https://figma.com/design/tabernacle');
  await expect(page.locator('#toast')).toHaveText('URL copied.');
  await page.locator('.pinned-tab').first().focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Copy URL', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await copied()).toBe('https://visitcopenhagen.com');
  check('Copy URL copies just the selected page, including keyboard access on pinned tabs');
  await page.locator('[data-key="group:work"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URLs', exact: true }).click();
  expect(await copied()).toBe(
    [
      'https://figma.com/design/tabernacle',
      'https://fonts.google.com',
      'https://notion.so/brand',
      'https://docs.google.com',
      'https://developer.mozilla.org',
      'https://support.apple.com',
      'https://developer.mozilla.org',
      'https://linear.app',
      'https://notion.so',
    ].join('\n'),
  );
  await expect(page.locator('#toast')).toHaveText('9 URLs copied.');
  await page.locator('[data-key="group:personal"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URLs', exact: true }).click();
  expect(await copied()).toBe(
    ['https://visitcopenhagen.com', 'https://bbcgoodfood.com', 'https://openlibrary.org'].join(
      '\n',
    ),
  );
  check('Copy URLs includes collapsed subgroups, duplicate URLs and assigned pins, one per line');
  await page.evaluate(() => {
    window.clipboardTest.fail = true;
  });
  await page.locator('[data-key="tab:1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Could not copy to the clipboard');
  expect(await page.evaluate(() => window.clipboardTest.writes.length)).toBe(4);
  await page.evaluate(() => {
    window.clipboardTest.fail = false;
  });
  check('Clipboard failures show an error without reporting success');
  await page.locator('#more').click();
  await expect(
    page.getByRole('menuitem', { name: 'Import Firefox groups', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^(Compact|Comfortable) rows$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  check('Options menu no longer offers Firefox group import or row density');
  const design = page.locator('[data-key="group:design"]');
  await design.locator('.label').click();
  await expect(design).toHaveAttribute('aria-expanded', 'false');
  await expect(designAdd).toHaveCount(0);
  await expect(design).toBeFocused();
  await expect(page.locator('[data-key="tab:1"]')).toBeHidden();
  await expect(page.locator('#scope-heading')).toBeHidden();
  await design.locator('.group').click();
  await expect(design).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-key="tab:1"]')).toBeVisible();
  await expect(page.locator('#scope-heading')).toBeHidden();
  check('Single-clicking a group name or icon toggles expansion without changing scope');
  await design.dblclick({ delay: 100 });
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await expect(page.locator('.tab-row')).toHaveCount(4);
  await expect(page.locator('#breadcrumbs .crumb')).toHaveText(['', 'Work', 'Design']);
  await page.screenshot({ path: 'test-results/sidebar-focused.png' });
  check('Double-click enters a group and removes unrelated tabs from the list');
  await page.locator('#breadcrumbs').getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.locator('#scope-heading')).toHaveText('Work');
  await page.locator('#breadcrumbs').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('#scope-heading')).toBeHidden();
  check('Clickable Home and group breadcrumbs navigate the hierarchy');
  await page.getByRole('button', { name: 'Collapse Design', exact: true }).click();
  await expect(page.locator('[data-key="tab:1"]')).toBeHidden();
  await page.getByRole('button', { name: 'Expand Design', exact: true }).click();
  await expect(page.locator('[data-key="tab:1"]')).toBeVisible();
  check('Folder icon controls expand and collapse without changing scope');
  const pinnedNames = await page
    .locator('.pinned-tab')
    .evaluateAll((pins) => pins.map((pin) => pin.getAttribute('aria-label')));
  await page.getByRole('button', { name: 'Search tabs and folders', exact: true }).click();
  await page.getByRole('searchbox').fill('Copenhagen');
  await expect(inlineActions).toHaveCount(0);
  await expect(page.locator('.tab-row')).toHaveCount(0);
  await expect(page.locator('.pinned-tab')).toHaveCount(pinnedNames.length);
  await expect(page.locator('.empty-state')).toContainText('Nothing found');
  expect(
    await page
      .locator('.pinned-tab')
      .evaluateAll((pins) => pins.map((pin) => pin.getAttribute('aria-label'))),
  ).toEqual(pinnedNames);
  await page.getByRole('searchbox').fill('no matching tabs');
  await expect(page.locator('.empty-state')).toContainText('Nothing found');
  await expect(page.locator('.pinned-tab')).toHaveCount(pinnedNames.length);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pinned-tab')).toHaveCount(pinnedNames.length);
  check('Home search leaves every pinned tab visible and excludes pins from search results');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Project Z');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  let project = page
    .locator('.group-row')
    .filter({ has: page.locator('.label', { hasText: 'Project Z' }) });
  await expect(project).toBeVisible();
  const copyCount = await page.evaluate(() => window.clipboardTest.writes.length);
  await project.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URLs', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('No URLs to copy in this folder.');
  expect(await page.evaluate(() => window.clipboardTest.writes.length)).toBe(copyCount);
  check('Copying an empty group leaves the clipboard unchanged');
  await project.focus();
  await page.keyboard.press('F2');
  await page.getByLabel('Folder name', { exact: true }).fill('Project Zero');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  project = page
    .locator('.group-row')
    .filter({ has: page.locator('.label', { hasText: 'Project Zero' }) });
  await expect(project).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New tab in Project Zero', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New tab in Project Z', exact: true })).toHaveCount(
    0,
  );
  check('Create folder and keyboard rename work');
  await page.locator('[data-key="tab:2"]').dragTo(project);
  await expect(project.locator('..').locator('.tab-row')).toHaveCount(1);
  await project.dblclick();
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await expect(page.locator('.tab-row')).toContainText('Typography');
  check('Dragging a tab into a group changes its membership');
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(page.locator('.tab-row')).toHaveCount(2);
  check('New tab is created inside the focused group');
  await page.locator('[data-key="tab:2"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  await page.getByLabel('Destination folder').selectOption('design');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.locator('.tab-row')).toHaveCount(1);
  check('Accessible move menu offers an alternative to dragging');
  await page.locator('#breadcrumbs').getByRole('button', { name: 'Home', exact: true }).click();
  await project.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete folder…' }).click();
  await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
  await expect(project).toHaveCount(0);
  await expect(
    page.locator('.tab-row').filter({ has: page.locator('.label', { hasText: 'New tab' }) }),
  ).toHaveCount(0);
  check('Deleting a group closes its tabs');
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.locator('[data-key="group:design"]').dblclick();
  const parent = page.locator('[data-key="tab:1"]');
  const child = page.locator('[data-key="tab:3"]');
  const grandchild = page.locator('[data-key="tab:4"]');
  const branch = parent.locator('..').locator(':scope > .tab-branch');
  await expect(branch.locator('.tab-row')).toHaveCount(3);
  await expect(child.locator('..').locator(':scope > .tab-branch .tab-row')).toHaveCount(1);
  await parent.getByRole('button', { name: 'Collapse child tabs of Figma — Website' }).click();
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await expect(parent.locator('.tab-toggle-badge')).toBeVisible();
  await expect(parent.locator('.child-count')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox').fill('Launch');
  await expect(page.locator('.tab-row')).toHaveCount(3);
  await expect(grandchild).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tab-row')).toHaveCount(1);
  check('Tab trees collapse independently; search reveals matches with their parent path');
  await parent.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tab-row')).toHaveCount(4);
  await grandchild.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(child).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(grandchild).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(grandchild).toBeVisible();
  check('Keyboard navigation expands, collapses and selects parent tabs');
  await grandchild.click();
  await parent.focus();
  await page.keyboard.press('Space');
  await expect(parent).toHaveClass(/contains-active/);
  await page.locator('#reveal').click();
  await expect(grandchild).toBeVisible();
  await expect(grandchild).toHaveClass(/active/);
  check('A collapsed tree indicates its active child and Show reveals it');
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New child tab', exact: true }).click();
  const newChild = page
    .locator('.tab-row')
    .filter({ has: page.locator('.label', { hasText: /^New tab$/ }) });
  await expect(branch.locator('.tab-row')).toHaveCount(4);
  await expect(newChild).toHaveClass(/active/);
  check('New child tab creates a real child of the selected page in the preview adapter');
  await newChild.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Detach from parent', exact: true }).click();
  await expect(branch.locator('.tab-row')).toHaveCount(3);
  await expect(page.locator('#tree > .tab-node > .tab-row')).toHaveCount(2);
  await newChild.dragTo(child);
  await expect(child.locator('..').locator(':scope > .tab-branch .tab-row')).toHaveCount(2);
  check('Detach and dropping onto a tab move tab trees without changing groups');
  await newChild.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Nest under tab…', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await newChild.dragTo(page.locator('[data-key="tab:2"]'));
  await expect(
    page.locator('[data-key="tab:2"]').locator('..').locator(':scope > .tab-branch .tab-row'),
  ).toHaveCount(1);
  check('The nesting picker is removed and dragging still changes a tab’s parent');
  await child.dragTo(page.locator('[data-key="tab:2"]'), { targetPosition: { x: 60, y: 2 } });
  await expect(branch.locator(':scope > .tab-node > .tab-row > .label')).toHaveText([
    'Brand guidelines',
    'Typography reference',
  ]);
  check('Dropping at the edge reorders siblings without nesting them');
  await child.getByRole('button', { name: 'Close Brand guidelines', exact: true }).click();
  await page.getByRole('button', { name: 'Close 2 tabs', exact: true }).click();
  await expect(child).toHaveCount(0);
  await expect(grandchild).toHaveCount(0);
  await expect(branch.locator('.tab-row')).toHaveCount(2);
  check('Closing a parent tab confirms and closes its nested tabs together');
  await parent.dragTo(page.locator('#home'));
  await expect(page.locator('.tab-row')).toHaveCount(0);
  await page.locator('#home').click();
  await expect(parent.locator('..').locator(':scope > .tab-branch .tab-row')).toHaveCount(2);
  await expect(page.locator('#tree > .tab-node > [data-key="tab:1"]')).toBeVisible();
  check('Moving a parent to Home carries all descendants out of the group');
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.pinned-tab')).toHaveCount(4);
  const pins = page.locator('#pinned-tabs');
  await expect(pins.locator('.label,.close-tab,.tab-indicator')).toHaveCount(0);
  await expect(page.locator('#tree [data-key="tab:10"]')).toHaveCount(0);
  await page.locator('[data-key="group:design"]').dblclick();
  const savedPin = pins.getByRole('button', { name: 'Weekend in Copenhagen, pinned', exact: true });
  await savedPin.click();
  await expect(savedPin).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await expect(page.locator('#reveal')).toBeHidden();
  check(
    'Pinned tabs use global favicon buttons without duplicate rows or leaving the current group',
  );
  await page.locator('[data-key="tab:1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Collapse child tabs', exact: true }).click();
  await page.locator('[data-key="tab:1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  const parentPin = pins.getByRole('button', { name: 'Figma — Website, pinned', exact: true });
  await expect(parentPin).toBeVisible();
  await expect(page.locator('#tree [data-key="tab:1"]')).toHaveCount(0);
  await expect(page.locator('.tab-row')).toHaveCount(3);
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await parentPin.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Unpin tab', exact: true }).click();
  await expect(parentPin).toHaveCount(0);
  await expect(page.locator('#tree [data-key="tab:1"]')).toHaveAttribute('aria-expanded', 'false');
  await page
    .locator('[data-key="tab:1"]')
    .getByRole('button', { name: 'Expand child tabs of Figma — Website' })
    .click();
  await expect(page.locator('.tab-row')).toHaveCount(4);
  check(
    'Pinning a collapsed parent preserves accessible children; keyboard unpin restores the saved tree',
  );
  await page.setViewportSize({ width: 240, height: 360 });
  const pinTop = (await savedPin.boundingBox()).y;
  await page.evaluate(() => {
    document.getElementById('tree').scrollTop = 200;
  });
  expect((await savedPin.boundingBox()).y).toBe(pinTop);
  await savedPin.focus();
  await page.keyboard.press('Enter');
  await expect(savedPin).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/sidebar-pins.png' });
  check('Pins stay at the top while the tab list scrolls and support keyboard activation');
  await page.setViewportSize({ width: 240, height: 740 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  check('Sidebar fits a narrow 240px panel');
  await page.setViewportSize({ width: 320, height: 820 });
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.tab-row')).toHaveCount(6);

  await page.locator('[data-key="group:design"] .label').click({ button: 'middle' });
  await expect(page.locator('[data-key="group:design"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await page.evaluate(() => {
    window.middleClicks = [];
    document.addEventListener('mousedown', (event) => {
      if (event.button === 1) window.middleClicks.push(event.defaultPrevented);
    });
  });
  await page.locator('[data-key="tab:2"] .label').click({ button: 'middle' });
  await expect(page.locator('[data-key="tab:2"]')).toHaveCount(0);
  await expect(page.locator('[data-key="tab:1"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-key="tab:3"] .close-tab').click({ button: 'middle' });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#dialog-submit')).toHaveText('Close 2 tabs');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[data-key="tab:3"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:4"]')).toBeVisible();
  await page.locator('[data-key="tab:1"] .tab-disclosure').click({ button: 'middle' });
  await page.getByRole('button', { name: 'Close 3 tabs', exact: true }).click();
  await expect(page.locator('[data-key="tab:1"]')).toHaveCount(0);
  await expect(page.locator('[data-key="tab:4"]')).toHaveCount(0);
  await expect(page.locator('.tab-row')).toHaveCount(2);
  await page.locator('[data-key="tab:10"] .tab-icon').click({ button: 'middle' });
  await expect(page.locator('[data-key="tab:10"]')).toHaveCount(0);
  await expect(page.locator('.pinned-tab')).toHaveCount(3);
  expect(await page.evaluate(() => window.middleClicks)).toEqual([true, true, true, true]);
  check(
    'Middle-click closes leaves and pins immediately, confirms parent branches and prevents autoscroll',
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.tab-row')).toHaveCount(6);

  const blankClick = async (options = {}) => {
    const box = await page.locator('#tree').boundingBox();
    // The padded gutter stays blank even when the list fills a short viewport.
    await page.locator('#tree').click({ position: { x: 5, y: box.height - 25 }, ...options });
  };

  const blankMenu = () => blankClick({ button: 'right' });
  await blankClick();
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await blankMenu();
  await expect(page.getByRole('menuitem', { name: 'Undo last closed tab' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Show current tab' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tree')).toBeFocused();
  await blankClick({ clickCount: 2 });
  await expect(page.locator('.tab-row')).toHaveCount(7);
  let fresh = page.locator('.tab-row').filter({ hasText: 'New tab' });
  await expect(fresh.locator('../..')).toHaveAttribute('id', 'tree');
  await fresh.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await blankMenu();
  await expect(page.getByRole('menuitem', { name: 'Undo last closed tab' })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Undo last closed tab' }).click();
  await expect(page.locator('.tab-row')).toHaveCount(7);
  await expect(fresh).toHaveClass(/active/);
  check('Blank-space double-click creates one Home tab; undo restores it and skips disabled items');
  await page.locator('[data-key="group:design"]').dblclick();
  await expect(page.locator('.tab-row')).toHaveCount(4);
  await page.locator('[data-key="tab:1"]').dblclick();
  await expect(page.locator('.tab-row')).toHaveCount(4);
  await page.locator('[data-key="tab:1"]').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New child tab', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New tab', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await blankMenu();
  await page.getByRole('menuitem', { name: 'New tab in container…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Open a new tab in Design');
  await expect(page.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  await page.getByRole('button', { name: 'Create tab', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.tab-row')).toHaveCount(5);
  await expect(fresh).toHaveAccessibleName('New tab, container: Work');
  await expect(fresh.locator('.container-indicator')).toBeVisible();
  await fresh.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await page.locator('#home').click();
  await blankMenu();
  await page.getByRole('menuitem', { name: 'Collapse all folders' }).click();
  await expect(page.locator('[data-key="tab:1"]')).toHaveCount(0);
  await blankMenu();
  await page.getByRole('menuitem', { name: 'Undo last closed tab' }).click();
  await expect(page.locator('[data-key="tab:1"]')).toBeVisible();
  await expect(
    page
      .locator('.tab-row')
      .filter({ hasText: 'New tab' })
      .filter({ has: page.locator('.container-indicator') }),
  ).toBeVisible();
  check(
    'Container tabs use the focused group; undo reveals saved groups without changing row menus',
  );
  await page.locator('[data-key="group:design"]').dblclick();
  await page.locator('#tree').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Empty test group');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await page.locator('.group-row').filter({ hasText: 'Empty test group' }).dblclick();
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/sidebar-empty-folder.png' });
  await page
    .getByRole('button', { name: 'New tab in Empty test group', exact: true })
    .dispatchEvent('dblclick', { button: 0 });
  await expect(page.locator('.tab-row')).toHaveCount(0);
  await blankClick({ clickCount: 2 });
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Search tabs and folders', exact: true }).click();
  await page.getByRole('searchbox').fill('no matching pages');
  await expect(page.locator('.empty-state h2')).toHaveText('Nothing found');
  await blankMenu();
  await page.getByRole('menuitem', { name: 'New tab', exact: true }).click();
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.locator('.tab-row')).toHaveCount(2);
  check(
    'Keyboard blank-area menu, empty groups and filtered lists create tabs in the current group',
  );
  await page.setViewportSize({ width: 240, height: 360 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await blankMenu();
  await expect(page.locator('#menu')).toBeVisible();
  const menuBox = await page.locator('#menu').boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(240);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(360);
  await page.screenshot({ path: 'test-results/blank-area-menu-dark-narrow.png' });
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  check('Blank-area menu fits a short, narrow dark sidebar');
  await page.setViewportSize({ width: 1200, height: 980 });
  await page.goto(base);
  await expect(page.frameLocator('iframe').locator('[data-key="group:design"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/preview.png' });
  expect(errors).toEqual([]);
  check('Interactive preview renders without JavaScript errors');
  await page.addInitScript(() => {
    const listeners = new Set();
    window.failStartup = true;
    let controller;
    window.reconnect = () => {
      window.failStartup = false;
      for (const listener of listeners) listener({ type: 'tabernacle:changed' });
    };
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-startup-test',
        onMessage: { addListener: (fn) => listeners.add(fn) },

        sendMessage: async (message) => {
          if (window.failStartup) throw new Error('Test connection unavailable');
          if (window.failGroupClose && message.type === 'tabernacle:closeGroupTabs')
            return { ok: false, error: 'Firefox could not close these tabs.' };
          controller ??= import('/preview/demo.js').then(({ createDemo }) => createDemo());
          return {
            ok: true,
            data: await (
              await controller
            ).request({ ...message, type: message.type.slice('tabernacle:'.length) }),
          };
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('#tree')).toHaveText('Test connection unavailable');
  await expect(page.locator('#new-tab')).toBeDisabled();
  await expect(page.locator('#new-group')).toBeDisabled();
  await page.evaluate(() => window.reconnect());
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();
  await expect(page.locator('#new-tab')).toBeEnabled();
  await expect(page.locator('#new-group')).toBeEnabled();
  expect(errors).toEqual([]);
  check('Failed startup shows the error, disables unavailable actions and recovers on reconnect');
  await page.setViewportSize({ width: 320, height: 820 });
  const work = page.locator('[data-key="group:work"]');

  const openGroupClose = async (row) => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close all tabs…', exact: true }).click();
  };

  await openGroupClose(work);
  await expect(page.locator('#dialog-title')).toHaveText('Close all tabs in “Work”?');
  await expect(page.locator('#dialog-description')).toContainText('Close 9 tabs');
  await expect(page.locator('#dialog-description')).toContainText('subfolders in this window');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/close-group-tabs.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(work).toHaveAccessibleName('Work, 9 tabs');
  await openGroupClose(work);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(work).toHaveAccessibleName('Work, 9 tabs');
  check('Folder close confirms the total including subfolders; Cancel and Escape preserve tabs');

  await page.evaluate(() => {
    window.failGroupClose = true;
  });
  await openGroupClose(work);
  await page.getByRole('button', { name: 'Close 9 tabs', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Firefox could not close these tabs.');
  await expect(work).toHaveAccessibleName('Work, 9 tabs');
  await page.evaluate(() => {
    window.failGroupClose = false;
  });
  await page.getByRole('button', { name: 'Close 9 tabs', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(work).toHaveAccessibleName('Work, 0 tabs');
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();
  await expect(page.locator('[data-key="group:research"]')).toBeVisible();
  await work.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Close all tabs…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  check('Confirmed close handles errors, keeps folders and disables the action for empty folders');

  await page.locator('[data-key="group:personal"]').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Close all tabs…', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dialog-description')).toContainText('3 pinned tabs');
  await page.getByRole('button', { name: 'Close 3 tabs', exact: true }).click();
  await expect(page.locator('.pinned-tab')).toHaveCount(1);
  await expect(page.locator('[data-key="group:personal"]')).toHaveAccessibleName(
    'Personal, 0 tabs',
  );
  await expect(page.locator('[data-key="group:later"]')).toHaveAccessibleName('Later, 4 tabs');
  expect(errors).toEqual([]);
  check('Keyboard folder menus close assigned pinned tabs while keeping unrelated tabs');
  console.log(`${checks} UI checks passed.`);
} catch (error) {
  await page.screenshot({ path: 'test-results/ui-failure.png' });
  if (errors.length) console.error('Browser errors:', errors);
  throw error;
} finally {
  await close();
}
