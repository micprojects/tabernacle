import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 360, height: 760 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const name = page.getByLabel('Folder name', { exact: true });
const change = page.getByRole('button', { name: 'Change default container' });
const snapshot = () => page.evaluate(() => window.groupCreationTest.send('snapshot'));
const button = (name) => page.getByRole('button', { name, exact: true });

async function chooseDestination(label) {
  await page.getByLabel('Create in', { exact: true }).click();
  await page.getByRole('treeitem', { name: label, exact: true }).click();
}

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.groupCreationTest = {});
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        groups: [
          { id: 'work', name: 'Work', parentId: null, defaultCookieStoreId: 'firefox-container-1' },
        ],
        containers: [
          {
            cookieStoreId: 'firefox-container-1',
            name: 'Work',
            color: 'blue',
            colorCode: '#37adff',
            icon: 'briefcase',
          },
          {
            cookieStoreId: 'firefox-container-2',
            name: 'Personal',
            color: 'green',
            colorCode: '#51cd00',
            icon: 'fingerprint',
          },
        ],
      });
      const query = api.contextualIdentities.query;
      api.contextualIdentities.query = async () => {
        if (testing.failList) throw new Error('Container access is unavailable.');
        return query();
      };
      const create = api.contextualIdentities.create;
      api.contextualIdentities.create = async (...args) => {
        if (testing.failCreate) throw new Error('Firefox refused creation.');
        return create(...args);
      };
      return createController(api, () => {
        for (const listener of listeners) listener({ type: 'tabernacle:changed' });
      });
    });
    testing.send = async (type, args = {}) => (await ready).request({ type, windowId: 1, ...args });
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'group-creation-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          const type = message.type.replace('tabernacle:', '');
          if (type === 'getContainers' && testing.delayList)
            await new Promise((resolve) => {
              testing.finishList = resolve;
            });
          try {
            return { ok: true, data: await (await ready).request({ ...message, type }) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await page.locator('#new-group').click();
  await expect(name).toBeFocused();
  await name.fill('Client project');
  await chooseDestination('Work');
  await expect(page.locator('.group-container-details')).toHaveText('WorkInherited from Work');
  await page.screenshot({ path: 'test-results/group-creation-summary.png' });
  await change.click();
  await button('Personal').click();
  await expect(name).toHaveValue('Client project');
  await expect(page.getByLabel('Create in', { exact: true })).toHaveText('Home / Work');
  await expect(change).toBeFocused();
  await button('Create folder').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  let state = await snapshot();
  expect(state.groups.find((group) => group.name === 'Client project')).toMatchObject({
    parentId: 'work',
    defaultCookieStoreId: 'firefox-container-2',
  });
  console.log(
    '✓ Existing container selection preserves the group name and destination and saves the default',
  );

  await page.locator('#new-group').click();
  await name.fill('Research');
  await chooseDestination('Work');
  await change.click();
  await button('Create new container…').click();
  await expect(page.getByLabel('Container name', { exact: true })).toHaveValue('Research');
  await page.getByLabel('Container name', { exact: true }).fill('Research account');
  await page.getByRole('radio', { name: 'Purple', exact: true }).check();
  await page.getByRole('radio', { name: 'Briefcase', exact: true }).check();
  await page.screenshot({ path: 'test-results/group-creation-container-editor.png' });
  await button('Use this container').click();
  await expect(name).toHaveValue('Research');
  await expect(page.getByLabel('Create in', { exact: true })).toHaveText('Home / Work');
  await expect(page.locator('.group-container-details')).toHaveText(
    'Research accountNew container · ready to create',
  );
  expect((await snapshot()).containers).toHaveLength(2);
  await change.click();
  await button('Edit new container…').click();
  await expect(page.getByRole('radio', { name: 'Purple', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Briefcase', exact: true })).toBeChecked();
  await page.getByLabel('Container name', { exact: true }).fill('Discard this edit');
  await button('Cancel').click();
  await expect(page.locator('.group-container-details .container-name')).toHaveText(
    'Research account',
  );
  await button('Cancel').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await snapshot()).containers).toHaveLength(2);
  expect((await snapshot()).groups.some((group) => group.name === 'Research')).toBe(false);
  console.log(
    '✓ New containers stay drafts; editing and cancelling preserve the group and leave Firefox unchanged',
  );

  await page.locator('#new-group').click();
  await name.fill('Accounts');
  await change.click();
  await button('Create new container…').click();
  await button('← Back to containers').click();
  await expect(page.locator('#dialog-title')).toHaveText('Default container');
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue('Accounts');
  await change.click();
  await button('Create new container…').click();
  await page.getByRole('radio', { name: 'Purple', exact: true }).check();
  await page.getByRole('radio', { name: 'Briefcase', exact: true }).check();
  await button('Use this container').click();
  await page.evaluate(() => {
    window.groupCreationTest.failCreate = true;
  });
  await button('Create folder').click();
  await expect(page.getByRole('alert')).toContainText('Firefox refused');
  await expect(name).toHaveValue('Accounts');
  await expect(change).toBeEnabled();
  await expect(page.locator('.group-container-details .container-name')).toHaveText('Accounts');
  expect((await snapshot()).containers).toHaveLength(2);
  await page.evaluate(() => {
    window.groupCreationTest.failCreate = false;
  });
  await button('Create folder').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  state = await snapshot();
  const identity = state.containers.find((item) => item.name === 'Accounts');
  expect(identity).toMatchObject({ color: 'purple', icon: 'briefcase' });
  expect(state.groups.find((group) => group.name === 'Accounts').defaultCookieStoreId).toBe(
    identity.cookieStoreId,
  );
  console.log(
    '✓ Back and Escape return to the right step; failed creation keeps the draft for a successful retry',
  );

  await page.locator('#new-group').click();
  await name.fill('Unavailable selection');
  await change.click();
  await button('Personal').click();
  await page.evaluate(() =>
    window.groupCreationTest.send('removeContainer', { cookieStoreId: 'firefox-container-2' }),
  );
  await button('Create folder').click();
  await expect(page.getByRole('alert')).toContainText('no longer exists');
  await change.click();
  await button('No container').click();
  await button('Create folder').click();
  state = await snapshot();
  expect(
    state.groups.find((group) => group.name === 'Unavailable selection').defaultCookieStoreId,
  ).toBe('firefox-default');

  await page.locator('#new-group').click();
  await name.fill('No access');
  await page.evaluate(() => {
    window.groupCreationTest.failList = true;
  });
  await change.click();
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(button('Create new container…')).toBeDisabled();
  await button('No container').click();
  await button('Create folder').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.evaluate(() => {
    window.groupCreationTest.failList = false;
  });
  console.log(
    '✓ Missing containers and disabled container access allow recovery without losing the group',
  );

  await page.setViewportSize({ width: 270, height: 600 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#new-group').click();
  await name.fill('A longer client folder name');
  await chooseDestination('Work');
  await change.click();
  await button('Create new container…').click();
  expect(
    await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/group-creation-editor-dark-narrow.png' });
  await button('Use this container').click();
  expect(
    await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/group-creation-summary-dark-narrow.png' });
  await page.evaluate(() => {
    window.groupCreationTest.delayList = true;
  });
  await change.click();
  await button('← Back to folder').click();
  await page.evaluate(() => {
    window.groupCreationTest.delayList = false;
    window.groupCreationTest.finishList();
  });
  await expect(page.locator('#dialog-title')).toHaveText('New folder');
  await expect(name).toHaveValue('A longer client folder name');
  await button('Cancel').click();
  await page.locator('#new-group').click();
  await expect(name).toHaveValue('');
  await expect(page.locator('.group-container-note')).toContainText('Inherited');
  await button('Cancel').click();
  expect(errors).toEqual([]);
  console.log(
    '✓ Narrow dark dialogs fit, late list responses cannot replace the group form, and new drafts reset',
  );
} catch (error) {
  await page.screenshot({ path: 'test-results/group-creation-failure.png' });
  throw error;
} finally {
  await close();
}
