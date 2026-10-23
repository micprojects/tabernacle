import { instrumentSource } from '../helpers/probes/incremental-pages.js';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, base, close } = await startUiTest({ viewport: { width: 1000, height: 760 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
for (const name of ['activity-page', 'new-tab-page']) {
  const source = await readFile('extension/src/' + name + '.js', 'utf8');
  await page.route('**/extension/src/' + name + '.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: instrumentSource(source),
    }),
  );
}

await page.addInitScript(() => {
  const listeners = new Set();
  const fixture = (window.transportFixture = { replies: [], legacy: false, currentWindow: 1 });
  const delayed = new Set();
  fixture.storageCalls = [];

  const startupDelay = async (stage) => {
    if (new URLSearchParams(location.search).get('delay-start') !== stage || delayed.has(stage))
      return;
    delayed.add(stage);
    fixture.startedStage = stage;
    await new Promise((resolve, reject) => {
      fixture.releaseStart = (fail) =>
        fail ? reject(new Error('Late startup failure')) : resolve();
    });
  };

  const current = async () => {
    await startupDelay('current');
    return { id: 1000, windowId: fixture.currentWindow };
  };

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
  const addedPermissions = new Set();
  const removedPermissions = new Set();
  const event = (values) => ({
    addListener: (listener) => values.add(listener),
    removeListener: (listener) => values.delete(listener),
  });
  fixture.listenerCounts = () => ({
    messages: listeners.size,
    added: addedPermissions.size,
    removed: removedPermissions.size,
  });
  window.browser = {
    windows: {
      getCurrent: async () => {
        await current();
        return { id: fixture.currentWindow };
      },
    },
    tabs: { getCurrent: current },
    permissions: { onAdded: event(addedPermissions), onRemoved: event(removedPermissions) },
    storage: {
      session: {
        async get(key) {
          fixture.storageCalls.push({ type: 'get', key });
          await startupDelay('preview-get');
          return {
            [key]: {
              links: [
                { id: 'preview-fixture', name: 'Preview fixture', url: 'https://example.com/' },
              ],
            },
          };
        },

        async remove(key) {
          fixture.storageCalls.push({ type: 'remove', key });
          await startupDelay('preview-remove');
        },
      },
    },
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
    // Releasing an unselected page must also release its reader base. A selected
    // page keeps both until its normal visible refresh preserves native Find.
    await page.evaluate(() => {
      transportFixture.hidden = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => transportFixture.hidden,
      });
    });
    for (const selected of [false, true]) {
      const rowCount = await rows.count();
      const before = await page.evaluate(() => transportFixture.replies.length);
      const selectedText = await page.evaluate(
        ({ selected, selector }) => {
          getSelection().removeAllRanges();
          if (selected) {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector(selector));
            getSelection().addRange(range);
          }
          const text = getSelection().toString();
          transportFixture.hidden = true;
          document.dispatchEvent(new Event('visibilitychange'));
          transportFixture.notify();
          return text;
        },
        { selected, selector: path === 'activity.html' ? '.activity-row' : '#folders .folder' },
      );
      await expect(rows).toHaveCount(selected ? rowCount : 0);
      if (selected) {
        expect(selectedText.length).toBeGreaterThan(0);
        expect(await page.evaluate(() => getSelection().toString())).toBe(selectedText);
      }
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => transportFixture.replies.length)).toBe(before);
      await page.evaluate(() => {
        transportFixture.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect
        .poll(() => page.evaluate(() => transportFixture.replies.length))
        .toBeGreaterThan(before);
      expect(await page.evaluate(() => transportFixture.replies.at(-1).full)).toBe(!selected);
      await expect(rows).toHaveCount(rowCount);
      await page.evaluate(() => getSelection().removeAllRanges());
    }
  }
  for (const [path, stage, fail] of [
    ['activity.html', 'current', false],
    ['activity.html', 'current', true],
    ['new-tab.html', 'current', false],
    ['new-tab.html', 'current', true],
    ['new-tab.html', 'preview-get', false],
    ['new-tab.html', 'preview-remove', false],
  ]) {
    await page.goto(`${base}/extension/${path}?delay-start=${stage}&preview=fixture&start=1`);
    await page.waitForFunction(() => Boolean(transportFixture.releaseStart));
    const after = await page.evaluate(async (fail) => {
      window.dispatchEvent(new Event('pagehide'));
      transportFixture.releaseStart(fail);
      await pageStartDone;
      return {
        ...pageStartProbe(),
        listeners: transportFixture.listenerCounts(),
        replies: transportFixture.replies.length,
        storage: transportFixture.storageCalls,
        preview: JSON.parse(sessionStorage.getItem('tabernacle.newTabPreview') || 'null'),
        lateError: document.body.textContent.includes('Late startup failure'),
      };
    }, fail);
    expect(after.disposed).toBe(true);
    expect(after.retainedState).toBe(false);
    expect(after.reader).toBe(stage !== 'current');
    expect(after.listeners).toEqual({ messages: 0, added: 0, removed: 0 });
    expect(after.replies).toBe(0);
    expect(after.lateError).toBe(false);
    expect(after.storage).toEqual(
      stage === 'current'
        ? []
        : [
            { type: 'get', key: 'tabernacle.newTabPreview.fixture' },
            { type: 'remove', key: 'tabernacle.newTabPreview.fixture' },
          ],
    );
    if (stage !== 'current') expect(after.preview.links[0].id).toBe('preview-fixture');
  }
  console.log(
    '✓ Late Activity/new-tab startup cannot register listeners or render errors after disposal; already-read preview tokens still finish consumption',
  );
  expect(errors).toEqual([]);
  console.log(
    '✓ Activity and new-tab incremental reads, window changes, changed titles, preferences, restart and legacy replies',
  );
} finally {
  await close();
}
