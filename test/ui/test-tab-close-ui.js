import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.closeTreeTest = { calls: [], delay: false });
    testing.notify = (change) => {
      for (const listener of listeners) listener({ type: 'tabernacle:changed', ...change });
    };
    let ready;
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-close-test',
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:closeTabTree') {
            testing.calls.push({ id: message.id, tabIds: [...message.tabIds] });
            if (testing.delay)
              await new Promise((resolve) => {
                testing.resume = resolve;
              });
            if (window.failClose)
              return { ok: false, error: 'Firefox could not close these tabs.' };
          }
          ready ??= import('/preview/demo.js').then(({ createDemo }) => createDemo());
          return {
            ok: true,
            data: await (
              await ready
            ).request({
              ...message,
              type: message.type.slice('tabernacle:'.length),
            }),
          };
        },
      },
    };
  });
  const load = () => page.goto(`${base}/extension/sidebar.html`);
  await load();
  const parent = page.locator('[data-key="tab:1"]');
  const dialog = page.getByRole('dialog', { name: 'Close tab and nested tabs?', exact: true });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  const confirm = page.getByRole('button', { name: 'Close 4 tabs', exact: true });
  const snapshot = async () =>
    page.evaluate(
      async () =>
        (await window.browser.runtime.sendMessage({ type: 'tabernacle:snapshot', windowId: 1 }))
          .data,
    );

  const closeBranch = async () => {
    await parent.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Close tab', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Close tab and nested tabs…', exact: true }).click();
  };

  await closeBranch();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#dialog-description')).toContainText(
    '“Figma — Website” and its 3 nested tabs',
  );
  await expect(cancel).toBeFocused();
  await page.screenshot({ path: 'test-results/close-nested-tabs.png' });
  await cancel.click();
  expect((await snapshot()).tabs).toHaveLength(17);

  // Hidden descendants are included; Escape leaves the collapsed branch intact.
  await parent.locator('.tab-disclosure').click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab and nested tabs…', exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await snapshot()).tabs).toHaveLength(17);
  await expect(parent).toHaveAttribute('aria-expanded', 'false');

  // Leaves still close immediately, without a dialog.
  await page.locator('[data-key="tab:8"] .close-tab').click();
  await expect(page.locator('[data-key="tab:8"]')).toHaveCount(0);
  await expect(dialog).toBeHidden();

  await page.evaluate(() => {
    window.failClose = true;
  });
  await closeBranch();
  await confirm.click();
  await expect(page.locator('#dialog-error')).toHaveText('Firefox could not close these tabs.');
  expect((await snapshot()).tabs).toHaveLength(16);
  await page.evaluate(() => {
    window.failClose = false;
  });
  await confirm.click();
  await expect(dialog).toBeHidden();
  const remaining = (await snapshot()).tabs.map((tab) => tab.id);
  expect(remaining).toHaveLength(12);
  for (const id of [1, 2, 3, 4]) expect(remaining).not.toContain(id);
  await expect(page.locator('[data-key="group:design"]')).toBeVisible();

  // A live refresh must not change the opening confirmation, including on retry.
  await load();
  await closeBranch();
  const openingDescription = await page.locator('#dialog-description').textContent();
  await expect(cancel).toBeFocused();
  const newChildId = await page.evaluate(async () => {
    const send = (type, args = {}) =>
      window.browser.runtime.sendMessage({ type: `tabernacle:${type}`, windowId: 1, ...args });
    const before = (await send('snapshot')).data.tabs.map((tab) => tab.id);
    await send('closeTab', { id: 4 });
    const { data } = await send('newChildTab', { id: 1 });
    window.closeTreeTest.notify({ generation: data.generation, revision: data.revision });
    return data.tabs.find((tab) => !before.includes(tab.id)).id;
  });
  await expect(page.locator('[data-key="tab:4"]')).toHaveCount(0);
  await expect(page.locator(`[data-key="tab:${newChildId}"]`)).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#dialog-description')).toHaveText(openingDescription);
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeEnabled();
  const refreshedIds = (await snapshot()).tabs.map((tab) => tab.id);
  expect(refreshedIds).toContain(8);
  expect(refreshedIds).not.toContain(4);
  await page.evaluate(() => {
    window.failClose = true;
    window.closeTreeTest.delay = true;
  });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(page.locator('#dialog-error')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const openingRequest = { id: 1, tabIds: [1, 2, 3, 4] };
  expect(await page.evaluate(() => window.closeTreeTest.calls)).toEqual([openingRequest]);
  await page.evaluate(() => {
    window.closeTreeTest.delay = false;
    const resume = window.closeTreeTest.resume;
    delete window.closeTreeTest.resume;
    resume();
  });
  await expect(page.locator('#dialog-error')).toHaveText('Firefox could not close these tabs.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expect(page.locator('#dialog-description')).toHaveText(openingDescription);
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(refreshedIds);
  await page.evaluate(() => {
    window.failClose = false;
  });
  await confirm.click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.closeTreeTest.calls)).toEqual([
    openingRequest,
    openingRequest,
  ]);
  const refreshedRemaining = await snapshot();
  expect(refreshedRemaining.tabs.map((tab) => tab.id)).toEqual(
    refreshedIds.filter((id) => !openingRequest.tabIds.includes(id)),
  );
  expect(refreshedRemaining.tabs.find((tab) => tab.id === newChildId).parentTabId).toBe(null);

  // Every single-tab affordance preserves children, even in collapsed branches.
  for (const method of ['middle', 'button', 'menu']) {
    for (const collapsed of [false, true]) {
      await load();
      if (collapsed) await parent.locator('.tab-disclosure').click();
      if (method === 'middle') await parent.click({ button: 'middle' });
      else if (method === 'button') await parent.locator('.close-tab').click();
      else {
        await parent.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Close tab', exact: true }).click();
      }
      await expect(parent).toHaveCount(0);
      await expect(dialog).toBeHidden();
      const state = await snapshot();
      expect(state.tabs).toHaveLength(16);
      expect(state.tabs.find((tab) => tab.id === 2).parentTabId).toBe(null);
      expect(state.tabs.find((tab) => tab.id === 3).parentTabId).toBe(2);
      expect(state.tabs.find((tab) => tab.id === 4).parentTabId).toBe(3);
      await expect(page.locator('[data-key="tab:2"]')).toBeVisible();
      await expect(page.locator('[data-key="tab:3"]')).toBeVisible();
    }
  }

  // Middle-clicking a pin also preserves its children in their folder.
  await load();
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  const pin = page.locator('.pinned-tab[data-key="tab:1"]');
  await pin.click({ button: 'middle' });
  await expect(pin).toHaveCount(0);
  await expect(dialog).toBeHidden();
  expect((await snapshot()).tabs).toHaveLength(16);
  expect((await snapshot()).tabs.find((tab) => tab.id === 3).parentTabId).toBe(2);

  // The explicit branch action still confirms and includes the pinned parent.
  await load();
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  await pin.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab and nested tabs…', exact: true }).click();
  await expect(page.locator('#dialog-description')).toContainText('1 pinned tab');
  await confirm.click();
  await expect(pin).toHaveCount(0);
  expect((await snapshot()).tabs).toHaveLength(13);
  expect(errors).toEqual([]);
  console.log(
    '✓ Close button, menu and middle click promote the first child; the separate branch action confirms every depth and supports retry, including collapsed branches and pins',
  );
} finally {
  await close();
}
