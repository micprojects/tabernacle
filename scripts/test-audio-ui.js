import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { server, page, close } = await startUiTest({
  viewport: { width: 320, height: 660 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let checks = 0;

const check = (message) => {
  checks++;
  console.log(`✓ ${message}`);
};

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.audioTest = {});

    const notify = () => {
      for (const fn of listeners) fn({ type: 'tabernacle:changed' });
    };

    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        groups: [
          { id: 'work', name: 'Work', parentId: null },
          { id: 'media', name: 'Media', parentId: 'work' },
          { id: 'personal', name: 'Personal', parentId: null },
        ],
        tabs: [
          { id: 1, windowId: 1, index: 0, title: 'Parent page', active: true },
          { id: 2, windowId: 1, index: 1, title: 'Video player', audible: true },
          {
            id: 3,
            windowId: 1,
            index: 2,
            title: 'Music player',
            audible: true,
            mutedInfo: { muted: true },
          },
          { id: 4, windowId: 1, index: 3, title: 'Pinned radio', audible: true, pinned: true },
          { id: 5, windowId: 1, index: 4, title: 'Quiet notes' },
          { id: 6, windowId: 2, index: 0, title: 'Other window audio', audible: true },
        ].map((tab) => ({ url: `https://example.com/${tab.id}`, ...tab })),
        memberships: {
          1: { groupId: 'media', treeId: 'parent', ancestors: [] },
          2: { groupId: 'media', treeId: 'child', ancestors: ['parent'] },
          3: { groupId: 'media', treeId: 'grandchild', ancestors: ['child', 'parent'] },
          4: { groupId: 'media', treeId: 'pin', ancestors: ['parent'] },
          5: { groupId: 'media', treeId: 'notes', ancestors: [] },
          6: { groupId: 'media', treeId: 'other', ancestors: [] },
        },
      });
      testing.update = async (id, props) => {
        await api.tabs.update(id, props);
        notify();
      };
      return createController(api, notify);
    });
    testing.send = async (type, args = {}) => (await ready).request({ type, windowId: 1, ...args });
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-audio-test',
        onMessage: { addListener: (fn) => listeners.add(fn) },

        sendMessage: async (message) => {
          try {
            return {
              ok: true,
              data: await testing.send(message.type.replace('tabernacle:', ''), {
                ...message,
                type: message.type.replace('tabernacle:', ''),
              }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/extension/sidebar.html`);
  const work = page.locator('[data-key="group:work"]');
  const media = page.locator('[data-key="group:media"]');
  const personal = page.locator('[data-key="group:personal"]');
  const parent = page.locator('[data-key="tab:1"]');
  const child = page.locator('[data-key="tab:2"]');
  const grandchild = page.locator('[data-key="tab:3"]');
  const pin = page.locator('.pinned-tab');
  await expect(work.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '2 tabs playing audio in this group',
  );
  await expect(media.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '2 tabs playing audio in this group',
  );
  await expect(parent.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '2 tabs playing audio in this tab’s children',
  );
  await expect(child.getByRole('button', { name: 'Mute tab', exact: true })).toBeVisible();
  await expect(grandchild.getByRole('button', { name: 'Unmute tab', exact: true })).toBeVisible();
  await expect(pin.locator('.audio-indicator')).toHaveAttribute(
    'title',
    'This tab is playing audio',
  );
  await expect(personal.locator('.audio-indicator')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/audio-expanded.png' });
  check(
    'Audio reaches group and tab ancestors, including pins, without counting muted or other-window tabs',
  );

  await parent.getByRole('button', { name: 'Collapse child tabs of Parent page' }).click();
  await expect(child).toHaveCount(0);
  await expect(parent.locator('.audio-indicator')).toBeVisible();
  await work.getByRole('button', { name: 'Collapse Work', exact: true }).click();
  await expect(parent).toHaveCount(0);
  await expect(work.locator('.audio-indicator')).toBeVisible();
  await page.evaluate(() => window.audioTest.update(2, { audible: false }));
  await expect(work.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this group',
  );
  await pin.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute tab', exact: true }).click();
  await expect(work.locator('.audio-indicator')).toHaveCount(0);
  await expect(pin.locator('.audio-indicator')).toHaveAttribute('title', 'This tab is muted');
  check('Collapsed groups update as audio stops or pins are muted');

  await page.evaluate(() => window.audioTest.update(3, { muted: false }));
  await expect(work.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this group',
  );
  await work.getByRole('button', { name: 'Expand Work', exact: true }).click();
  await parent.getByRole('button', { name: 'Expand child tabs of Parent page' }).click();
  await expect(child.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this tab’s children',
  );
  await page.evaluate(() => window.audioTest.update(1, { audible: true }));
  await expect(parent.getByRole('button', { name: 'Mute tab', exact: true })).toBeVisible();
  await expect(parent.locator('.audio-indicator')).toHaveCount(0);
  await parent.getByRole('button', { name: 'Mute tab', exact: true }).click();
  await expect(parent.getByRole('button', { name: 'Unmute tab', exact: true })).toBeVisible();
  await expect(parent.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this tab’s children',
  );
  await expect(grandchild.getByRole('button', { name: 'Mute tab', exact: true })).toBeVisible();
  await page.mouse.move(2, 2);
  await parent.hover();
  await expect(page.locator('.preview-audio')).toHaveText(
    'This tab is muted · 1 tab playing audio in this tab’s children',
  );
  await page.keyboard.press('Escape');
  check(
    'Muting a parent affects only that page; child audio stays visible and the hover card explains both states',
  );

  await page.locator('#search-toggle').click();
  await page.getByRole('searchbox').fill('Quiet notes');
  await expect(parent).toHaveCount(0);
  await expect(media.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this group',
  );
  await page.keyboard.press('Escape');
  await media.dblclick();
  await expect(page.locator('#scope-heading .audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this group',
  );
  await page.locator('#home').click();
  check('Group audio survives search filtering and is shown in the focused group heading');

  await page.evaluate(async () => {
    await window.audioTest.send('moveTab', { id: 3, groupId: 'personal' });
  });
  await expect(media.locator('.audio-indicator')).toHaveCount(0);
  await expect(work.locator('.audio-indicator')).toHaveCount(0);
  await expect(personal.locator('.audio-indicator')).toHaveAttribute(
    'title',
    '1 tab playing audio in this group',
  );
  await expect(parent.locator('.audio-indicator')).toHaveCount(0);
  await page.evaluate(() => window.audioTest.send('closeTab', { id: 3 }));
  await expect(personal.locator('.audio-indicator')).toHaveCount(0);
  check('Moving and closing a playing tab updates the old and new groups immediately');

  await page.evaluate(async () => {
    await window.audioTest.update(2, { audible: true });
    await window.audioTest.update(4, { muted: false });
  });
  await page.setViewportSize({ width: 240, height: 540 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(pin.locator('.audio-indicator')).toBeVisible();
  await expect(pin.locator('button')).toHaveCount(0);
  expect(
    await page.locator('.sidebar').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/audio-dark-narrow.png' });
  expect(errors).toEqual([]);
  check('Indicators fit compact dark sidebars and pinned buttons retain valid accessible markup');
  console.log(`${checks} audio UI checks passed.`);
} catch (error) {
  await page.screenshot({ path: 'test-results/audio-failure.png' });
  throw error;
} finally {
  await close();
}
