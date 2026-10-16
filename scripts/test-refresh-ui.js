import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const { page, base, close } = await startUiTest({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript((manifest) => {
    const listeners = new Set();
    const test = (window.refreshTest = {
      hidden: false,
      windowId: 1,
      generation: 'first',
      revision: 1,
      calls: 0,
      inFlight: 0,
      maxInFlight: 0,
      look: {},
    });
    Object.defineProperty(document, 'hidden', { get: () => test.hidden });
    test.notify = (change = {}) => {
      for (const listener of listeners)
        listener({
          type: 'tabernacle:changed',
          generation: test.generation,
          revision: test.revision,
          ...change,
        });
    };
    const ready = import('/preview/demo.js').then(async ({ createDemo }) =>
      (await createDemo()).request({ type: 'snapshot', windowId: 1 }),
    );
    window.browser = {
      windows: { getCurrent: async () => ({ id: test.windowId }) },
      tabs: { getCurrent: async () => ({ id: 100 }) },
      runtime: {
        id: 'refresh-test',
        getManifest: () => manifest,
        onMessage: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },

        sendMessage: async ({ type }) => {
          if (type === 'tabernacle:claimSettingsPage') return { ok: true, data: { tabId: 100 } };
          const state = await ready;
          const data = {
            ...state,
            look: { ...state.look, ...test.look },
            generation: test.generation,
            revision: test.revision,
          };
          test.calls++;
          test.inFlight++;
          test.maxInFlight = Math.max(test.maxInFlight, test.inFlight);
          if (test.hold)
            await new Promise((resolve) => {
              test.release = resolve;
            });
          test.inFlight--;
          return { ok: true, data };
        },
      },
    };
  }, manifest);
  for (const view of ['settings', 'activity']) {
    await page.goto(`${base}/extension/${view}.html`);
    if (view === 'settings') await expect(page.locator('#appearance-fields')).toBeEnabled();
    else await expect(page.locator('#activity-results')).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      refreshTest.calls = 0;
      refreshTest.maxInFlight = 0;
    });
    if (view === 'settings') await page.locator('input[name="domains"]').check();
    await page.evaluate(() => {
      refreshTest.revision++;
      refreshTest.notify({ windowIds: [2] });
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => refreshTest.calls)).toBe(0);
    await page.evaluate(() => {
      refreshTest.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      for (let i = 0; i < 20; i++) {
        refreshTest.revision++;
        refreshTest.notify();
      }
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => refreshTest.calls)).toBe(0);
    await page.evaluate(() => {
      refreshTest.look.folderCounts = true;
      refreshTest.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => refreshTest.calls)).toBe(1);
    if (view === 'settings') {
      await expect(page.locator('input[name="domains"]')).toBeChecked();
      await expect(page.locator('input[name="folderCounts"]')).toBeChecked();
      await expect(page.locator('#appearance-status')).toHaveText('Unsaved changes');
    }
    await page.evaluate(() => {
      refreshTest.calls = 0;
      refreshTest.hold = true;
      refreshTest.revision++;
      refreshTest.notify();
    });
    await page.waitForFunction(() => Boolean(refreshTest.release));
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        refreshTest.revision++;
        refreshTest.notify();
      }
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => refreshTest.calls)).toBe(1);
    await page.evaluate(() => {
      refreshTest.hold = false;
      refreshTest.release();
    });
    await expect.poll(() => page.evaluate(() => refreshTest.calls)).toBe(2);
    expect(await page.evaluate(() => refreshTest.maxInFlight)).toBe(1);
    await page.evaluate(() => {
      refreshTest.calls = 0;
      refreshTest.notify();
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => refreshTest.calls)).toBe(0);
    await page.evaluate(() => {
      refreshTest.generation = 'restarted';
      refreshTest.revision = 0;
      refreshTest.notify();
    });
    await expect.poll(() => page.evaluate(() => refreshTest.calls)).toBe(1);
    if (view === 'settings') {
      await expect(page.locator('input[name="domains"]')).toBeChecked();
      await page.locator('#appearance-reset').click();
    }
    console.log(
      `✓ ${view}: other-window filtering, hidden deferral, single in-flight read, revision deduplication and background restart`,
    );
  }
  expect(errors).toEqual([]);
} finally {
  await close();
}
