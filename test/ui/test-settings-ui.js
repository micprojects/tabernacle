import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';
import { prepareSettings } from '../helpers/settings-test.js';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
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
          if (message.type === 'tabernacle:setLook') {
            (window.lookWrites ??= []).push(structuredClone(message.value));
            if (window.holdLookSave) {
              window.holdLookSave = false;
              await new Promise((resolve) => (window.releaseLookSave = resolve));
            }
          }
          if (message.type === 'tabernacle:getSettings' && window.failSettingsRead)
            return { ok: false, error: 'Settings unavailable' };
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
            const data = await (
              await ready
            ).request({ ...message, type: message.type.slice('tabernacle:'.length) });
            if (message.type === 'tabernacle:getSettings' && window.holdSettingsRead) {
              window.holdSettingsRead = false;
              await new Promise((resolve) => (window.releaseSettingsRead = resolve));
            }
            if (message.type === 'tabernacle:setLook' && window.loseLookReply) {
              window.loseLookReply = false;
              return { ok: false, error: 'Connection lost' };
            }
            return { ok: true, data };
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
  await expect(settings.getByRole('link', { name: 'Features', exact: true })).toHaveCount(0);
  for (const section of ['features', 'new-tab']) {
    await settings.evaluate((section) => (location.hash = section), section);
    await expect(settings.locator('#appearance')).toBeVisible();
    await expect(settings.locator('#features')).toBeHidden();
    await expect(settings.locator('#new-tab-fields')).toHaveJSProperty('disabled', true);
    await expect(settings.locator('nav a[aria-current]')).toHaveText('Appearance');
    await settings.reload();
    await expect(settings.locator('#look-color-scheme')).toBeEnabled();
    await expect(settings.locator('#appearance')).toBeVisible();
    await expect(settings.locator('#features')).toBeHidden();
  }
  await expect(settings.getByRole('link', { name: 'Site Enhancements', exact: true })).toHaveCount(
    0,
  );
  await settings.evaluate(() => {
    location.hash = 'site-enhancements';
  });
  await expect(settings.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await expect(settings.locator('#site-enhancements')).toHaveCount(0);
  await expect(settings.locator('#appearance-save, #appearance-reset')).toHaveCount(0);
  const status = settings.locator('#appearance-status');
  const resetPage = settings.locator('#appearance-defaults');
  const resetDialog = settings.getByRole('dialog', {
    name: 'Reset all appearance settings?',
    exact: true,
  });

  const resetAll = async () => {
    await resetPage.click();
    await resetDialog.getByRole('button', { name: 'Reset all', exact: true }).click();
  };

  const resetOption = (key) => settings.locator(`[data-look-default="${key}"]`);
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

  const initialSettings = await send('getSettings');
  const defaults = initialSettings.look;
  await expect(resetPage).toBeDisabled();
  await expect(settings.locator('[data-look-default]:disabled')).toHaveCount(7);
  const lines = settings.getByRole('checkbox', { name: 'Show connecting lines', exact: true });
  const domains = settings.getByRole('checkbox', {
    name: 'Show the domain as a second line',
    exact: true,
  });
  await expect(lines).toBeChecked();
  const size = settings.getByRole('combobox', { name: 'Sidebar size', exact: true });
  await expect(size).toHaveValue('default');
  await expect(size.locator('option:checked')).toHaveText('Compact (default)');
  await size.selectOption('large');
  await expect(page.locator('.tab-row .label').first()).toHaveCSS('font-size', '14px');
  await domains.check();
  await expect(page.locator('.row-detail').first()).toBeVisible();
  await expect(status).toHaveText('All changes saved');
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
  await expect(status).toHaveText('All changes saved');
  await expect(domains).toBeChecked();
  await expect(size).toHaveValue('large');
  const beforeReset = await send('snapshot');
  const beforeCancelWrites = await page.evaluate(() => window.lookWrites.length);
  await resetPage.click();
  await expect(resetDialog).toBeVisible();
  await expect(resetDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await settings.keyboard.press('Escape');
  await expect(resetDialog).toBeHidden();
  await expect(resetPage).toBeFocused();
  await resetPage.click();
  await resetDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(resetDialog).toBeHidden();
  expect(await page.evaluate(() => window.lookWrites.length)).toBe(beforeCancelWrites);
  expect((await send('getSettings')).look).toEqual(beforeReset.look);
  await resetPage.click();
  await settings.evaluate(
    () =>
      new Promise((resolve) => {
        const dialog = document.getElementById('appearance-confirm');
        dialog.addEventListener('close', resolve, { once: true });
        dialog.close('cancel');
        document.getElementById('look-color-scheme').focus();
      }),
  );
  await expect(settings.locator('#look-color-scheme')).toBeFocused();
  await page.evaluate(() => {
    window.failSave = true;
  });
  await resetAll();
  await expect(settings.locator('#appearance-error')).toHaveText('Storage unavailable');
  await expect(status).toHaveText('Changes not saved');
  await expect(domains).not.toBeChecked();
  await expect(size).toHaveValue('default');
  await expect(size).toBeEnabled();
  await expect(page.locator('.tab-row .label').first()).toHaveCSS('font-size', '14px');
  await expect(page.locator('.row-detail').first()).toBeVisible();
  await page.evaluate(() => {
    window.failSave = false;
  });
  await settings.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toHaveText('All changes saved');
  await expect(page.locator('.tab-row .label').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.row-detail')).toHaveCount(0);
  expect((await send('getSettings')).look).toEqual(defaults);
  expect((await send('getSettings')).newTab).toEqual(initialSettings.newTab);
  const afterReset = await send('snapshot');
  expect(afterReset.groups).toEqual(beforeReset.groups);
  expect(afterReset.tabs).toEqual(beforeReset.tabs);
  expect(afterReset.view).toEqual(beforeReset.view);

  const alternatives = {
    colorScheme: 'dark',
    sidebarSize: 'large',
    tintFavicons: true,
    animations: false,
    connectingLines: false,
    folderCounts: true,
    domains: true,
  };
  for (const [key, value] of Object.entries(alternatives)) {
    const control = settings.locator(`#appearance-form [name="${key}"]`);
    if (typeof value === 'boolean') await control.setChecked(value);
    else await control.selectOption(value);
    await expect(status).toHaveText('All changes saved');
  }
  await expect(settings.locator('[data-look-default]:enabled')).toHaveCount(7);
  const expected = { ...alternatives };
  for (const key of Object.keys(alternatives)) {
    await expect(resetOption(key)).toHaveAttribute('title', /^Reset to default \(.+\)$/);
    await resetOption(key).focus();
    await settings.keyboard.press('Enter');
    await expect(status).toHaveText('All changes saved');
    expected[key] = defaults[key];
    expect((await send('getSettings')).look).toEqual(expected);
    await expect(resetOption(key)).toBeDisabled();
    await expect(settings.locator(`#appearance-form [name="${key}"]`)).toBeFocused();
  }
  await expect(resetPage).toBeDisabled();
  console.log(
    '✓ Every option saves immediately and resets independently; page reset is atomic and retryable',
  );

  // Returning to the original value must not discard a newer edit while a save is pending.
  await page.evaluate(() => {
    window.holdLookSave = true;
    window.releaseLookSave = null;
  });
  await size.selectOption('large');
  await page.waitForFunction(() => Boolean(window.releaseLookSave));
  await size.selectOption('comfortable');
  await size.selectOption('default');
  await domains.check();
  await resetAll();
  await size.selectOption('comfortable');
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await expect(size).toHaveValue('comfortable');
  await expect(status).toHaveText('Saving…');
  await page.evaluate(() => window.releaseLookSave());
  await expect(status).toHaveText('All changes saved');
  expect((await send('getSettings')).look).toEqual({ ...defaults, sidebarSize: 'comfortable' });
  await expect(page.locator('.tab-row .label').first()).toHaveCSS('font-size', '13px');
  await expect(domains).not.toBeChecked();
  await resetAll();
  await expect(status).toHaveText('All changes saved');

  // Only edited fields are merged with another window's update.
  await page.evaluate(() => {
    window.holdLookSave = true;
    window.releaseLookSave = null;
  });
  await size.selectOption('large');
  await page.waitForFunction(() => Boolean(window.releaseLookSave));
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');
  await page.evaluate(() => window.releaseLookSave());
  await expect(status).toHaveText('All changes saved');
  expect((await send('getSettings')).look).toEqual({
    ...defaults,
    sidebarSize: 'large',
    colorScheme: 'dark',
  });
  await resetAll();
  await expect(status).toHaveText('All changes saved');

  // An older read must not revert a completed save.
  await page.evaluate(() => {
    window.holdSettingsRead = true;
    window.releaseSettingsRead = null;
  });
  await settings.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => Boolean(window.releaseSettingsRead));
  await settings.locator('#look-color-scheme').selectOption('dark');
  await expect(status).toHaveText('All changes saved');
  await page.evaluate(() => window.releaseSettingsRead());
  await settings.waitForTimeout(100);
  await expect(settings.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');

  // Retrying a lost response reapplies the same value without losing other preferences.
  await page.evaluate(() => {
    window.loseLookReply = true;
  });
  await size.selectOption('large');
  await expect(settings.locator('#appearance-error')).toHaveText('Connection lost');
  await expect(page.locator('.tab-row .label').first()).toHaveCSS('font-size', '14px');
  await settings.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toHaveText('All changes saved');
  await settings.reload();
  await expect(size).toHaveValue('large');
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');
  console.log(
    '✓ Rapid edits, queued resets, concurrent windows, stale reads and lost replies preserve the latest choice',
  );

  const writes = await page.evaluate(() => window.lookWrites.length);
  await page.evaluate(() => {
    window.failSettingsRead = true;
  });
  await settings.reload();
  await expect(size).toBeDisabled();
  await expect(settings.locator('#page-error')).toHaveText('Settings unavailable');
  expect(await page.evaluate(() => window.lookWrites.length)).toBe(writes);
  await page.evaluate(() => {
    window.failSettingsRead = false;
  });
  await settings.reload();
  await expect(size).toHaveValue('large');
  await expect(settings.locator('#look-color-scheme')).toHaveValue('dark');
  await settings.screenshot({ path: 'test-results/settings-appearance-dark.png', fullPage: true });
  await settings.locator('#look-color-scheme').selectOption('light');
  await expect(status).toHaveText('All changes saved');
  await settings.screenshot({ path: 'test-results/settings-appearance-light.png', fullPage: true });
  console.log(
    '✓ Automatic saves survive reload; failed initial reads leave storage and defaults untouched',
  );

  const beforeNavigation = await send('getSettings');
  const beforeContainers = await send('getContainers');
  for (const [section, button, dialog, input] of [
    ['containers', 'container-new', 'container-editor', 'Container name'],
  ]) {
    await settings.evaluate(() => (location.hash = 'appearance'));
    await expect(settings.locator('#appearance')).toBeVisible();
    await settings.evaluate((section) => (location.hash = section), section);
    await settings.locator(`#${button}`).click();
    await settings.locator(`#${dialog}`).getByLabel(input, { exact: true }).fill('Unsaved draft');
    await settings.goBack();
    await expect(settings.locator('#appearance')).toBeVisible();
    await expect(settings.locator(`#${dialog}`)).toHaveJSProperty('open', false);
    await expect(settings.locator('#appearance-title')).toBeFocused();
    await settings.getByRole('link', { name: 'About', exact: true }).click();
    await expect(settings.locator('#about')).toBeVisible();
  }
  expect((await send('getSettings')).newTab).toEqual(beforeNavigation.newTab);
  expect(await send('getContainers')).toEqual(beforeContainers);
  await settings.getByRole('link', { name: 'Appearance', exact: true }).click();
  console.log('✓ Browser Back closes idle Settings editors without saving their drafts');

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
  await settings.goBack();
  await expect(settings.locator('#appearance')).toBeVisible();
  await expect(containerEditor).toBeVisible();
  await expect(containerEditor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    window.holdContainerSave = false;
    window.releaseContainerSave();
  });
  await expect(containerEditor.getByRole('alert')).toHaveText('Could not create container');
  await expect(settings.getByLabel('Container name', { exact: true })).toHaveValue('Reading');
  await settings.evaluate(() => (location.hash = 'containers'));
  await expect(settings.locator('#containers')).toBeVisible();
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
    await resetPage.click();
    const box = await resetDialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await resetDialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await settings.screenshot({ path: `test-results/settings-reset-${width}.png` });
    await settings.keyboard.press('Escape');
    await expect(resetPage).toBeFocused();
  }
  await settings.emulateMedia({ forcedColors: 'active' });
  await expect(settings.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await settings.locator('#look-color-scheme').focus();
  await expect(settings.locator('#look-color-scheme')).toBeFocused();
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
