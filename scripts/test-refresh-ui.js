import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const { page, base, close } = await startUiTest({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  for (const view of ['activity', 'new-tab']) {
    const source = await readFile('extension/src/' + view + '-page.js', 'utf8');
    await page.route('**/extension/src/' + view + '-page.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body:
          source +
          '\nwindow.retainedViewTabs = () => state?.tabs?.length || 0;\nwindow.retainedViewRevision = () => state?.revision;',
      }),
    );
  }
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
    const ready = import('/preview/demo.js').then(async ({ createDemo }) => {
      const state = await (await createDemo()).request({ type: 'snapshot', windowId: 1 });
      const now = Date.now();
      return {
        ...state,
        tabs: state.tabs.map((tab, index) => ({ ...tab, lastAccessed: now - index * 1000 })),
      };
    });
    window.browser = {
      windows: { getCurrent: async () => ({ id: test.windowId }) },
      tabs: { getCurrent: async () => ({ id: 100, windowId: test.windowId }) },
      permissions: {
        onAdded: {
          addListener() {},

          removeListener() {},
        },
        onRemoved: {
          addListener() {},

          removeListener() {},
        },
      },
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
  for (const view of ['settings', 'activity', 'new-tab']) {
    await page.goto(`${base}/extension/${view}.html`);
    if (view === 'settings') await expect(page.locator('#appearance-fields')).toBeEnabled();
    else if (view === 'activity')
      await expect(page.locator('#activity-results')).toHaveAttribute('aria-busy', 'false');
    else await expect(page.locator('#loading')).toBeHidden();
    const rows = view === 'activity' ? '.item-button' : '#new-tab-content [data-key]';
    if (view !== 'settings') await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0);
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
    if (view !== 'settings') {
      await expect(page.locator(rows)).toHaveCount(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
    }
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
    } else {
      // A response dispatched before hiding must not repopulate released rows/state.
      await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0);
      await page.evaluate(() => {
        refreshTest.release = null;
        refreshTest.hold = true;
        refreshTest.revision++;
        refreshTest.notify();
      });
      await page.waitForFunction(() => Boolean(refreshTest.release));
      await page.evaluate(() => {
        refreshTest.hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        refreshTest.hold = false;
        refreshTest.release();
      });
      await expect.poll(() => page.evaluate(() => refreshTest.inFlight)).toBe(0);
      await page.waitForTimeout(100);
      await expect(page.locator(rows)).toHaveCount(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
      await page.evaluate(() => {
        refreshTest.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBeGreaterThan(0);
      // A quick hide/show also rejects the old response while a fresh read is pending.
      await page.evaluate(() => {
        refreshTest.release = null;
        refreshTest.hold = true;
        refreshTest.revision++;
        refreshTest.notify();
      });
      await page.waitForFunction(() => Boolean(refreshTest.release));
      await page.evaluate(() => {
        refreshTest.hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        refreshTest.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        const release = refreshTest.release;
        refreshTest.release = null;
        release();
      });
      await page.waitForFunction(() => Boolean(refreshTest.release));
      await expect(page.locator(rows)).toHaveCount(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
      await page.evaluate(() => {
        refreshTest.hold = false;
        refreshTest.release();
      });
      await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0);
    }
    if (view === 'activity') {
      // Retain native Find/user selections without retaining ordinary hidden pages.
      for (const selectionKind of ['row', 'cross-row']) {
        const selected = await page.evaluate((selectionKind) => {
          const titles = document.querySelectorAll('.item-title');
          const range = document.createRange();
          range.setStart(titles[0].firstChild, 0);
          const last = titles[selectionKind === 'cross-row' ? 1 : 0];
          range.setEnd(last.firstChild, last.firstChild.length);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          window.selectionRetainedRow = document.querySelector('.item-button');
          return {
            text: getSelection().toString(),
            rows: document.querySelectorAll('.item-button').length,
            tabs: retainedViewTabs(),
            revision: retainedViewRevision(),
          };
        }, selectionKind);
        expect(selected.text.length).toBeGreaterThan(0);
        await page.evaluate(() => {
          refreshTest.calls = 0;
          refreshTest.release = null;
          refreshTest.hold = true;
          refreshTest.revision++;
          refreshTest.notify();
        });
        await page.waitForFunction(() => Boolean(refreshTest.release));
        await page.evaluate(() => {
          refreshTest.hidden = true;
          document.dispatchEvent(new Event('visibilitychange'));
          for (let i = 0; i < 20; i++) {
            refreshTest.revision++;
            refreshTest.notify();
          }
          refreshTest.hold = false;
          refreshTest.release();
        });
        await expect.poll(() => page.evaluate(() => refreshTest.inFlight)).toBe(0);
        await page.waitForTimeout(100);
        await expect(page.locator('.item-button')).toHaveCount(selected.rows);
        expect(await page.evaluate(() => retainedViewTabs())).toBe(selected.tabs);
        // Even the retained page must reject responses dispatched before hiding.
        expect(await page.evaluate(() => retainedViewRevision())).toBe(selected.revision);
        expect(await page.evaluate(() => refreshTest.calls)).toBe(1);
        expect(await page.evaluate(() => getSelection().toString())).toBe(selected.text);
        await page.evaluate(() => {
          refreshTest.hidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(() => page.evaluate(() => refreshTest.calls)).toBe(2);
        await expect
          .poll(() => page.evaluate(() => retainedViewRevision() === refreshTest.revision))
          .toBe(true);
        expect(await page.evaluate(() => getSelection().toString())).toBe(selected.text);
        expect(
          await page.evaluate(
            () => selectionRetainedRow === document.querySelector('.item-button'),
          ),
        ).toBe(true);
        await page.evaluate(() => {
          getSelection().removeAllRanges();
          delete window.selectionRetainedRow;
        });
      }
      // A caret or selection outside the results does not prevent release.
      for (const selectionKind of ['collapsed', 'outside']) {
        await page.evaluate((selectionKind) => {
          const range = document.createRange();
          range.selectNodeContents(
            document.querySelector(selectionKind === 'outside' ? 'h1' : '.item-title'),
          );
          if (selectionKind === 'collapsed') range.collapse(true);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          refreshTest.hidden = true;
          document.dispatchEvent(new Event('visibilitychange'));
        }, selectionKind);
        await expect(page.locator('.item-button')).toHaveCount(0);
        expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
        await page.evaluate(() => {
          getSelection().removeAllRanges();
          refreshTest.hidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(() => page.locator('.item-button').count()).toBeGreaterThan(0);
      }
      // Closing the document always releases derived state, including selected rows.
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.item-title'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.dispatchEvent(new Event('pagehide'));
      });
      await expect(page.locator('.item-button')).toHaveCount(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
      console.log('✓ Activity selection retention, hidden response rejection and disposal');
    }
    if (view === 'new-tab') {
      const selected = await page.evaluate(() => {
        const row = document.querySelector('#new-tab-content [data-key]');
        const range = document.createRange();
        range.selectNodeContents(row);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return {
          text: getSelection().toString(),
          rows: document.querySelectorAll('#new-tab-content [data-key]').length,
          tabs: retainedViewTabs(),
          revision: retainedViewRevision(),
        };
      });
      expect(selected.text.length).toBeGreaterThan(0);
      await page.evaluate(() => {
        refreshTest.release = null;
        refreshTest.hold = true;
        refreshTest.revision++;
        refreshTest.notify();
      });
      await page.waitForFunction(() => Boolean(refreshTest.release));
      await page.evaluate(() => {
        refreshTest.hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        refreshTest.hold = false;
        refreshTest.release();
      });
      await expect.poll(() => page.evaluate(() => refreshTest.inFlight)).toBe(0);
      await expect(page.locator(rows)).toHaveCount(selected.rows);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(selected.tabs);
      expect(await page.evaluate(() => retainedViewRevision())).toBe(selected.revision);
      expect(await page.evaluate(() => getSelection().toString())).toBe(selected.text);
      await page.evaluate(() => {
        refreshTest.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect
        .poll(() => page.evaluate(() => retainedViewRevision() === refreshTest.revision))
        .toBe(true);
      await expect(page.locator(rows)).toHaveCount(selected.rows);
      // New Tab keeps its existing full render on return; native Find parity is
      // checked separately after that render has completed.
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#new-tab-content [data-key]'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.dispatchEvent(new Event('pagehide'));
      });
      await expect(page.locator(rows)).toHaveCount(0);
      expect(await page.evaluate(() => retainedViewTabs())).toBe(0);
      console.log('✓ New Tab selected hidden rows, response rejection and disposal');
    }
    console.log(
      `✓ ${view}: other-window filtering, hidden deferral, single in-flight read, revision deduplication and background restart`,
    );
  }
  expect(errors).toEqual([]);
} finally {
  await close();
}
