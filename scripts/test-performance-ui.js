import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  // Expose timing only in the served test response, never in the extension.
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source +
        '\nwindow.measureSidebarUpdate = (next) => { acceptState(next); const start = performance.now(); render(); return performance.now() - start; };',
    }),
  );
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.perfTest = {
      calls: {},
      delay: false,
      fail: false,
      navigationRequests: [],
    });
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const tabs = Array.from({ length: 1020 }, (_, i) => ({
        id: i + 1,
        windowId: i < 1000 ? 1 : 2,
        index: i,
        title: `Tab ${i}`,
        url: `https://example.com/${i}`,
        active: i === 0,
      }));
      testing.api = memoryBrowser({
        events: true,
        groups: Array.from({ length: 10 }, (_, i) => ({
          id: `g${i}`,
          name: `Group ${i}`,
          parentId: null,
        })),
        tabs,
        memberships: Object.fromEntries(
          tabs.map((tab, i) => [
            tab.id,
            {
              treeId: `t${i}`,
              ancestors: [],
              groupId: `g${Math.floor(i / 100) % 10}`,
            },
          ]),
        ),
      });

      const notify = (notice) => {
        for (const listener of listeners)
          listener({
            type: 'tabernacle:changed',
            revision: notice.revision,
            generation: notice.generation,
            windowIds: notice.windowId == null ? null : [notice.windowId],
          });
      };

      let controller = createController(testing.api, notify);
      testing.restart = () => {
        controller.dispose();
        controller = createController(testing.api, notify);
      };
      testing.snapshot = () => controller.request({ type: 'snapshot', windowId: 1 });
      return { request: (message) => controller.request(message) };
    });
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-performance-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          const type = message.type.slice('tabernacle:'.length);
          testing.calls[type] = (testing.calls[type] || 0) + 1;
          try {
            if (type === 'toggleGroup' && testing.delay)
              await new Promise((resolve) => {
                testing.release = resolve;
              });
            if (type === 'toggleGroup' && testing.fail) throw new Error('Test save failed');
            if (type === 'enterGroup' && testing.delayNavigation)
              await new Promise((resolve) => {
                testing.navigationRequests.push({ id: message.id, resolve });
              });
            if (type === 'enterGroup' && testing.failNavigation)
              throw new Error('Test navigation failed');
            return { ok: true, data: await (await ready).request({ ...message, type }) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.tab-row')).toHaveCount(1000);
  await page.evaluate(() => {
    window.retainedRow = document.querySelector('[data-key="tab:500"]');
    window.retainedLabel = retainedRow.querySelector('.label');
    window.perfTest.calls = {};
    return perfTest.api.tabs.update(2, { title: 'Updated title' });
  });
  await expect(page.locator('[data-key="tab:2"] .label')).toHaveText('Updated title');
  expect(
    await page.evaluate(
      () =>
        retainedRow === document.querySelector('[data-key="tab:500"]') &&
        retainedLabel === retainedRow.querySelector('.label'),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => perfTest.calls.snapshot)).toBe(1);
  console.log('✓ A title update keeps unrelated rows and their contents in place');

  await page.evaluate(() => {
    perfTest.calls = {};
    return perfTest.api.tabs.update(1001, { title: 'Other window title' });
  });
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => perfTest.calls.snapshot || 0)).toBe(0);
  const group = page.locator('[data-key="group:g0"]');
  await group.locator('.label').click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => perfTest.calls)).toEqual({ toggleGroup: 1 });
  await group.locator('.label').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(60);
  console.log(
    '✓ Other-window events and completed actions do not cause redundant snapshot requests',
  );

  const immediate = await page.evaluate(() => {
    perfTest.delay = true;
    perfTest.fail = true;
    const row = document.querySelector('[data-key="group:g0"]');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    return row.getAttribute('aria-expanded');
  });
  expect(immediate).toBe('false');
  await page.waitForFunction(() => Boolean(perfTest.release));
  await page.evaluate(() => {
    perfTest.delay = false;
    perfTest.release();
  });
  await expect(page.locator('#toast')).toHaveText('Test save failed');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    perfTest.fail = false;
    perfTest.release = null;
  });
  console.log(
    '✓ Keyboard group toggles are visible synchronously and roll back after a failed save',
  );

  await page.evaluate(() => {
    perfTest.delay = true;
    const row = document.querySelector('[data-key="group:g0"]');
    for (let i = 0; i < 2; i++)
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.waitForFunction(() => Boolean(perfTest.release));
  await page.evaluate(() => {
    perfTest.delay = false;
    perfTest.release();
  });
  await expect
    .poll(() =>
      page.evaluate(async () => (await perfTest.snapshot()).view.collapsed.includes('g0')),
    )
    .toBe(false);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await group.dblclick({ delay: 180 });
  await expect(page.locator('#scope-heading')).toHaveText('Group 0');
  await page.locator('#home').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  console.log('✓ Rapid toggles and double-click navigation preserve the final expansion state');

  // Let a slower first click pass the grace period, then read immediately in
  // the second click's event turn while both background requests are held.
  await page.evaluate(() => {
    perfTest.delay = true;
    perfTest.release = null;
    perfTest.delayNavigation = true;
    document
      .querySelector('[data-key="group:g0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await page.waitForFunction(() => Boolean(perfTest.release));
  expect(
    await page.evaluate(() => {
      const row = document.querySelector('[data-key="group:g0"]');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      return document.querySelector('#scope-heading')?.textContent;
    }),
  ).toBe('Group 0');
  await expect(page.locator('.tab-row')).toHaveCount(100);
  await page.evaluate(async () => {
    measureSidebarUpdate(await perfTest.snapshot());
    perfTest.delay = false;
    perfTest.release();
  });
  await page.waitForFunction(() => perfTest.navigationRequests.length === 1);
  await expect(page.locator('#scope-heading')).toHaveText('Group 0');
  expect(await page.evaluate(async () => (await perfTest.snapshot()).view.scopeId)).toBe(null);

  // Navigate again while the first request is still pending. Its eventual
  // reply, and the intervening Home reply, must preserve the latest view.
  await page.locator('#home').click();
  await expect(page.locator('#scope-heading')).toHaveCount(0);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await page.locator('[data-key="group:g1"]').dblclick();
  await expect(page.locator('#scope-heading')).toHaveText('Group 1');
  for (const id of [null, 'g1']) {
    await page.evaluate(() => perfTest.navigationRequests.shift().resolve());
    await page.waitForFunction((id) => perfTest.navigationRequests[0]?.id === id, id);
    await expect(page.locator('#scope-heading')).toHaveText('Group 1');
    await expect(page.locator('.tab-row')).toHaveCount(100);
  }
  await page.evaluate(() => {
    perfTest.delayNavigation = false;
    perfTest.navigationRequests.shift().resolve();
  });
  await expect
    .poll(() => page.evaluate(async () => (await perfTest.snapshot()).view.scopeId))
    .toBe('g1');
  await page.locator('#home').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-key="group:g1"]')).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => page.evaluate(async () => (await perfTest.snapshot()).view.scopeId))
    .toBe(null);
  console.log('✓ Breadcrumbs and folder contents update immediately and survive delayed replies');

  await page.evaluate(() => {
    perfTest.delayNavigation = true;
    perfTest.failNavigation = true;
  });
  await page.locator('[data-key="group:g2"]').dblclick();
  await expect(page.locator('#scope-heading')).toHaveText('Group 2');
  await page.waitForFunction(() => perfTest.navigationRequests.length === 1);
  await page.evaluate(() => {
    perfTest.delayNavigation = false;
    perfTest.navigationRequests.shift().resolve();
  });
  await expect(page.locator('#toast')).toHaveText('Test navigation failed');
  await expect(page.locator('#scope-heading')).toHaveCount(0);
  await expect(group).toBeVisible();
  await page.evaluate(() => {
    perfTest.failNavigation = false;
  });
  console.log('✓ Failed navigation restores the confirmed folder and reports the error');

  await page.evaluate(() => {
    const row = document.querySelector('[data-key="group:g9"]');
    row.scrollIntoView({ block: 'start' });
  });
  await page.locator('[data-key="group:g9"] .label').dblclick({ delay: 180 });
  await expect(page.locator('#scope-heading')).toHaveText('Group 9');
  expect(await page.evaluate(async () => (await perfTest.snapshot()).tabs.length)).toBe(1000);
  console.log('✓ Double-click keeps its original group when collapsing clamps the scroll position');

  await page.locator('#home').click();
  await expect(page.locator('#scope-heading')).toBeHidden();
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    perfTest.restart();
    return perfTest.api.tabs.update(2, { title: 'Changed after background restart' });
  });
  await expect(page.locator('[data-key="tab:2"] .label')).toHaveText(
    'Changed after background restart',
  );
  console.log('✓ A new background generation refreshes an already-open sidebar');
  for (const [size, shape] of [
    [100, 'flat'],
    [500, 'flat'],
    [1000, 'flat'],
    [400, 'chain'],
  ]) {
    const result = await page.evaluate(
      async ({ size, shape }) => {
        const groups = Array.from({ length: shape === 'chain' ? 1 : 10 }, (_, i) => ({
          id: `g${i}`,
          name: `Group ${i}`,
          parentId: null,
        }));
        const tabs = Array.from({ length: size }, (_, i) => ({
          id: i + 1,
          windowId: 1,
          index: i,
          title: `Tab ${i}`,
          url: `https://example.com/${i}`,
          groupId: shape === 'chain' ? 'g0' : `g${Math.floor(i / 10) % 10}`,
          parentTabId: shape === 'chain' && i ? i : null,
          treeId: `t${i}`,
          ancestors: [],
          active: i === 0,
        }));
        const state = {
          tabs,
          groups,
          look: { connectingLines: false, domains: false },
          view: { scopeId: null, collapsed: [] },
        };
        document.querySelector('#tree').scrollTop = 0;
        measureSidebarUpdate(state);
        await new Promise(requestAnimationFrame);
        const times = [];
        for (let i = 0; i < 7; i++) {
          const next = structuredClone(state);
          next.tabs.at(-1).title += ` update ${i}`;
          times.push(measureSidebarUpdate(next));
          await new Promise(requestAnimationFrame);
        }
        times.sort((a, b) => a - b);
        return { tabs: size, shape, medianUpdateMs: +times[3].toFixed(1) };
      },
      { size, shape },
    );
    console.log(JSON.stringify(result));
  }
  expect(errors).toEqual([]);
  console.log(
    '8 performance UI checks passed; timings are diagnostic, not machine-dependent pass thresholds.',
  );
} finally {
  await close();
}
