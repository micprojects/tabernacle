import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 320, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  // Expose timing only in the served test response, never in the extension.
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  const transferSource = await readFile('extension/src/snapshot-transfer.js', 'utf8');
  await page.route('**/extension/src/snapshot-transfer.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: transferSource.replace(
        '  return read;',
        '  window.sidebarReaderProbe = () => ({ retained: Boolean(previous), epoch }); return read;',
      ),
    }),
  );
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source.replace(
          'index = createTreeIndex(state, query);',
          'window.perfIndexBuilds = (window.perfIndexBuilds || 0) + 1; index = createTreeIndex(state, query);',
        ) +
        '\nwindow.measureSidebarUpdate = (next) => { acceptState(next); const start = performance.now(); render(); return performance.now() - start; };' +
        '\nwindow.forceFullSidebarRender = () => { previousRender = null; render(); };' +
        '\nwindow.sidebarVisibilityTest = { action, domain: filterByDomain, leaveDomain, state: () => ({ generation: state.generation, focused: windowFocused }) };' +
        String.raw`
window.sidebarReleaseProbe = {
  refresh,
  request: (...args) => request(...args),
  action: (...args) => action(...args),
  pendingClick: () => { clickGroup('g0', { detail: 1 }); return Boolean(pendingGroupClick); },
  hasPendingClick: () => Boolean(pendingGroupClick),
  queueIsEmpty: () => actionQueue.then(value => value === undefined),
  inspect: () => ({ disposed, hasState: Boolean(state), hasConfirmed: Boolean(confirmedState) }),
};` +
        String.raw`
window.measureSidebarLookupReads = (next) => {
  acceptState(next);
  const reads = { tabs: 0, collapsed: 0 };
  const track = (values, kind) => new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads[kind]++;
      return Reflect.get(target, property, receiver);
    },
  });
  state = {
    ...state,
    tabs: track(state.tabs, 'tabs'),
    view: { ...state.view, collapsed: track(state.view.collapsed, 'collapsed') },
  };
  previousRender = null;
  render();
  return reads;
};`,
    }),
  );
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.perfTest = {
      calls: {},
      delay: false,
      fail: false,
      navigationRequests: [],
      hidden: false,
    });
    Object.defineProperty(document, 'hidden', { get: () => testing.hidden });
    testing.closeFilter = async () => {
      for (const listener of listeners) {
        const reply = listener({ type: 'tabernacle:getCloseFilter', windowId: 1 });
        if (reply !== undefined) return reply;
      }
      throw new Error('Sidebar close-filter listener was not registered');
    };
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
      import('/extension/src/snapshot-transfer.js'),
    ]).then(([{ memoryBrowser }, { createController }, { createSnapshotEncoder }]) => {
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
      let snapshots = createSnapshotEncoder();
      testing.restart = () => {
        controller.dispose();
        controller = createController(testing.api, notify);
        snapshots = createSnapshotEncoder();
      };
      testing.snapshot = () => controller.request({ type: 'snapshot', windowId: 1 });
      return {
        async request(message) {
          const state = await controller.requestForTransport(message);
          if (
            !(message.type === 'snapshot' && message.incremental) &&
            !(message.incremental === 2 && Array.isArray(state?.tabs))
          )
            return structuredClone(state);
          const result = snapshots.encode(
            message.windowId,
            state,
            message.snapshotToken,
            message.incremental === 2 ? 2 : 1,
          );
          testing.transfer = result;
          return structuredClone(result);
        },
      };
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
            const data = await (await ready).request({ ...message, type });
            if (type === 'snapshot' && testing.holdSnapshot) {
              testing.holdSnapshot = false;
              await new Promise((resolve) => {
                testing.releaseSnapshot = resolve;
              });
              if (testing.failHeldSnapshot) throw new Error('Late snapshot failure');
            }
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.tab-row')).toHaveCount(1000);
  await page.waitForTimeout(60);
  const priorGeneration = await page.evaluate(() => sidebarVisibilityTest.state().generation);
  await page.evaluate(async () => {
    perfTest.calls = {};
    perfTest.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    perfTest.restart();
    for (let i = 0; i < 20; i++) await perfTest.api.tabs.update(2, { title: 'Hidden title ' + i });
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => perfTest.calls.snapshot || 0)).toBe(0);
  await expect(page.locator('.tab-row')).toHaveCount(1000);
  await expect(page.locator('[data-key="tab:2"] .label')).toHaveText('Tab 1');
  await page.evaluate(() => {
    perfTest.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('[data-key="tab:2"] .label')).toHaveText('Hidden title 19');
  expect(await page.evaluate(() => perfTest.calls.snapshot)).toBe(1);
  expect(await page.evaluate(() => sidebarVisibilityTest.state().generation)).not.toBe(
    priorGeneration,
  );
  expect(await page.evaluate(() => sidebarVisibilityTest.state().focused)).toBe(false);
  await page.evaluate(() => perfTest.api.tabs.update(2, { title: 'Tab 1' }));
  await expect(page.locator('[data-key="tab:2"] .label')).toHaveText('Tab 1');

  // UI actions and their recovery reads complete even while passive refresh is paused.
  for (const fail of [false, true]) {
    await page.evaluate((fail) => {
      perfTest.calls = {};
      perfTest.delay = true;
      perfTest.fail = fail;
      perfTest.release = null;
      window.hiddenActionDone = false;
      window.hiddenAction = sidebarVisibilityTest
        .action('toggleGroup', { id: 'g0' })
        .then((next) => {
          hiddenActionDone = true;
          return next !== null;
        });
    }, fail);
    await page.waitForFunction(() => Boolean(perfTest.release));
    await page.evaluate(() => {
      perfTest.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      perfTest.delay = false;
      perfTest.release();
    });
    await page.waitForFunction(() => hiddenActionDone);
    expect(await page.evaluate(() => hiddenAction)).toBe(!fail);
    expect(await page.evaluate(() => perfTest.calls.toggleGroup)).toBe(1);
    if (fail) expect(await page.evaluate(() => perfTest.calls.snapshot)).toBe(1);
    await page.evaluate(() => {
      perfTest.fail = false;
      perfTest.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('[data-key="group:g0"]')).toHaveAttribute(
      'aria-expanded',
      fail ? 'true' : 'false',
    );
    if (!fail) {
      await page.evaluate(() => sidebarVisibilityTest.action('toggleGroup', { id: 'g0' }));
      await expect(page.locator('[data-key="group:g0"]')).toHaveAttribute('aria-expanded', 'true');
    }
  }

  // Search, domain and Later close criteria remain synchronous and current while hidden.
  const checkHiddenFilter = async (expected) => {
    await expect
      .poll(() => page.evaluate(async () => (await perfTest.closeFilter())?.tabIds?.length || 0))
      .toBeGreaterThan(0);
    const shown = await page.evaluate(() => perfTest.closeFilter());
    expect(shown.tabIds.length).toBeGreaterThan(0);
    await page.evaluate(() => {
      perfTest.calls = {};
      perfTest.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await page.evaluate(() => perfTest.closeFilter())).toEqual(expected);
    expect(await page.evaluate(() => perfTest.calls)).toEqual({});
    await page.evaluate(() => {
      perfTest.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => page.evaluate(async () => (await perfTest.closeFilter())?.tabIds?.length || 0))
      .toBeGreaterThan(0);
  };

  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('Tab 9');
  await expect(page.locator('#tree')).toHaveClass(/searching/);
  await checkHiddenFilter({ search: true, query: 'Tab 9', scopeId: null });
  await page.locator('#search-close').click();
  await page.evaluate(() => sidebarVisibilityTest.domain('example.com', 2));
  await expect(page.locator('#domain-header')).toBeVisible();
  await checkHiddenFilter({ domain: 'example.com', query: '', sort: 'newest' });
  await page.evaluate(() => sidebarVisibilityTest.leaveDomain());
  await page.evaluate(() => sidebarVisibilityTest.action('saveForLater', { id: 2 }));
  await page.locator('#later-toggle').click();
  await expect(page.locator('.later-row')).toHaveCount(1);
  await checkHiddenFilter({ later: true, query: '', sort: 'newest' });
  await page.locator('#later-close').click();
  await page.evaluate(() => sidebarVisibilityTest.action('returnFromLater', { id: 2 }));
  await expect(page.locator('.tab-row')).toHaveCount(1000);
  await page.waitForTimeout(60);
  console.log(
    '✓ Hidden sidebar coalesces changes, catches background restarts, preserves full DOM, completes actions/recovery and supplies live close criteria; visible unfocused sidebar refreshes',
  );

  await page.evaluate(() => {
    window.retainedRow = document.querySelector('[data-key="tab:500"]');
    window.retainedLabel = retainedRow.querySelector('.label');
    window.perfTest.calls = {};
    window.perfIndexBuilds = 0;
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
  expect(await page.evaluate(() => perfIndexBuilds)).toBe(0);
  expect(await page.evaluate(() => perfTest.transfer.changes.map(({ tab }) => tab.id))).toEqual([
    2,
  ]);
  expect(await page.evaluate(() => Object.hasOwn(perfTest.transfer.state, 'tabs'))).toBe(false);
  console.log('✓ A title update keeps unrelated rows and their contents in place');

  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('Updated title');
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await page.locator('#search').fill('');
  await expect(page.locator('.tab-row')).toHaveCount(1000);
  expect(
    await page.evaluate(
      () =>
        retainedRow === document.querySelector('[data-key="tab:500"]') &&
        retainedLabel === retainedRow.querySelector('.label'),
    ),
  ).toBe(true);
  await page.locator('#search-close').click();
  console.log('✓ Clearing search reuses filtered rows and their contents');

  await page.evaluate(async () => {
    const { createRowCache } = await import('/extension/src/dom.js');
    const cache = createRowCache({ retain: 2 });
    const make = (key) => cache.get(key, [key], () => document.createElement('span'));
    const root = document.createElement('div');
    document.body.append(root);
    const a = make('a'),
      b = make('b'),
      c = make('c');
    root.append(a, b, c);
    cache.finish(() => true);
    root.replaceChildren();
    cache.begin();
    const d = make('d');
    root.append(d);
    cache.finish(() => true);
    if (make('a') === a || make('b') !== b || make('c') !== c)
      throw new Error('Hidden row retention must be bounded and keep recent entries');
    if (b.parentNode || c.parentNode)
      throw new Error('Hidden rows must release their old parent tree');
    cache.begin();
    cache.finish((key) => key !== 'b');
    if (make('b') === b) throw new Error('Closed items must be evicted');
    root.remove();
  });
  console.log('✓ Hidden row retention is bounded, detached, and prunes closed items');

  const lookupReads = await page.evaluate(async () => {
    const original = await perfTest.snapshot();
    const field = document.getElementById('search');
    const saved = {
      ...original,
      tabs: original.tabs.map((tab) => ({
        ...tab,
        title: 'Saved lookup ' + tab.id,
        savedForLaterAt: 1000 + tab.id,
      })),
    };
    field.value = 'Saved lookup';
    measureSidebarUpdate(saved);
    const survivor = document.querySelector('[data-key="tab:500"]');
    const removed = document.querySelector('[data-key="tab:501"]');
    field.value = 'No matching lookup';
    const hiddenReads = measureSidebarLookupReads({
      ...saved,
      tabs: saved.tabs.filter((tab) => tab.id !== 501),
    });
    field.value = 'Saved lookup';
    measureSidebarUpdate(saved);
    const retained = survivor === document.querySelector('[data-key="tab:500"]');
    const evicted = removed !== document.querySelector('[data-key="tab:501"]');
    field.value = '';
    const groups = Array.from({ length: 300 }, (_, i) => ({
      id: 'lookup-group-' + i,
      name: 'Lookup folder ' + i,
      parentId: null,
    }));
    const folders = {
      ...original,
      tabs: [],
      groups,
      pins: [],
      folderPins: [],
      view: { ...original.view, scopeId: null, collapsed: groups.map((group) => group.id) },
    };
    const foldedReads = measureSidebarLookupReads(folders);
    const foldedCount = document.querySelectorAll('.group-row').length;
    const allFolded = [...document.querySelectorAll('.group-row')].every(
      (row) => row.getAttribute('aria-expanded') === 'false',
    );
    folders.view.collapsed.splice(10, 1);
    measureSidebarUpdate(folders);
    const reopened =
      document.querySelector('[data-key="group:lookup-group-10"]').getAttribute('aria-expanded') ===
      'true';
    measureSidebarUpdate(original);
    return { hiddenReads, foldedReads, foldedCount, retained, evicted, allFolded, reopened };
  });
  expect(lookupReads.hiddenReads.tabs).toBeLessThan(12_000);
  expect(lookupReads.foldedReads.collapsed).toBeLessThan(3000);
  expect(lookupReads).toMatchObject({
    foldedCount: 300,
    retained: true,
    evicted: true,
    allFolded: true,
    reopened: true,
  });
  console.log(
    '✓ Hidden saved rows and collapsed folders use bounded lookup work without stale state',
  );

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
          folderPins: [],
          pins: [],
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
  await page.evaluate(() => {
    const state = {
      generation: 'metadata-regression',
      groups: [{ id: 'g', name: 'Group', parentId: null }],
      tabs: Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        treeId: `t${i}`,
        windowId: 1,
        index: i,
        order: i,
        groupId: 'g',
        title: `Tab ${i}`,
        url: `https://example.com/${i}`,
        parentTabId: i === 1 ? 1 : i === 3 ? 3 : null,
        pinned: i === 2,
        active: i === 0,
      })),
      containers: [],
      folderPins: [],
      pins: [{ kind: 'tab', id: 't2' }],
      look: { connectingLines: true, domains: true, tintFavicons: true, animations: false },
      view: { scopeId: null, collapsed: [] },
    };
    const markup = () => ['tree', 'pinned-tabs'].map((id) => document.getElementById(id).innerHTML);
    measureSidebarUpdate(state);
    for (const collapsed of [false, true, false]) {
      state.tabs[0].collapsed = collapsed;
      measureSidebarUpdate(structuredClone(state));
      const builds = perfIndexBuilds;
      for (const tab of state.tabs) {
        tab.title += ' updated';
        tab.url = 'https://updated.example.org/page';
        tab.discarded = !tab.discarded;
        tab.container = tab.container ? null : { name: 'Work', colorCode: '#37adff' };
        tab.favIconUrl = tab.favIconUrl
          ? null
          : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      }
      measureSidebarUpdate(structuredClone(state));
      if (perfIndexBuilds !== builds) throw new Error('Metadata rebuilt the tree index');
      const patched = markup();
      forceFullSidebarRender();
      if (JSON.stringify(patched) !== JSON.stringify(markup()))
        throw new Error('Metadata patch differs from full rendering');
    }
  });
  console.log('✓ Patched metadata matches full rendering for pins, nested and hidden tabs');

  const laterPage = await page.context().browser().newPage();
  try {
    await laterPage.route('**/lookup-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><section id="root"><button id="tree-toggle">Fold</button><footer><button id="domains-toggle">Domains</button></footer></section>',
      }),
    );
    await laterPage.goto(base + '/lookup-fixture');
    const result = await laterPage.evaluate(async () => {
      const { createLaterView } = await import('/extension/src/later-view.js');
      const reads = { tabs: 0, groups: 0 };
      const track = (values, kind) =>
        new Proxy(values, {
          get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) reads[kind]++;
            return Reflect.get(target, property, receiver);
          },
        });
      const tabs = Array.from({ length: 300 }, (_, i) => ({
        id: i + 1,
        index: i,
        title: 'Saved ' + (i + 1),
        url: 'https://example.com/' + i,
        groupId: 'group-' + i,
        savedForLaterAt: 1000 + i,
      }));
      const groups = tabs.slice(0, -1).map((tab, i) => ({ id: tab.groupId, name: 'Folder ' + i }));
      const state = { tabs: track(tabs, 'tabs'), groups: track(groups, 'groups') };
      let reviewed;
      const view = createLaterView({
        root: document.getElementById('root'),
        getState: () => state,

        onOpen() {},

        onClose() {},

        onActions(_event, items, scope) {
          reviewed = {
            ids: items.map((tab) => tab.id),
            titles: items.map((tab) => tab.title),
            scope,
          };
        },
      });
      view.update(state);
      view.open();
      const renderReads = { ...reads };
      const pane = document.getElementById('later-view');
      const actions = pane.querySelector('[aria-label="Saved tabs actions"]');
      const fallback =
        pane.querySelector('.later-row[data-id="300"] [aria-label="Return to Home"]') !== null;
      reads.tabs = 0;
      actions.click();
      const actionReads = reads.tabs;
      const newest = reviewed.ids;
      groups[0].name = 'Renamed folder';
      tabs[0].title = 'Updated saved title';
      view.update(state);
      const renamed =
        pane.querySelector('.later-row[data-id="1"] [aria-label="Return to Renamed folder"]') !==
        null;
      const sort = pane.querySelector('select');
      sort.value = 'oldest';
      sort.dispatchEvent(new Event('change'));
      actions.click();
      const oldest = reviewed.ids;
      const currentTitle = reviewed.titles[0];
      const search = pane.querySelector('input');
      search.value = 'Saved 2';
      search.dispatchEvent(new Event('input'));
      actions.click();
      const filtered = reviewed;
      view.close();
      const releasedRows = pane.querySelectorAll('.later-row').length;
      state.tabs = track(
        tabs.filter((tab) => tab.id !== 2),
        'tabs',
      );
      view.update(state);
      view.open();
      actions.click();
      const afterClose = reviewed.ids;
      const filterIds = view.closeFilter().tabIds;
      view.dispose();
      view.update(state);
      view.open();
      const disposed =
        !pane.isConnected && !document.getElementById('later-toggle') && !view.isOpen;
      return {
        releasedRows,
        disposed,
        renderReads,
        actionReads,
        newest,
        oldest,
        currentTitle,
        filtered,
        afterClose,
        filterIds,
        renamed,
        fallback,
      };
    });
    expect(result.renderReads.groups).toBeLessThan(3000);
    expect(result.actionReads).toBeLessThan(3000);
    expect(result.newest).toEqual(Array.from({ length: 300 }, (_, i) => 300 - i));
    expect(result.oldest).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(result).toMatchObject({
      releasedRows: 0,
      disposed: true,
      currentTitle: 'Updated saved title',
      renamed: true,
      fallback: true,
    });
    const filtered = Array.from({ length: 300 }, (_, i) => i + 1).filter((id) =>
      String(id).startsWith('2'),
    );
    expect(result.filtered.ids).toEqual(filtered);
    expect(result.filtered.scope).toEqual({ kind: 'later', query: 'Saved 2' });
    expect(result.afterClose).toEqual(filtered.filter((id) => id !== 2));
    expect(result.filterIds).toEqual(result.afterClose);
    console.log('✓ Later actions keep live ordered targets with linear tab and folder lookups');
  } finally {
    await laterPage.close();
  }
  const queue = await page.evaluate(async () => {
    const result = await sidebarReleaseProbe.action('toggleGroup', { id: 'g0' });
    return { resultTabs: result.tabs.length, empty: await sidebarReleaseProbe.queueIsEmpty() };
  });
  expect(queue).toEqual({ resultTabs: 1000, empty: true });
  for (const rejected of [false, true]) {
    if (rejected) {
      await page.reload();
      await expect(page.locator('.tab-row')).toHaveCount(1000);
    }
    await page.evaluate((rejected) => {
      perfTest.holdSnapshot = true;
      perfTest.failHeldSnapshot = rejected;
      window.pendingSidebarRefresh = sidebarReleaseProbe.refresh();
    }, rejected);
    await page.waitForFunction(() => Boolean(perfTest.releaseSnapshot));
    const closed = await page.evaluate(async () => {
      const retainedBefore = sidebarReaderProbe().retained;
      const encoded = Boolean(perfTest.transfer?.token);
      const pendingClickBefore = sidebarReleaseProbe.pendingClick();
      window.dispatchEvent(new Event('pagehide'));
      const cleared = sidebarReaderProbe();
      perfTest.releaseSnapshot();
      await pendingSidebarRefresh;
      const afterPending = sidebarReaderProbe();
      // An already queued action may still need a recovery snapshot after
      // disposal. It receives the response, but the closed reader keeps no base.
      const recovery = await sidebarReleaseProbe.request('snapshot');
      return {
        retainedBefore,
        encoded,
        pendingClickBefore,
        pendingClickAfter: sidebarReleaseProbe.hasPendingClick(),
        cleared: cleared.retained,
        afterPending: afterPending.retained,
        afterRecovery: sidebarReaderProbe().retained,
        recoveryTabs: recovery.tabs.length,
        ...sidebarReleaseProbe.inspect(),
        rows: document.querySelectorAll('.tab-row, .group-row, #tree .loading').length,
        lateError: document.body.textContent.includes('Late snapshot failure'),
      };
    });
    expect(closed).toEqual({
      retainedBefore: true,
      encoded: true,
      pendingClickBefore: true,
      pendingClickAfter: false,
      cleared: false,
      afterPending: false,
      afterRecovery: false,
      recoveryTabs: 1000,
      disposed: true,
      hasState: false,
      hasConfirmed: false,
      rows: 0,
      lateError: false,
    });
  }
  // Let the original click grace period pass; a disposed page must not toggle or throw.
  await page.waitForTimeout(150);
  console.log(
    '✓ Sidebar disposal releases reader and action tails without cancelling recovery or reviving late UI',
  );
  expect(errors).toEqual([]);
  console.log(
    'Performance UI checks passed; timings are diagnostic, not machine-dependent pass thresholds.',
  );
} finally {
  await close();
}
