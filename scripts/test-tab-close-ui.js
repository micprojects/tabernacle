import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.addInitScript(() => {
    let ready;
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-close-test',
        onMessage: { addListener() {} },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:closeTabTree' && window.failClose)
            return { ok: false, error: 'Firefox could not close these tabs.' };
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

  await parent.locator('.close-tab').click();
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
  await parent.locator('.close-tab').click();
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

  // Pinned parents use the same confirmation, including their hidden tree.
  await load();
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  const pin = page.locator('.pinned-tab[data-key="tab:1"]');
  await pin.click({ button: 'middle' });
  await expect(page.locator('#dialog-description')).toContainText('1 pinned tab');
  await confirm.click();
  await expect(pin).toHaveCount(0);
  expect((await snapshot()).tabs).toHaveLength(13);
  expect(errors).toEqual([]);
  console.log(
    '✓ Parent close confirms every depth, supports Cancel/Escape and retry, includes pins, and leaves unrelated tabs open',
  );
} finally {
  await close();
}
