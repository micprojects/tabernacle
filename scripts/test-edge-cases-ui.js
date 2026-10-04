import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 360, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const demo = await readFile('preview/demo.js', 'utf8');
  await page.route('**/preview/demo.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: demo
        .replace('memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,')
        .replace(
          'return controller;',
          'window.edgeTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
        ),
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await page.evaluate(() => edgeTest.send('pinTab', { id: 1 }));
  await expect(page.locator('.pinned-tab[data-key="tab:1"]')).toBeVisible();
  await page.locator('[data-key="tab:8"]').dragTo(page.locator('[data-key="tab:2"]'), {
    targetPosition: { x: 60, y: 2 },
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await edgeTest.send('snapshot')).tabs.find((t) => t.id === 8).groupId,
      ),
    )
    .toBe('design');
  expect(
    await page.evaluate(
      async () => (await edgeTest.send('snapshot')).tabs.find((t) => t.id === 8).parentTabId,
    ),
  ).toBe(null);
  await page.evaluate(() => edgeTest.send('pinTab', { id: 1 }));
  await expect(page.locator('.tab-row[data-key="tab:1"]')).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await edgeTest.send('snapshot')).tabs.find((t) => t.id === 8).parentTabId,
    ),
  ).toBe(null);
  console.log(
    '✓ Reordering beside a pinned parent’s exposed children does not adopt the hidden parent',
  );

  await page.goto(`${base}/extension/sidebar.html?demo`);
  const leaf = page.locator('[data-key="tab:2"]');
  await leaf.click({ button: 'right' });
  await expect(page.locator('#menu')).toBeVisible();
  await page.evaluate(() => edgeTest.api.tabs.remove(2));
  await expect(leaf).toHaveCount(0);
  await expect(page.locator('#menu')).toBeHidden();
  console.log('✓ Closing a tab externally dismisses its obsolete context menu');

  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(page.locator('.tab-row')).toHaveCount(6);
  await page.locator('#new-group').click();
  await page.locator('#dialog-input').fill('Retry group');
  await page.evaluate(() => {
    const read = edgeTest.api.sessions.getWindowValue;
    let calls = 0;
    edgeTest.api.sessions.getWindowValue = async (...args) => {
      if (++calls === 2) throw new Error('Response snapshot failed');
      return read(...args);
    };
  });
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#dialog-error')).toContainText('Response snapshot failed');
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (await edgeTest.send('snapshot')).groups.filter((group) => group.name === 'Retry group')
          .length,
    ),
  ).toBe(1);
  console.log('✓ A group-creation retry reuses its original identity after a failed response');
  expect(errors).toEqual([]);
} finally {
  await close();
}
