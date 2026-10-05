import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 920 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    let ready;
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      runtime: {
        id: 'tabernacle-look-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:setLook' && window.failLookSave)
            return { ok: false, error: 'Storage unavailable' };
          ready ??= import('/preview/demo.js').then(({ createDemo }) =>
            createDemo((notice) => {
              for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
            }),
          );
          const data = await (
            await ready
          ).request({
            ...message,
            type: message.type.slice('tabernacle:'.length),
          });
          const parent = data.tabs?.find((tab) => tab.id === 1);
          if (parent)
            parent.favIconUrl = window.breakParentFavicon
              ? 'data:image/png;base64,bad'
              : `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#8970cf"/></svg>')}`;
          return { ok: true, data };
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  const parent = page.locator('[data-key="tab:1"]');
  const child = page.locator('[data-key="tab:2"]');
  const group = page.locator('[data-key="group:design"]');
  await expect(parent).toBeVisible();

  const geometry = () =>
    page
      .locator('#tree .row, #tree .new-tab-action, footer, .footer-actions > button')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
  const styles = (selector) =>
    page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return Object.fromEntries(
          [
            'display',
            'color',
            'backgroundColor',
            'fontSize',
            'fontWeight',
            'lineHeight',
            'padding',
            'margin',
            'gap',
            'border',
            'borderRadius',
            'boxShadow',
            'opacity',
          ].map((name) => [name, style[name]]),
        );
      }),
    );
  const footer = () => styles('footer, footer *');

  const settleFocus = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(319, 0);
  };

  const openLook = async () => {
    await page.locator('#more').click();
    await expect(page.getByRole('menuitem', { name: 'Look', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Appearance', exact: true })).toBeVisible();
  };

  const lines = page.getByRole('checkbox', { name: 'Show connecting lines', exact: true });
  const domains = page.getByRole('checkbox', {
    name: 'Show the domain as a second line',
    exact: true,
  });

  const saveLook = async (showLines, showDomains) => {
    await openLook();
    await lines.setChecked(showLines);
    await domains.setChecked(showDomains);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await settleFocus();
  };

  const guides = () =>
    child.evaluate((node) => getComputedStyle(node.parentElement, '::after').content);

  const activeTab = () =>
    page.evaluate(
      async () =>
        (
          await window.browser.runtime.sendMessage({ type: 'tabernacle:snapshot', windowId: 1 })
        ).data.tabs.find((tab) => tab.active).id,
    );

  // Connecting lines start enabled, while domain subtitles remain optional.
  expect(await guides()).toBe('""');
  await openLook();
  await expect(lines).toBeChecked();
  await expect(domains).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Centre new tab button' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Left-align new tab button' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await expect(page.locator('.disclosure-space')).toHaveCount(0);
  await expect(parent.locator('.tab-disclosure .tab-icon img')).toBeVisible();
  await expect(group.locator('.disclosure .group')).toBeVisible();
  await expect(parent.locator('.tab-disclosure > svg')).toHaveCount(0);
  await expect(child.locator('.disclosure')).toHaveCount(0);
  await expect(child.locator('.tab-toggle-badge')).toHaveCount(0);
  await expect(parent.locator('.tab-disclosure')).toHaveCSS('width', '22px');
  const toggleGlyph = () => parent.locator('.tab-toggle-badge svg');
  await expect(toggleGlyph()).toHaveAttribute('data-icon', 'subtract-circle-12');

  // Leaf icons activate tabs; parent icons activate and fold in one click.
  await child.locator('.tab-icon').click();
  await expect(child).toHaveClass(/active/);
  await parent.locator('.tab-icon').click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await expect(parent).toBeFocused();
  await expect(parent.locator('.tab-toggle-badge')).toBeVisible();
  await expect(parent.locator('.child-count')).toHaveCount(0);
  await expect(toggleGlyph()).toHaveAttribute('data-icon', 'add-circle-12');
  await page.screenshot({ path: 'test-results/icon-toggle-collapsed.png' });
  await expect(parent.locator('.tab-disclosure')).toHaveAttribute(
    'title',
    'Expand child tabs of Figma — Website',
  );
  expect(await activeTab()).toBe(1);
  await parent.locator('.label').click();
  await expect(parent).toHaveClass(/active/);
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await expect(child).toBeVisible();
  await expect(parent.locator('.child-count')).toHaveCount(0);
  await expect(toggleGlyph()).toHaveAttribute('data-icon', 'subtract-circle-12');
  await page.screenshot({ path: 'test-results/icon-toggle-expanded.png' });
  await expect(parent.locator('.tab-disclosure')).toHaveAttribute(
    'title',
    'Collapse child tabs of Figma — Website',
  );

  // Folder icons retain single-click folding and double-click navigation.
  await group.locator('.group').click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.disclosure')).toHaveAttribute('title', 'Expand Design');
  await group.locator('.group').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await group.locator('.group').dblclick({ delay: 100 });
  await expect(page.locator('#scope-heading')).toHaveText('Design');
  await page.locator('#home').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');

  // The favicon remains a drag handle for the entire tab tree.
  const research = page.locator('[data-key="group:research"]');
  await parent.locator('.tab-icon img').dragTo(research);
  await research.locator('.group').click();
  await expect(parent).toBeVisible();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await parent.locator('.tab-icon img').dragTo(group);
  await expect(group.locator('..').locator('[data-key="tab:1"]')).toBeVisible();
  await research.locator('.group').click();
  // Folder clicks wait for a possible double-click before changing the tree.
  await expect(research).toHaveAttribute('aria-expanded', 'false');

  // Unreadable favicons fall back to a globe with the same working toggle.
  await page.evaluate(async () => {
    window.breakParentFavicon = true;
    await window.browser.runtime.sendMessage({
      type: 'tabernacle:setLook',
      windowId: 1,
      value: { connectingLines: false, domains: false },
    });
  });
  await expect(parent.locator('.tab-disclosure .tab-icon svg')).toBeVisible();
  await parent.locator('.tab-icon').click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await parent.locator('.tab-icon').click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(async () => {
    window.breakParentFavicon = false;
    await window.browser.runtime.sendMessage({
      type: 'tabernacle:setLook',
      windowId: 1,
      value: { connectingLines: false, domains: false },
    });
  });
  await expect(parent.locator('.tab-icon img')).toBeVisible();

  const iconCentre = async (selector) => {
    const bounds = await page.locator(selector).boundingBox();
    return bounds.x + bounds.width / 2;
  };

  expect(await iconCentre('[data-key="group:research"] .group')).toBe(
    await iconCentre('[data-key="tab:8"] .tab-icon'),
  );
  expect(await iconCentre('[data-key="new-tab:work"] svg')).toBe(
    await iconCentre('[data-key="tab:8"] .tab-icon'),
  );

  // Capture a baseline after explicitly disabling both optional details above.
  await settleFocus();
  const baselineGeometry = await geometry();
  const baselineFooter = await footer();
  await expect(page.locator('#appearance-styles')).toHaveCount(0);
  expect(
    await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
  ).toEqual(['sidebar.css', 'tree.css']);
  await page.screenshot({ path: 'test-results/look-default.png' });
  await expect(page.locator('.row-detail')).toHaveCount(0);
  expect(await guides()).toBe('none');

  // Editing then cancelling does not apply either preference.
  await openLook();
  await expect(page.getByRole('combobox', { name: 'Colour mode', exact: true })).toBeFocused();
  await expect(lines).not.toBeChecked();
  await expect(domains).not.toBeChecked();
  await lines.check();
  await domains.check();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openLook();
  await expect(lines).not.toBeChecked();
  await expect(domains).not.toBeChecked();
  await page.keyboard.press('Escape');

  // Lines change no row geometry or controls; domains remain disabled.
  await saveLook(true, false);
  expect(await guides()).toBe('""');
  expect(await geometry()).toEqual(baselineGeometry);
  await expect(page.locator('.row-detail')).toHaveCount(0);
  await expect(parent.locator('.tab-disclosure')).toBeVisible();
  expect(await footer()).toEqual(baselineFooter);
  await page.screenshot({ path: 'test-results/look-lines.png' });

  // Domains apply to parent tabs as well as leaves, without adding group counts.
  await saveLook(false, true);
  expect(await guides()).toBe('none');
  await expect(parent.locator('.row-detail')).toHaveText('figma.com');
  await expect(child.locator('.row-detail')).toHaveText('fonts.google.com');
  await expect(group.locator('.row-detail')).toHaveCount(0);
  await expect(parent).toHaveCSS('min-height', '38px');
  expect(await footer()).toEqual(baselineFooter);
  await page.screenshot({ path: 'test-results/look-domains.png' });

  // Failed saves remain editable and can be retried without losing selections.
  await openLook();
  await lines.check();
  await page.evaluate(() => (window.failLookSave = true));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(lines).toBeEnabled();
  expect(await guides()).toBe('none');
  await page.evaluate(() => (window.failLookSave = false));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await settleFocus();
  expect(await guides()).toBe('""');
  await expect(parent.locator('.row-detail')).toHaveText('figma.com');
  expect(await footer()).toEqual(baselineFooter);
  await page.screenshot({ path: 'test-results/look-light.png' });

  const checkConnection = async (parentKey, childKey) => {
    const offsets = await page.locator(`[data-key="${childKey}"]`).evaluate((node, parentKey) => {
      const wrapper = node.parentElement;
      const elbow = getComputedStyle(wrapper, '::after');
      const bounds = wrapper.getBoundingClientRect();
      const iconSelector = '.group, .tab-icon, .new-tab-action svg';
      const icon = node.querySelector(iconSelector).getBoundingClientRect();
      const parentIcon = document
        .querySelector(`[data-key="${parentKey}"]`)
        .querySelector(iconSelector)
        .getBoundingClientRect();
      const branch = wrapper.parentElement;
      const stem = getComputedStyle(branch, '::before');
      const start = bounds.left + parseFloat(elbow.insetInlineStart);
      return {
        gap: icon.left - start - parseFloat(elbow.width),
        centre: Math.abs(bounds.top + parseFloat(elbow.height) - icon.top - icon.height / 2),
        parentCentre: Math.abs(start - parentIcon.left - parentIcon.width / 2),
        parentBottomGap:
          branch.getBoundingClientRect().top + parseFloat(stem.top) - parentIcon.bottom,
      };
    }, parentKey);
    expect(offsets.gap).toBe(2);
    expect(offsets.centre).toBeLessThanOrEqual(1);
    expect(offsets.parentCentre).toBeLessThanOrEqual(1);
    expect(offsets.parentBottomGap).toBe(2);
  };

  const checkGuide = async () => {
    await checkConnection('group:work', 'group:design');
    await checkConnection('group:design', 'tab:1');
    await checkConnection('tab:1', 'tab:2');
    await checkConnection('tab:3', 'tab:4');
    await checkConnection('group:design', 'new-tab:design');
  };

  await checkGuide();
  await parent.locator('.tab-disclosure').click();
  await expect(child).toHaveCount(0);
  await parent.focus();
  await page.keyboard.press('ArrowRight');
  await expect(child).toBeVisible();
  await group.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename folder', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('Typography');
  await expect(child).toBeVisible();
  await expect(parent).toBeVisible();
  await checkConnection('tab:1', 'tab:2');
  await page.keyboard.press('Escape');
  await page.locator('#more').click();
  await expect(page.getByRole('menuitem', { name: /^(Compact|Comfortable) rows$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(parent).toHaveCSS('min-height', '38px');
  await expect(group).toHaveCSS('min-height', '26px');

  // Background preference changes refresh the open sidebar and its dialog.
  await page.evaluate(() =>
    window.browser.runtime.sendMessage({
      type: 'tabernacle:setLook',
      windowId: 1,
      value: { connectingLines: false, domains: false },
    }),
  );
  await expect(page.locator('.row-detail')).toHaveCount(0);
  expect(await geometry()).toEqual(baselineGeometry);
  expect(await guides()).toBe('none');
  await page.evaluate(() =>
    window.browser.runtime.sendMessage({
      type: 'tabernacle:setLook',
      windowId: 1,
      value: { connectingLines: true, domains: true },
    }),
  );
  await expect(parent.locator('.row-detail')).toHaveText('figma.com');
  await openLook();
  await expect(lines).toBeChecked();
  await expect(domains).toBeChecked();
  await page.screenshot({ path: 'test-results/look-preferences.png' });
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 240, height: 820 });
  await settleFocus();
  await checkGuide();
  expect(await page.locator('#tree').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/look-dark-narrow.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(parent).toHaveCSS('outline-width', '2px');
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' });
  await page.setViewportSize({ width: 320, height: 920 });
  await saveLook(false, false);
  expect(await geometry()).toEqual(baselineGeometry);
  expect(await footer()).toEqual(baselineFooter);
  await expect(page.locator('.row-detail')).toHaveCount(0);
  expect(await guides()).toBe('none');

  // The caption-free action stays left-aligned, with full-row hover and the same group target.
  const add = page.getByRole('button', { name: 'New tab in Design', exact: true });
  await expect(add).toHaveText('');
  await expect(add).toHaveAttribute('title', 'New tab in Design');
  await saveLook(true, false);
  for (const width of [320, 240]) {
    await page.setViewportSize({ width, height: 920 });
    for (const action of await page.locator('.new-tab-action').all()) {
      const bounds = await action.boundingBox();
      const plus = await action.locator('svg').boundingBox();
      expect(plus.x - bounds.x).toBe(9);
      expect(
        await action.evaluate((node) => getComputedStyle(node.parentElement, '::after').content),
      ).toBe((await action.getAttribute('data-key')) === 'new-tab:null' ? 'none' : '""');
    }
    expect(
      await page.locator('#tree').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 920 });
  await child.hover();
  const tabHover = await child.evaluate((node) => getComputedStyle(node).backgroundColor);
  await add.hover();
  await expect(add).toHaveCSS('background-color', tabHover);
  await page.screenshot({ path: 'test-results/look-left-new-tab-hover.png' });
  const beforeAdd = await page.locator('.tab-row').count();
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-row')).toHaveCount(beforeAdd + 1);
  const created = group.locator('..').locator('.tab-row.active');
  await expect(created.locator('.label')).toHaveText('New tab');
  await expect(add).toHaveText('');
  expect(await iconCentre('[data-key="new-tab:work"] svg')).toBe(
    await iconCentre('[data-key="tab:8"] .tab-icon'),
  );
  await checkConnection('group:design', 'new-tab:design');
  await add.hover();
  await expect(add).toHaveCSS('background-color', tabHover);
  await add.click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['New tab', 'New folder…']);
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();

  // Closing the last child turns its parent's icon back into tab activation.
  const formerParent = page.locator('[data-key="tab:3"]');
  await page.locator('[data-key="tab:4"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await expect(formerParent.locator('.disclosure')).toHaveCount(0);
  await formerParent.locator('.tab-icon').click();
  await expect(formerParent).toHaveClass(/active/);
  expect(errors).toEqual([]);
  console.log(
    '✓ Fixed compact layout with independent Appearance preferences; default guides, background updates, domains, unchanged footer, save retry, folding, search and dark/narrow/forced-colour views work',
  );
} finally {
  await close();
}
