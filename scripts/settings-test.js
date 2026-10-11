import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// Connect a real settings document to a sidebar test's browser adapter. Both
// documents use the same controller and receive its normal change events.
export async function prepareSettings(sidebar) {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  await sidebar.context().addInitScript(() => {
    if (window.opener?.browser) window.browser = window.opener.browser;
  });
  await sidebar.evaluate((manifest) => {
    let optionsWindow;
    browser.runtime.getManifest = () => manifest;
    browser.runtime.onMessage.removeListener ??= () => {};
    browser.tabs ??= {};
    browser.tabs.getCurrent = async () => ({ id: 100 });
    const sendMessage = browser.runtime.sendMessage;
    browser.runtime.sendMessage = async (message) => {
      if (message.type === 'tabernacle:claimSettingsPage')
        return { ok: true, data: { tabId: 100 } };
      if (message.type !== 'tabernacle:openPage' || message.page !== 'settings')
        return sendMessage(message);
      if (window.failOpenSettings) return { ok: false, error: 'Settings unavailable' };
      if (optionsWindow && !optionsWindow.closed) optionsWindow.focus();
      else optionsWindow = window.open('settings.html', 'tabernacle-settings');
      return { ok: true, data: { tabId: 100 } };
    };
  }, manifest);
  let settings;
  return async () => {
    const opened = settings ? Promise.resolve(settings) : sidebar.waitForEvent('popup');
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    settings = await opened;
    await expect(settings.locator('#appearance-fields')).toBeEnabled();
    await settings.getByRole('link', { name: 'Appearance', exact: true }).click();
    return settings;
  };
}
