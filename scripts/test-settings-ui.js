import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 340, height: 820 },
  colorScheme: 'light',
});
const errors = [];
page.context().on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    const listeners = new Set();
    let ready;
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      commands: {
        getAll: async () => [{ name: '_execute_sidebar_action', shortcut: 'Alt+Shift+E' }],

        openShortcutSettings: async () => {
          window.shortcutsOpened = true;
        },
      },
      runtime: {
        id: 'settings-test',
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:setLook' && window.failSave)
            return { ok: false, error: 'Storage unavailable' };
          if (message.type === 'tabernacle:getContainers' && window.failContainers)
            return { ok: false, error: 'Containers unavailable' };
          if (message.type === 'tabernacle:createContainer' && window.holdContainerSave)
            await new Promise((resolve) => (window.releaseContainerSave = resolve));
          if (message.type === 'tabernacle:createContainer' && window.failContainerSave)
            return { ok: false, error: 'Could not create container' };
          ready ??= import('/preview/demo.js').then(({ createDemo }) =>
            createDemo((notice) => {
              for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
            }),
          );
          try {
            return {
              ok: true,
              data: await (
                await ready
              ).request({ ...message, type: message.type.slice('tabernacle:'.length) }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row.active')).toBeVisible();
  const open = await prepareSettings(page);
  const settings = await open();
  await settings.setViewportSize({ width: 1180, height: 900 });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(settings).toHaveTitle('Settings · Tabernacle');
  await expect(settings.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(settings.locator('#appearance-save')).toBeDisabled();
  const lines = settings.getByRole('checkbox', { name: 'Show connecting lines', exact: true });
  const domains = settings.getByRole('checkbox', {
    name: 'Show the domain as a second line',
    exact: true,
  });
  await expect(lines).toBeChecked();
  await domains.check();
  await expect(page.locator('.row-detail')).toHaveCount(0);
  await expect(settings.locator('#appearance-status')).toHaveText('Unsaved changes');
  await settings.getByRole('link', { name: 'Containers', exact: true }).click();
  const newContainer = settings.getByRole('button', { name: 'New container', exact: true });
  const containerEditor = settings.getByRole('dialog', { name: 'New container', exact: true });
  await expect(settings.locator('.settings-container').first()).toBeVisible();
  const listBounds = await settings.locator('#container-list').boundingBox();
  await newContainer.click();
  await expect(containerEditor).toBeVisible();
  expect(await settings.locator('#container-list').boundingBox()).toEqual(listBounds);
  await expect(settings.getByLabel('Container name', { exact: true })).toBeFocused();
  await settings.getByLabel('Find a container').evaluate((node) => node.focus());
  await expect(settings.getByLabel('Container name', { exact: true })).toBeFocused();
  await expect(containerEditor.getByRole('button', { name: 'Create container' })).toBeEnabled();
  await settings.keyboard.press('Tab');
  await expect(containerEditor.getByRole('radio', { name: 'Blue', exact: true })).toBeFocused();
  await settings.keyboard.press('Escape');
  await expect(containerEditor).toBeHidden();
  await expect(newContainer).toBeFocused();
  await newContainer.click();
  await settings.getByLabel('Container name', { exact: true }).fill('Draft container');
  const pageCount = page.context().pages().length;
  await page.bringToFront();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.locator('#containers-title')).toBeVisible();
  await expect(settings.getByLabel('Container name', { exact: true })).toHaveValue(
    'Draft container',
  );
  expect(page.context().pages().length).toBe(pageCount);
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings.getByRole('link', { name: 'Appearance', exact: true }).click();
  await expect(settings.locator('#appearance-status')).toHaveText('Unsaved changes');
  await settings.locator('#appearance-reset').click();
  await expect(domains).not.toBeChecked();
  await domains.check();
  await page.evaluate(() => {
    window.failSave = true;
  });
  await settings.locator('#appearance-save').click();
  await expect(settings.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(domains).toBeChecked();
  await expect(domains).toBeEnabled();
  await page.evaluate(() => {
    window.failSave = false;
  });
  await settings.locator('#appearance-save').click();
  await expect(page.locator('.row-detail').first()).toBeVisible();
  await expect(settings.locator('#appearance-status')).toHaveText('All changes saved');
  console.log('✓ Settings opens in a tab; save, discard, failure and retry update the sidebar');

  const send = (type, args = {}) =>
    page.evaluate(
      async ({ type, args }) => {
        const result = await browser.runtime.sendMessage({
          type: `tabernacle:${type}`,
          windowId: 1,
          ...args,
        });
        if (!result.ok) throw new Error(result.error);
        return result.data;
      },
      { type, args },
    );
  await lines.uncheck();
  await send('setLook', {
    value: { colorScheme: 'dark', themeSource: 'tabernacle' },
    partial: true,
  });
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');
  await expect(lines).not.toBeChecked();
  await settings.getByRole('link', { name: 'About', exact: true }).click();
  await expect(settings.locator('#extension-version')).toContainText('Version 0.1.6');
  await settings.goBack();
  await expect(lines).not.toBeChecked();
  await settings.locator('#appearance-save').click();
  expect((await send('getSettings')).look).toEqual({
    connectingLines: false,
    domains: true,
    themeSource: 'tabernacle',
    colorScheme: 'dark',
  });
  await settings.reload();
  await expect(lines).not.toBeChecked();
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');
  await settings.screenshot({ path: 'test-results/settings-appearance-dark.png' });
  await settings.locator('#look-color-scheme').selectOption('light');
  await settings.locator('#appearance-save').click();
  await expect(settings.locator('#appearance-save')).toBeDisabled();
  await settings.screenshot({ path: 'test-results/settings-appearance-light.png' });
  console.log(
    '✓ Saved preferences survive reload; live updates preserve unsaved edits and section navigation',
  );

  await settings.getByRole('link', { name: 'Containers', exact: true }).click();
  await settings.getByRole('button', { name: 'New container', exact: true }).click();
  await expect(settings.getByLabel('Container name', { exact: true })).toBeFocused();
  await settings.getByLabel('Container name', { exact: true }).fill('Reading');
  await settings.getByRole('radio', { name: 'Purple', exact: true }).check();
  await settings.getByRole('radio', { name: 'Tree', exact: true }).check();
  await settings.screenshot({ path: 'test-results/settings-container-editor.png' });
  await page.evaluate(() => {
    window.holdContainerSave = true;
    window.failContainerSave = true;
  });
  await settings.getByRole('button', { name: 'Create container', exact: true }).click();
  await expect(containerEditor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await settings.keyboard.press('Escape');
  await expect(containerEditor).toBeVisible();
  await page.evaluate(() => {
    window.holdContainerSave = false;
    window.releaseContainerSave();
  });
  await expect(containerEditor.getByRole('alert')).toHaveText('Could not create container');
  await expect(settings.getByLabel('Container name', { exact: true })).toHaveValue('Reading');
  await page.evaluate(() => (window.failContainerSave = false));
  await settings.getByRole('button', { name: 'Create container', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Edit Reading', exact: true })).toBeVisible();
  await expect(settings.locator('#container-editor')).toBeHidden();
  await expect(newContainer).toBeFocused();
  await settings.getByRole('button', { name: 'Edit Reading', exact: true }).click();
  await expect(settings.getByRole('dialog', { name: 'Edit container', exact: true })).toBeVisible();
  await expect(settings.getByRole('radio', { name: 'Purple', exact: true })).toBeChecked();
  await expect(settings.getByRole('radio', { name: 'Tree', exact: true })).toBeChecked();
  await settings.getByLabel('Container name', { exact: true }).fill('Reference');
  await settings.getByRole('button', { name: 'Save container', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Edit Reference', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Edit Reference', exact: true })).toBeFocused();
  await settings.getByLabel('Find a container').fill('no match');
  await expect(settings.locator('#container-list')).toHaveText('No containers match your search.');
  await settings.getByLabel('Find a container').fill('reference');
  await expect(settings.locator('.settings-container')).toHaveCount(1);
  const identity = (await send('getContainers')).containers.find(
    (item) => item.name === 'Reference',
  );
  await settings.getByRole('button', { name: 'Remove Reference', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(settings.locator('#container-editor')).toContainText('cookies and site data');
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    settings.getByRole('button', { name: 'Remove Reference', exact: true }),
  ).toBeFocused();
  const tab = await send('newTab', { cookieStoreId: identity.cookieStoreId });
  await settings.getByRole('button', { name: 'Remove Reference', exact: true }).click();
  await settings.getByRole('button', { name: 'Remove container', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Close this container’s tabs');
  await send('closeTab', { id: tab.createdTabId });
  await settings.getByRole('button', { name: 'Remove container', exact: true }).click();
  await expect(settings.locator('#container-editor')).toBeHidden();
  await expect(settings.locator('.settings-container')).toHaveCount(0);
  await page.evaluate(() => {
    window.failContainers = true;
  });
  await settings.getByRole('link', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('link', { name: 'Containers', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveText('Containers unavailable');
  await page.evaluate(() => {
    window.failContainers = false;
  });
  await settings.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  console.log(
    '✓ Container dialogs preserve list layout, contain focus, handle Escape, save failures and protected removal',
  );

  for (const width of [360, 220]) {
    await settings.setViewportSize({ width, height: 480 });
    await newContainer.click();
    await expect(containerEditor.getByRole('button', { name: 'Create container' })).toBeEnabled();
    expect(
      await containerEditor.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight &&
          node.scrollWidth === node.clientWidth
        );
      }),
    ).toBe(true);
    await containerEditor
      .getByRole('button', { name: 'Cancel', exact: true })
      .scrollIntoViewIfNeeded();
    await settings.screenshot({ path: `test-results/settings-container-${width}.png` });
    await settings.keyboard.press('Escape');
    await expect(newContainer).toBeFocused();
  }
  await settings.setViewportSize({ width: 1180, height: 900 });
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await newContainer.click();
  await expect(containerEditor.getByRole('button', { name: 'Create container' })).toBeEnabled();
  await settings.screenshot({ path: 'test-results/settings-container-dark.png' });
  await settings.emulateMedia({ forcedColors: 'active' });
  await expect(containerEditor).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(containerEditor).toHaveCSS('color', 'rgb(0, 0, 0)');
  await settings.screenshot({ path: 'test-results/settings-container-forced-colours.png' });
  await settings.keyboard.press('Escape');
  await settings.emulateMedia({ forcedColors: 'none' });
  await send('setLook', { partial: true, value: { colorScheme: 'light' } });

  await settings.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  await expect(settings.locator('#sidebar-shortcut')).toHaveText('Alt+Shift+E');
  await settings.getByRole('button', { name: 'Manage extension shortcuts', exact: true }).click();
  expect(await page.evaluate(() => window.shortcutsOpened)).toBe(true);
  await settings.getByRole('link', { name: 'Appearance', exact: true }).click();
  for (const width of [720, 360, 220]) {
    await settings.setViewportSize({ width, height: 700 });
    expect(await settings.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await settings.screenshot({ path: `test-results/settings-${width}.png`, fullPage: true });
  }
  await settings.emulateMedia({ forcedColors: 'active' });
  await expect(settings.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await settings.locator('#look-theme-source').focus();
  await expect(settings.locator('#look-theme-source')).toBeFocused();
  await settings.screenshot({ path: 'test-results/settings-forced-colours.png', fullPage: true });
  await page.evaluate(() => {
    window.failOpenSettings = true;
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Could not open settings');
  expect(errors).toEqual([]);
  console.log(
    '✓ Shortcuts, About, narrow layouts, forced colours and settings-launch errors are covered',
  );
} finally {
  await close();
}
