import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const row = (id) => page.locator(`[data-key="tab:${id}"]`);
const displayed = () => page.evaluate(() => closeView.state());
const native = () => page.evaluate(() => tabernacleDemoSession.browser.tabs.query({ windowId: 1 }));
const send = (type, args = {}) =>
  page.evaluate(
    ([type, args]) => closeHarness.request({ type, windowId: 1, ...args }),
    [type, args],
  );
const hierarchy = (state) =>
  state.tabs.map(({ id, treeId, parentTabId, ancestors, order, groupId, collapsed }) => ({
    id,
    treeId,
    parentTabId,
    ancestors,
    order,
    groupId,
    collapsed,
  }));

async function load(mode = 'cancel') {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row(1)).toBeVisible();
  await page.evaluate(async (mode) => {
    const controller = await tabernacleDemoSession.ready;
    const api = tabernacleDemoSession.browser;
    const remove = api.tabs.remove;
    window.closeHarness = { mode, calls: [], request: controller.request.bind(controller) };
    api.tabs.remove = async (ids) => {
      closeHarness.calls.push(ids);
      await new Promise((resolve) => {
        closeHarness.release = resolve;
      });
      delete closeHarness.release;
      if (closeHarness.mode === 'cancel') return;
      if (closeHarness.mode === 'fail') throw new Error('Close failed');
      await remove(ids);
      if (closeHarness.mode === 'lost') throw new Error('Lost close reply');
    };
  }, mode);
}

async function release(mode) {
  await expect.poll(() => page.evaluate(() => Boolean(closeHarness.release))).toBe(true);
  await page.evaluate((mode) => {
    closeHarness.mode = mode;
    closeHarness.release();
  }, mode);
}

try {
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source +
        '\nwindow.closeView = { state: () => structuredClone(state), accept: next => { acceptState(next); render(); } };\n',
    }),
  );

  // The row leaves before Firefox resolves. Stale snapshots cannot bring it back.
  for (const mode of ['cancel', 'fail']) {
    await load(mode);
    const before = await displayed();
    await row(8).locator('.close-tab').click();
    await expect(row(8)).toHaveCount(0);
    expect((await native()).some((tab) => tab.id === 8)).toBe(true);
    await page.evaluate((before) => closeView.accept(before), before);
    await expect(row(8)).toHaveCount(0);
    await release(mode);
    await expect(row(8)).toBeVisible();
    await expect(row(8)).toBeFocused();
    expect(hierarchy(await displayed())).toEqual(hierarchy(before));
    await expect(page.locator('#toast')).toContainText(
      mode === 'cancel' ? 'still open' : 'Close failed',
    );
  }

  // A parent preview uses the controller's exact promotion and rolls back on Cancel.
  await load();
  const before = await displayed();
  await row(1).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  await expect(row(2)).toBeFocused();
  expect((await displayed()).tabs.find((tab) => tab.id === 3).parentTabId).toBe(2);
  expect((await displayed()).tabs.find((tab) => tab.id === 4).parentTabId).toBe(3);
  expect(
    await page
      .locator('#tree .tab-row')
      .evaluateAll((rows) => rows.map((row) => Number(row.dataset.id))),
  ).toEqual([2, 3, 4, 8, 9]);
  await release('cancel');
  await expect(row(1)).toBeVisible();
  expect(hierarchy(await displayed())).toEqual(hierarchy(before));
  await expect(row(1)).toBeFocused();

  // Retry succeeds; Undo restores the durable hierarchy with Firefox's new native ID.
  await row(1).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  const projected = hierarchy(await displayed());
  await release('success');
  await expect.poll(async () => (await native()).some((tab) => tab.id === 1)).toBe(false);
  const committed = await send('snapshot');
  expect(hierarchy(committed)).toEqual(projected);
  const undone = await send('undoCloseTab');
  await expect(row(undone.restoredTabId)).toBeVisible();
  expect(undone.tabs.find((tab) => tab.id === 3).parentTabId).toBe(undone.restoredTabId);
  expect(undone.tabs.find((tab) => tab.id === 4).parentTabId).toBe(3);

  // Two queued closes hide together. Cancelling the first must not undo the second.
  await load();
  const queuedBefore = await displayed();
  await row(1).locator('.close-tab').click();
  await row(2).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  await expect(row(2)).toHaveCount(0);
  await page.evaluate((before) => closeView.accept(before), queuedBefore);
  await expect(row(2)).toHaveCount(0);
  await release('cancel');
  await expect(row(1)).toBeVisible();
  await expect(row(2)).toHaveCount(0);
  await release('success');
  const queued = await send('snapshot');
  expect(queued.tabs.some((tab) => tab.id === 1)).toBe(true);
  expect(queued.tabs.some((tab) => tab.id === 2)).toBe(false);
  expect(queued.tabs.find((tab) => tab.id === 3).parentTabId).toBe(1);
  expect(await page.evaluate(() => closeHarness.calls)).toEqual([1, 2]);

  // A failure after actual removal must not resurrect the closed row or its old tree.
  await load('lost');
  await row(1).locator('.close-tab').click();
  const promoted = hierarchy(await displayed());
  await release('lost');
  await expect(page.locator('#toast')).toContainText('Lost close reply');
  await expect(row(1)).toHaveCount(0);
  expect(hierarchy(await displayed())).toEqual(promoted);

  // An unavailable recovery read restores the last confirmed view, without writing defaults.
  await load('fail');
  const saved = await displayed();
  await page.evaluate(async () => {
    const controller = await tabernacleDemoSession.ready;
    controller.request = (message) =>
      message.type === 'snapshot'
        ? Promise.reject(new Error('Snapshot read failed'))
        : closeHarness.request(message);
  });
  await row(1).locator('.close-tab').click();
  await expect(row(1)).toHaveCount(0);
  await release('fail');
  await expect(row(1)).toBeVisible();
  expect(hierarchy(await displayed())).toEqual(hierarchy(saved));

  // Pins also hide immediately and recover their original slot and keyboard focus.
  await load();
  const pins = (await displayed()).pins;
  await row(11).focus();
  await row(11).click({ button: 'middle' });
  await expect(row(11)).toHaveCount(0);
  await expect(row(12)).toBeFocused();
  await release('cancel');
  await expect(row(11)).toBeVisible();
  await expect(row(11)).toBeFocused();
  expect((await displayed()).pins).toEqual(pins);

  // A failed close must not take focus back from a different control.
  await load('fail');
  await row(8).locator('.close-tab').click();
  await page.locator('#settings').focus();
  await release('fail');
  await expect(row(8)).toBeVisible();
  await expect(page.locator('#settings')).toBeFocused();

  // A virtualised list must close and restore a row at its far end without losing its place.
  await load();
  const target = await page.evaluate(async () => {
    const api = tabernacleDemoSession.browser;
    let tab;
    for (let i = 0; i < 120; i++)
      tab = await api.tabs.create({ url: `https://example.test/pending/${i}`, active: false });
    await closeHarness.request({ type: 'snapshot', windowId: 1 });
    return tab.id;
  });
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  await page.locator('#tree').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(row(target)).toBeVisible();
  const largeBefore = hierarchy(await displayed());
  await row(target).locator('.close-tab').click();
  await expect(row(target)).toHaveCount(0);
  expect((await native()).some((tab) => tab.id === target)).toBe(true);
  await release('cancel');
  await expect(row(target)).toBeVisible();
  await expect(row(target)).toBeFocused();
  expect(hierarchy(await displayed())).toEqual(largeBefore);
  expect(errors).toEqual([]);
  console.log(
    '✓ Immediate closing, stale snapshots, cancellation, failure, retry, nested order, queued closes, lost replies, failed reads, pins and focus',
  );
} finally {
  await close();
}
