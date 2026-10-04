import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.groupTest = {});
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      testing.api = memoryBrowser({
        events: true,
        groups: [
          { id: 'work', name: 'Work', parentId: null },
          { id: 'design', name: 'Design', parentId: 'work' },
          { id: 'deep', name: 'Deep', parentId: 'design' },
          { id: 'personal', name: 'Personal', parentId: null },
        ],
        tabs: [
          { id: 1, windowId: 1, index: 0, title: 'Work parent', active: true },
          { id: 2, windowId: 1, index: 1, title: 'Work pin', pinned: true },
          { id: 3, windowId: 1, index: 2, title: 'Design tab' },
          { id: 4, windowId: 2, index: 0, title: 'Other window' },
          { id: 5, windowId: 1, index: 3, title: 'Personal tab' },
          { id: 6, windowId: 1, index: 4, title: 'Home tab' },
        ],
        memberships: {
          1: { groupId: 'work', treeId: 'one' },
          2: { groupId: 'work', treeId: 'two', ancestors: ['one'] },
          3: { groupId: 'design' },
          4: { groupId: 'deep' },
          5: { groupId: 'personal' },
          6: { groupId: null },
        },
      });
      const controller = createController(testing.api, (notice) => {
        for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
      });
      testing.send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
      return controller;
    });
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-group-actions-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          const type = message.type.slice('tabernacle:'.length);
          try {
            if (type === 'getGroupContents' && testing.delayCount)
              await new Promise((resolve) => {
                testing.releaseCount = resolve;
              });
            if (type === 'removeGroup' && testing.failDelete) throw new Error('Delete failed');
            if (type === 'moveGroupContents' && testing.failMove) throw new Error('Move failed');
            return { ok: true, data: await (await ready).request({ ...message, type }) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  const work = page.locator('[data-key="group:work"]');
  const dialog = page.getByRole('dialog');
  const remove = page.getByRole('button', { name: 'Delete group', exact: true });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });

  const openDelete = async () => {
    await work.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete group…', exact: true }).click();
  };

  await openDelete();
  await expect(remove).toBeEnabled();
  await expect(dialog).toContainText('2 subgroups');
  await expect(dialog).toContainText('close 4 tabs across all Firefox windows');
  await expect(dialog).toContainText('1 pinned tab');
  await expect(cancel).toBeFocused();
  await cancel.click();
  await openDelete();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(async () => (await groupTest.api.tabs.query({})).length)).toBe(6);
  console.log(
    '✓ Delete confirmation counts nested groups, pins and tabs in other windows; Cancel and Escape preserve them',
  );

  await page.evaluate(() => {
    groupTest.delayCount = true;
  });
  await openDelete();
  await expect(remove).toBeDisabled();
  await page.waitForFunction(() => Boolean(groupTest.releaseCount));
  await cancel.click();
  await work.focus();
  await page.keyboard.press('F2');
  await page.evaluate(() => {
    groupTest.delayCount = false;
    groupTest.releaseCount();
  });
  await expect(dialog).toHaveAccessibleName('Rename group');
  await expect(page.getByLabel('Group name', { exact: true })).toHaveValue('Work');
  await cancel.click();

  await work.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move contents…', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Move group contents');
  await expect(dialog).toContainText('this group stays empty');
  const destination = page.getByLabel('Destination group');
  expect(
    await destination.locator('option').evaluateAll((options) => options.map((o) => o.value)),
  ).toEqual(['', 'personal']);
  await destination.selectOption('personal');
  await page.evaluate(() => {
    groupTest.failMove = true;
  });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Move failed');
  await page.evaluate(() => {
    groupTest.failMove = false;
  });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(work).toBeVisible();
  const state = await page.evaluate(() => groupTest.send('snapshot'));
  expect(state.groups.find((g) => g.id === 'design').parentId).toBe('personal');
  expect(state.groups.find((g) => g.id === 'deep').parentId).toBe('design');
  expect(state.tabs.filter((tab) => tab.groupId === 'work')).toEqual([]);
  expect(state.tabs.find((tab) => tab.id === 2).parentTabId).toBe(1);
  console.log(
    '✓ Move contents excludes invalid destinations, retries errors, and preserves the source group and nested structure',
  );

  await openDelete();
  await expect(dialog).toContainText('close 0 tabs');
  await remove.click();
  await expect(work).toHaveCount(0);
  expect(await page.evaluate(async () => (await groupTest.api.tabs.query({})).length)).toBe(6);

  await page.reload();
  await page.evaluate(() => {
    groupTest.failDelete = true;
  });
  await openDelete();
  await remove.click();
  await expect(page.getByRole('alert')).toHaveText('Delete failed');
  await page.evaluate(() => {
    groupTest.failDelete = false;
  });
  await remove.click();
  await expect(dialog).toBeHidden();
  await expect(work).toHaveCount(0);
  await expect(page.locator('[data-key="group:design"], [data-key="group:deep"]')).toHaveCount(0);
  expect(
    await page.evaluate(async () => (await groupTest.api.tabs.query({})).map((tab) => tab.id)),
  ).toEqual([5, 6]);
  await expect(page.locator('[data-key="tab:5"]')).toBeVisible();
  await expect(page.locator('[data-key="tab:6"]')).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    '✓ Delete removes the complete subtree and its tabs, supports retry, and handles empty groups',
  );
} finally {
  await close();
}
