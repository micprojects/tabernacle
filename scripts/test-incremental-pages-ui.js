import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 1000, height: 760 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  const listeners = new Set();
  const fixture = (window.transportFixture = { replies: [], legacy: false, currentWindow: 1 });

  const notify = () => {
    for (const listener of listeners) listener({ type: 'tabernacle:changed' });
  };

  fixture.ready = Promise.all([
    import('/extension/src/controller.js'),
    import('/extension/src/snapshot-transfer.js'),
    import('/preview/performance-fixture.js'),
  ]).then(async ([{ createController }, { createSnapshotEncoder }, fixtures]) => {
    const f = fixtures.performanceBrowser(fixtures.performanceFixture({ tabs: 100, windows: 2 }));
    fixture.api = f.api;
    fixture.controller = createController(f.api, notify);
    fixture.encoder = createSnapshotEncoder();
    fixture.restart = async () => {
      await fixture.controller.dispose();
      fixture.controller = createController(f.api, notify);
      fixture.encoder = createSnapshotEncoder();
      notify();
    };
    await fixture.controller.request({
      type: 'setNewTab',
      windowId: 1,
      value: { links: [{ id: 'fixture', name: 'Fixture link', url: 'https://example.com/' }] },
    });
  });
  const event = {
    addListener() {},

    removeListener() {},
  };
  window.browser = {
    windows: { getCurrent: async () => ({ id: fixture.currentWindow }) },
    tabs: { getCurrent: async () => ({ id: 1000, windowId: fixture.currentWindow }) },
    permissions: { onAdded: event, onRemoved: event },
    sidebarAction: { open: async () => {} },
    runtime: {
      id: 'incremental-pages-test',
      getURL: (path) => new URL(path, `${location.origin}/extension/`).href,
      onMessage: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },

      sendMessage: async (message) => {
        await fixture.ready;
        const type = message.type.replace('tabernacle:', '');
        const state = await (fixture.controller.requestForTransport ?? fixture.controller.request)({
          ...message,
          type,
        });
        const data =
          message.incremental && !fixture.legacy
            ? fixture.encoder.encode(message.windowId, state, message.snapshotToken)
            : state;
        fixture.replies.push({
          type,
          windowId: message.windowId,
          tabWindowIds: [...new Set(state.tabs?.map((tab) => tab.windowId) || [])],
          incremental: message.incremental,
          full: !data.baseToken,
          changes: data.changes?.length,
          hasPreferences: Boolean((data.state || data).newTab),
        });
        return structuredClone({ ok: true, data });
      },
    },
  };
  fixture.notify = notify;
});

try {
  for (const [path, type] of [
    ['activity.html', 'snapshot'],
    ['new-tab.html', 'getNewTabState'],
  ]) {
    await page.goto(`${base}/extension/${path}`);
    const rows = page.locator(path === 'activity.html' ? '.activity-row' : '#folders .folder');
    await expect(rows.first()).toBeVisible();
    const first = await page.evaluate(() => transportFixture.replies.at(-1));
    expect(first).toMatchObject({ type, incremental: true, full: true });
    if (type === 'getNewTabState') {
      expect(first.hasPreferences).toBe(true);
      await expect(page.locator('#links a')).toHaveText(['Fixture link']);
    }
    await page.evaluate(() => transportFixture.notify());
    await expect
      .poll(() => page.evaluate(() => transportFixture.replies.at(-1)))
      .toMatchObject({
        type,
        full: false,
        changes: 0,
      });
    for (const windowId of [2, 1]) {
      const before = await page.evaluate(() => transportFixture.replies.length);
      await page.evaluate((windowId) => {
        transportFixture.currentWindow = windowId;
        transportFixture.notify();
      }, windowId);
      await expect
        .poll(() =>
          page.evaluate(
            ({ before, type }) =>
              transportFixture.replies.slice(before).find((reply) => reply.type === type),
            { before, type },
          ),
        )
        .toMatchObject({ type, windowId, tabWindowIds: [windowId], full: true });
      const content = page.locator(type === 'snapshot' ? '#activity-results' : '#search-matches');
      if (type === 'getNewTabState')
        await page.getByLabel('Search the web or your tabs', { exact: true }).fill('Fixture 17');
      await expect(content).toContainText(`window ${windowId}`);
      await expect(content).not.toContainText(`window ${windowId === 1 ? 2 : 1}`);
      if (type === 'getNewTabState') {
        await expect(page.locator('#links a')).toHaveText(['Fixture link']);
        await page.getByLabel('Search the web or your tabs', { exact: true }).fill('');
      }
      await page.evaluate(() => transportFixture.notify());
      await expect
        .poll(() => page.evaluate(() => transportFixture.replies.at(-1)))
        .toMatchObject({ type, windowId, tabWindowIds: [windowId], full: false, changes: 0 });
    }
    await page.evaluate(async () => {
      await transportFixture.api.tabs.update(1, { title: 'Updated transport title' });
    });
    await expect
      .poll(() => page.evaluate(() => transportFixture.replies.at(-1)))
      .toMatchObject({
        type,
        full: false,
        changes: 1,
      });
    if (type === 'snapshot')
      await expect(page.locator('#activity-results')).toContainText('Updated transport title');
    else {
      await page
        .getByLabel('Search the web or your tabs', { exact: true })
        .fill('Updated transport title');
      await expect(page.locator('#search-matches')).toContainText('Updated transport title');
      await expect(page.locator('#links a')).toHaveText(['Fixture link']);
    }
    const count = await page.evaluate(() => transportFixture.replies.length);
    await page.evaluate(() => transportFixture.restart());
    await expect
      .poll(() => page.evaluate(() => transportFixture.replies.length))
      .toBeGreaterThan(count);
    expect(await page.evaluate(() => transportFixture.replies.at(-1).full)).toBe(true);
    await expect(rows.first()).toBeVisible();
    for (const legacy of [true, false]) {
      const before = await page.evaluate(() => transportFixture.replies.length);
      await page.evaluate((legacy) => {
        transportFixture.legacy = legacy;
        transportFixture.notify();
      }, legacy);
      await expect
        .poll(() => page.evaluate(() => transportFixture.replies.length))
        .toBeGreaterThan(before);
      expect(await page.evaluate(() => transportFixture.replies.at(-1).full)).toBe(true);
      await expect(rows.first()).toBeVisible();
      if (type === 'getNewTabState')
        await expect(page.locator('#links a')).toHaveText(['Fixture link']);
    }
  }
  expect(errors).toEqual([]);
  console.log(
    '✓ Activity and new-tab incremental reads, window changes, changed titles, preferences, restart and legacy replies',
  );
} finally {
  await close();
}
