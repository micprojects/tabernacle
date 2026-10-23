import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startUiTest } from './ui-test.js';
import { observeSidebar } from './memory/native-settlement.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 820 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const viewportSource = await readFile('extension/src/tree-viewport.js', 'utf8');
  const viewportApi = '  const api = {';
  expect(viewportSource.split(viewportApi)).toHaveLength(2);
  await page.route('**/extension/src/tree-viewport.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: viewportSource.replace(
        viewportApi,
        `  window.viewportBuffer = () => ({
          overscan: rangeOverscan, start: bufferedRange?.start, end: bufferedRange?.end,
          first: previousVisibleStart, last: previousVisibleEnd,
          visibility: getComputedStyle(tree.querySelector('.tab-row:not([aria-expanded])')).contentVisibility,
        });
${viewportApi}`,
      ),
    }),
  );
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source.replace(
          'function createTabRow(tab, expanded, stats) {',
          'function createTabRow(tab, expanded, stats) { window.viewportTabBuilds = (window.viewportTabBuilds || 0) + 1;',
        ) +
        `
      window.viewportTest = {
        ready: () => Boolean(state),
        set: (next, motionKey = null) => { refreshScheduler.dispose(); acceptState(next); previousRender = null; render(motionKey); },
        patch: next => { acceptState(next); render(); },
        search: query => { $('search').value = query; render(); },
        poolDomain: (domain, id) => domain ? filterByDomain(domain, id) : leaveDomain({ restoreFocus: false }),
        targets: () => projection.filterTabIds,
        cached: keys => ({ pooled: leafPool.length, keys: keys.filter(key => rowCache.has(key)) }),
        reveal: key => treeRenderer.ensureVisible(key),
        mount: key => treeRenderer.mount(key),
        full: () => { tree.classList.remove('viewport-tree'); createFullTreeRenderer(treeRendererOptions).update(projection); },
        redraw: () => { previousRender = null; render(); },
        resetRows: () => { window.viewportTabBuilds = 0; releaseTree(); render(); },
        calls: [],
        intercept: () => { request = async (type, args) => { viewportTest.calls.push({ type, ...args }); return confirmedState; }; },
      };`,
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.waitForFunction(() => window.viewportTest?.ready());
  await page.evaluate(() => {
    window.fixture = {
      generation: 'viewport-test',
      revision: 1,
      groups: Array.from({ length: 10 }, (_, i) => ({
        id: `g${i}`,
        name: `Folder ${i}`,
        parentId: null,
      })),
      tabs: Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        treeId: `t${i}`,
        windowId: 1,
        index: i,
        order: i,
        groupId: `g${Math.floor(i / 100)}`,
        title: `Needle ${String(i).padStart(4, '0')}`,
        url: `https://example.com/${i}`,
        parentTabId: null,
        active: i === 0,
      })),
      containers: [],
      pins: [],
      folderPins: [],
      look: { connectingLines: true, domains: false, folderCounts: true, animations: false },
      view: { scopeId: null, collapsed: [] },
    };
    viewportTest.set(structuredClone(fixture));
    viewportTest.intercept();
  });
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  expect(await page.locator('.tab-row').count()).toBeLessThan(100);
  expect(await page.evaluate(() => viewportTest.targets().length)).toBe(1000);

  const bufferPolicies = await page.evaluate(async () => {
    document.getElementById('home').focus();
    const tree = document.getElementById('tree');

    const settle = async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return viewportBuffer();
    };

    const initial = viewportBuffer();
    tree.scrollTop = 60;
    const slow = await settle();
    tree.scrollTop = tree.scrollHeight / 2;
    const jump = await settle();
    viewportTest.mount('tab:1000');
    const owned = await settle();
    tree.scrollTop += 60;
    const resumed = await settle();
    tree.scrollTop = 0;
    const returned = await settle();
    viewportTest.resetRows();
    const reset = await settle();
    return { initial, slow, jump, owned, resumed, returned, reset };
  });
  expect(bufferPolicies.initial.overscan).toBe(12);
  expect(bufferPolicies.slow.overscan).toBe(24);
  expect(bufferPolicies.jump.overscan).toBe(8);
  expect(bufferPolicies.owned).toEqual(bufferPolicies.jump);
  expect(bufferPolicies.resumed.overscan).toBe(24);
  expect(bufferPolicies.returned.overscan).toBe(8);
  expect(bufferPolicies.reset.overscan).toBe(12);
  for (const name of ['initial', 'jump', 'owned', 'returned', 'reset'])
    expect(bufferPolicies[name].visibility, name).toBe('auto');
  for (const name of ['slow', 'resumed'])
    expect(bufferPolicies[name].visibility, name).toBe('visible');
  for (const range of Object.values(bufferPolicies)) {
    expect(range.start).toBeLessThanOrEqual(range.first);
    expect(range.end).toBeGreaterThanOrEqual(range.last);
    expect(range.end - range.start).toBeLessThanOrEqual(
      range.last - range.first + 2 * range.overscan,
    );
  }
  console.log(
    '✓ Scroll buffers and offscreen painting adapt to movement without changing for owners',
  );

  const ownerChanges = await page.evaluate(async () => {
    document.getElementById('home').focus();
    viewportTest.reveal('tab:1');
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const tree = document.getElementById('tree');
    const top = tree.scrollTop;
    const first = viewportTest.mount('tab:1000');
    const firstAncestor = tree.querySelector('[data-key="group:g9"]');
    const firstMounted = Boolean(first?.isConnected && firstAncestor?.isConnected);
    const firstTop = tree.scrollTop;
    const second = viewportTest.mount('tab:500');
    return {
      firstMounted,
      secondMounted: Boolean(
        second?.isConnected && tree.querySelector('[data-key="group:g4"]')?.isConnected,
      ),
      firstReleased: !tree.querySelector('[data-key="tab:1000"]') && !firstAncestor?.isConnected,
      scrollUnchanged: firstTop === top && tree.scrollTop === top,
    };
  });
  expect(ownerChanges).toEqual({
    firstMounted: true,
    secondMounted: true,
    firstReleased: true,
    scrollUnchanged: true,
  });
  console.log('✓ Owner-only changes refresh mounted rows and ancestors without scrolling');

  await page.evaluate(() => {
    const mixed = structuredClone(fixture);
    mixed.groups.unshift({ id: 'empty-match', name: 'Needle empty folder', parentId: null });
    viewportTest.set(mixed);
    viewportTest.search('Needle');
  });
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  await expect(page.locator('#tree .empty-child')).toHaveCount(0);
  expect(await page.locator('#tree .tab-row').count()).toBeLessThan(100);
  expect(await page.evaluate(() => viewportTest.targets())).toEqual(
    Array.from({ length: 1000 }, (_, i) => i + 1),
  );
  await page.evaluate(() => viewportTest.search(''));
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  await expect(page.locator('#tree .empty-child')).toHaveCount(0);
  await page.evaluate(() => {
    const empty = structuredClone(fixture);
    empty.tabs = [];
    empty.groups = Array.from({ length: 101 }, (_, i) => ({
      id: `empty-match-${i}`,
      name: `Needle empty folder ${i}`,
      parentId: null,
    }));
    empty.view.collapsed = empty.groups.map((group) => group.id);
    viewportTest.set(empty);
    viewportTest.search('Needle');
  });
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  expect(await page.locator('#tree .group-row').count()).toBeLessThan(100);
  await expect(page.locator('#tree .empty-child')).toHaveCount(0);
  expect(await page.evaluate(() => viewportTest.targets())).toEqual([]);
  const lastEmptyFolder = await page.evaluate(() => {
    viewportTest.reveal('group:empty-match-100');
    const tree = document.getElementById('tree').getBoundingClientRect();
    const row = viewportTest.mount('group:empty-match-100').getBoundingClientRect();
    return row.top >= tree.top && row.bottom <= tree.bottom;
  });
  expect(lastEmptyFolder).toBe(true);
  await page.evaluate(() => {
    viewportTest.search('');
    viewportTest.set(structuredClone(fixture));
  });
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  console.log('✓ Search keeps empty matching folders compact and bounds mounted rows');

  for (const mode of ['mixed-saved', 'saved-only', 'domain']) {
    for (const domains of [false, true]) {
      await page.evaluate(
        ({ mode, domains }) => {
          const next = structuredClone(fixture);
          next.look.domains = domains;
          for (const tab of next.tabs) {
            tab.title += ' A long title with enough words to exceed the available sidebar width';
            if (mode === 'saved-only' || (mode === 'mixed-saved' && tab.id > 800))
              tab.savedForLaterAt = 2000 - tab.id;
          }
          viewportTest.search('');
          viewportTest.set(next);
          if (mode === 'domain') viewportTest.poolDomain('example.com', 1);
          else viewportTest.search('Needle');
        },
        { mode, domains },
      );
      await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
      expect(await page.locator('#tree .tab-row').count()).toBeLessThan(100);
      expect(await page.evaluate(() => viewportTest.targets().length)).toBe(1000);
      const reference = await page.evaluate(() => {
        viewportTest.full();
        const tree = document.getElementById('tree');
        const top = tree.getBoundingClientRect().top;
        const result = {
          height: tree.scrollHeight,
          rows: [1, 800, 801, 1000].map((id) => {
            const node = tree.querySelector(`[data-key="tab:${id}"]`);
            const rect = node.getBoundingClientRect();
            return {
              id,
              top: rect.top - top + tree.scrollTop,
              height: rect.height,
              width: rect.width,
            };
          }),
        };
        viewportTest.redraw();
        return result;
      });
      for (const expected of reference.rows) {
        const actual = await page.evaluate((id) => {
          viewportTest.reveal(`tab:${id}`);
          const tree = document.getElementById('tree');
          const row = viewportTest.mount(`tab:${id}`);
          const rect = row.getBoundingClientRect();
          return {
            id,
            top: rect.top - tree.getBoundingClientRect().top + tree.scrollTop,
            height: rect.height,
            width: rect.width,
          };
        }, expected.id);
        expect(actual).toEqual(expected);
        expect(actual.height).toBe(domains ? 38 : 30);
      }
      expect(await page.locator('#tree').evaluate((node) => node.scrollHeight)).toBe(
        reference.height,
      );
      if (mode !== 'domain') {
        await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute(
          'aria-posinset',
          mode === 'mixed-saved' ? '200' : '1000',
        );
        await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute(
          'aria-setsize',
          mode === 'mixed-saved' ? '200' : '1000',
        );
        await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute(
          'title',
          /Folder: Home/,
        );
        await expect(page.locator('.saved-search-results h2')).toHaveCount(1);
        await page.evaluate(() => {
          viewportTest.reveal('tab:801');
          viewportTest.mount('tab:801').focus();
          document.getElementById('tree').scrollTop = 0;
        });
        await page.waitForTimeout(50);
        await expect(page.locator('[data-key="tab:801"]')).toBeFocused();
      }
      if (mode === 'mixed-saved') {
        await page.evaluate(() => {
          viewportTest.reveal('tab:800');
          viewportTest.mount('tab:800').querySelector('.close-tab').focus();
        });
        await page.keyboard.press('Tab');
        await expect(page.locator('[data-key="tab:801"]')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.locator('[data-key="tab:800"] .close-tab')).toBeFocused();
      }
      await page.evaluate(() => {
        viewportTest.poolDomain(null);
        viewportTest.search('');
        viewportTest.set(structuredClone(fixture));
      });
    }
  }
  console.log(
    '✓ Saved and domain results share fixed rows, exact geometry, section ARIA and retained focus',
  );

  for (const width of [220, 480]) {
    await page.setViewportSize({ width, height: 820 });
    for (const domains of [false, true, false]) {
      const reference = await page.evaluate((domains) => {
        fixture.look.domains = domains;
        viewportTest.set(structuredClone(fixture));
        viewportTest.full();
        const tree = document.getElementById('tree');
        const top = tree.getBoundingClientRect().top;
        const result = {
          height: tree.scrollHeight,
          rows: [1, 100, 101, 500, 999, 1000].map((id) => {
            const rect = document.querySelector(`[data-key="tab:${id}"]`).getBoundingClientRect();
            return {
              id,
              top: rect.top - top + tree.scrollTop,
              height: rect.height,
              width: rect.width,
            };
          }),
        };
        viewportTest.redraw();
        return result;
      }, domains);
      for (const expected of reference.rows) {
        const actual = await page.evaluate((id) => {
          viewportTest.reveal(`tab:${id}`);
          const tree = document.getElementById('tree');
          const rect = document.querySelector(`[data-key="tab:${id}"]`).getBoundingClientRect();
          return {
            id,
            top: rect.top - tree.getBoundingClientRect().top + tree.scrollTop,
            height: rect.height,
            width: rect.width,
          };
        }, expected.id);
        expect(actual).toEqual(expected);
      }
      expect(await page.locator('#tree').evaluate((node) => node.scrollHeight)).toBe(
        reference.height,
      );
      expect(await page.locator('.tab-row').count()).toBeLessThan(100);
    }
  }
  console.log('✓ Viewport geometry matches full nested rendering at both widths and line modes');

  await page.setViewportSize({ width: 220, height: 380 });
  const slowScroll = await page.evaluate(async () => {
    const tree = document.getElementById('tree');
    viewportTest.full();
    const treeTop = tree.getBoundingClientRect().top;
    const reference = [...tree.querySelectorAll('.row, .new-tab-action')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        key: node.dataset.key,
        top: rect.top - treeTop + tree.scrollTop,
        height: rect.height,
      };
    });
    const max = tree.scrollHeight - tree.clientHeight;
    const folderBoundary = reference.find((row) => row.key === 'group:g1').top;
    viewportTest.redraw();
    const positions = [max, 0, max / 2, max, 0];
    for (const anchor of [0, folderBoundary - 240, max - 480]) {
      const steps = Array.from({ length: 41 }, (_, i) => Math.max(0, anchor + i * 12));
      positions.push(...steps, ...steps.toReversed());
    }
    positions.push(Math.floor(max / 2));
    const failures = [];
    let maxMounted = 0;
    for (const position of positions) {
      tree.scrollTop = position;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      const top = tree.scrollTop;
      const bottom = top + tree.clientHeight;
      const expected = reference.filter(
        (row) => row.top + row.height > top + 1 && row.top < bottom - 1,
      );
      const mounted = [...tree.querySelectorAll('.row, .new-tab-action')];
      maxMounted = Math.max(maxMounted, mounted.length);
      const actual = mounted
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            key: node.dataset.key,
            top: rect.top - tree.getBoundingClientRect().top + top,
            height: rect.height,
          };
        })
        .filter((row) => row.top + row.height > top + 1 && row.top < bottom - 1);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push({ position: top, expected, actual });
        if (failures.length === 3) break;
      }
    }
    return { failures, maxMounted, reference, scrollTop: tree.scrollTop };
  });
  expect(slowScroll.failures).toEqual([]);
  expect(slowScroll.maxMounted).toBeLessThan(100);
  console.log(
    '✓ Small scroll steps, reversals and large jumps cover every visible row at narrow height',
  );
  for (const height of [820, 260, 820]) {
    await page.setViewportSize({ width: 220, height });
    const resized = await page.evaluate(async (reference) => {
      // Let native resize observation run without rendering, revealing or scrolling.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const tree = document.getElementById('tree');
      const top = tree.scrollTop;
      const bottom = top + tree.clientHeight;
      const expected = reference.filter(
        (row) => row.top + row.height > top + 1 && row.top < bottom - 1,
      );
      const actual = [...tree.querySelectorAll('.row, .new-tab-action')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            key: node.dataset.key,
            top: rect.top - tree.getBoundingClientRect().top + top,
            height: rect.height,
          };
        })
        .filter((row) => row.top + row.height > top + 1 && row.top < bottom - 1);
      return { actual, expected, scrollTop: top };
    }, slowScroll.reference);
    expect(resized.actual).toEqual(resized.expected);
    expect(resized.scrollTop).toBe(slowScroll.scrollTop);
  }
  console.log('✓ Native height changes refresh visible coverage without a render or scroll hook');

  const subRowScroll = await page.evaluate(async () => {
    const tree = document.getElementById('tree');
    tree.scrollTop = 305;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    let mutations = 0;
    const observer = new MutationObserver((records) => (mutations += records.length));
    observer.observe(tree, { subtree: true, attributes: true, childList: true });
    for (const offset of [306, 307, 308, 307, 306, 305]) {
      tree.scrollTop = offset;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
    }
    observer.disconnect();
    return mutations;
  });
  expect(subRowScroll).toBe(0);
  console.log('✓ Scrolling within the retained buffer makes no DOM writes');

  const resumedView = await page.evaluate(async () => {
    const tree = document.getElementById('tree');

    const settle = async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };

    tree.style.display = 'none';
    await settle();
    // A state update while hidden must rebuild geometry even at zero height.
    const next = structuredClone(fixture);
    next.tabs.reverse();
    next.tabs.forEach((tab, i) => (tab.order = i));
    viewportTest.set(next);
    tree.style.removeProperty('display');
    await settle();
    const visible = [...tree.querySelectorAll('.tab-row')].map((node) => node.dataset.key);
    const result = {
      mounted: visible.length,
      first: visible[0],
      height: tree.scrollHeight,
    };
    viewportTest.full();
    result.fullHeight = tree.scrollHeight;
    viewportTest.set(structuredClone(fixture));
    return result;
  });
  expect(resumedView.mounted).toBeGreaterThan(0);
  expect(resumedView.mounted).toBeLessThan(100);
  expect(resumedView.height).toBe(resumedView.fullHeight);
  expect(resumedView.first).toBe('tab:100');
  console.log('✓ Hidden updates resume with current geometry and rows after resize observation');

  const reordered = await page.evaluate(() => {
    const next = structuredClone(fixture);
    next.tabs.forEach((tab) => {
      tab.order = -tab.order;
    });
    viewportTest.set(next);
    viewportTest.full();
    const tree = document.getElementById('tree');
    const top = tree.getBoundingClientRect().top;
    const expected = [1, 100, 501, 600, 1000].map((id) => {
      const rect = document.querySelector(`[data-key="tab:${id}"]`).getBoundingClientRect();
      return { id, top: rect.top - top + tree.scrollTop };
    });
    viewportTest.set(structuredClone(fixture));
    viewportTest.reveal('tab:1000');
    viewportTest.patch(next);
    return expected;
  });
  for (const expected of reordered) {
    const actual = await page.evaluate((id) => {
      viewportTest.reveal(`tab:${id}`);
      const tree = document.getElementById('tree');
      const rect = document.querySelector(`[data-key="tab:${id}"]`).getBoundingClientRect();
      return { id, top: rect.top - tree.getBoundingClientRect().top + tree.scrollTop };
    }, expected.id);
    expect(actual).toEqual(expected);
  }
  await page.evaluate(() => {
    const next = structuredClone(fixture);
    next.tabs = next.tabs.slice(0, 150);
    viewportTest.reveal('tab:1000');
    viewportTest.patch(next);
  });
  const shortened = await page.evaluate(observeSidebar, { traverse: true });
  expect(shortened.duplicateRows).toEqual([]);
  expect(shortened.rows.map((row) => row.id)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  await page.evaluate(() => viewportTest.set(structuredClone(fixture)));
  console.log(
    '✓ Reordering at the same count and shrinking from the far end invalidate stale geometry',
  );

  for (const mode of ['light', 'dark', 'forced']) {
    await page.setViewportSize({ width: mode === 'light' ? 320 : 220, height: 820 });
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
      reducedMotion: 'reduce',
    });
    await page.evaluate(() => {
      viewportTest.reveal('tab:500');
      viewportTest.full();
    });
    const full = await page.locator('#tree').screenshot();
    await page.evaluate(() => viewportTest.redraw());
    const viewport = await page.locator('#tree').screenshot();
    await writeFile(`test-results/viewport-${mode}-full.png`, full);
    await writeFile(`test-results/viewport-${mode}.png`, viewport);
    const reference = await sharp(full).raw().toBuffer();
    const actual = await sharp(viewport).raw().toBuffer();
    expect(actual.equals(reference), `${mode} viewport pixels must match full rendering`).toBe(
      true,
    );
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none', reducedMotion: 'reduce' });
  console.log(
    '✓ Viewport pixels match full rendering in light, dark and forced colours at narrow widths',
  );

  for (const mode of ['light', 'dark', 'forced']) {
    await page.setViewportSize({ width: 220, height: 820 });
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
      reducedMotion: 'reduce',
    });
    await page.evaluate(async () => {
      const next = structuredClone(fixture);
      next.look.tintFavicons = true;
      for (const tab of next.tabs) {
        tab.favIconUrl =
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#d83a6e" opacity=".65"/></svg>',
          );
        tab.active = tab.id === 500;
        if (tab.id % 3 === 0) tab.container = { name: 'Work', colorCode: '#008080' };
        if (tab.id % 5 === 0) tab.audible = true;
        if (tab.id % 7 === 0) tab.mutedInfo = { muted: true };
      }
      viewportTest.set(next);
      viewportTest.reveal('tab:500');
      viewportTest.full();
      await Promise.all([...document.querySelectorAll('#tree img')].map((img) => img.decode()));
    });
    const full = await page.locator('#tree').screenshot();
    await page.evaluate(() => viewportTest.redraw());
    const virtual = await page.locator('#tree').screenshot();
    await writeFile(`test-results/viewport-rich-${mode}-full.png`, full);
    await writeFile(`test-results/viewport-rich-${mode}.png`, virtual);
    const reference = await sharp(full).raw().toBuffer();
    const actual = await sharp(virtual).raw().toBuffer();
    expect(
      actual.equals(reference),
      `${mode} favicons, tint and audio must match full rendering`,
    ).toBe(true);
    await page.evaluate(async () => {
      const tree = document.getElementById('tree');
      const top = tree.scrollTop;
      tree.scrollTop = top + 60;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      tree.scrollTop = top;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator('#tree')).toHaveClass(/viewport-wide-buffer/);
    const buffered = await page.locator('#tree').screenshot();
    await writeFile(`test-results/viewport-rich-${mode}-buffered.png`, buffered);
    expect(
      (await sharp(buffered).raw().toBuffer()).equals(reference),
      `${mode} gradual-scroll favicons, tint and audio must match full rendering`,
    ).toBe(true);
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none', reducedMotion: 'reduce' });
  await page.evaluate(() => viewportTest.set(structuredClone(fixture)));
  console.log(
    '✓ Virtual leaf rows preserve favicon alpha, container tint and audio pixels in all colour modes',
  );

  await page.evaluate(() => {
    viewportTest.reveal('group:g0');
    viewportTest.mount('group:g0').focus();
  });
  await page.keyboard.press('End');
  await expect(page.locator('[data-key="new-tab:null"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-key="group:g0"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="tab:1"]')).toBeFocused();
  await page.evaluate(() => {
    viewportTest.reveal('tab:500');
    viewportTest.mount('tab:500').querySelector('.close-tab').focus();
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-key="new-tab:g4"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-key="group:g5"]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-key="new-tab:g4"]')).toBeFocused();
  console.log('✓ Home/End, arrows and Tab cross unmounted row and folder boundaries');

  await page.evaluate(() => viewportTest.resetRows());
  const traversal = await page.evaluate(observeSidebar, { traverse: true });
  expect(traversal.duplicateRows).toEqual([]);
  expect(traversal.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 1000 }, (_, i) => i + 1),
  );
  expect(traversal.tabRows).toBeLessThan(100);
  const built = await page.evaluate(() => viewportTabBuilds);
  console.log(`Keyed viewport: ${built} tab rows built after full traversal`);
  await page.evaluate(observeSidebar, { traverse: true });
  expect((await page.evaluate(observeSidebar, { traverse: true })).rows).toEqual(traversal.rows);
  console.log('✓ A complete physical scroll reaches every tab in its authoritative order');

  // Recycling must transfer identity without affecting owned controls or richer rows.
  const pooledReuse = await page.evaluate(async () => {
    document.getElementById('home').focus();
    viewportTest.reveal('tab:10');
    const original = [...document.querySelectorAll('#tree .tab-row')].map((row) => ({
      row,
      key: row.dataset.key,
      wrapper: row.parentElement,
      close: row.querySelector('.close-tab'),
      label: row.querySelector('.label').firstChild,
    }));
    const tree = document.getElementById('tree');
    for (const top of [tree.scrollHeight / 2, tree.scrollHeight, 0]) {
      tree.scrollTop = top;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      const reused = original.find(
        (item) => item.row.isConnected && item.row.dataset.key !== item.key,
      );
      if (!reused) continue;
      window.viewportPoolReuse = { ...reused, currentId: Number(reused.row.dataset.id) };
      return {
        oldKey: reused.key,
        newKey: reused.row.dataset.key,
        currentId: Number(reused.row.dataset.id),
        wrapper: reused.row.parentElement === reused.wrapper,
        close: reused.row.querySelector('.close-tab') === reused.close,
        label: reused.row.querySelector('.label').firstChild === reused.label,
      };
    }
    return null;
  });
  expect(
    pooledReuse,
    'an actual mounted leaf must be rebound to another logical tab',
  ).not.toBeNull();
  expect(pooledReuse.newKey).not.toBe(pooledReuse.oldKey);
  expect(pooledReuse).toEqual(expect.objectContaining({ wrapper: true, close: true, label: true }));
  const poolCallStart = await page.evaluate(() => viewportTest.calls.length);
  await page.evaluate(() => viewportPoolReuse.close.click());
  await expect
    .poll(() => page.evaluate((start) => viewportTest.calls.slice(start), poolCallStart))
    .toContainEqual(expect.objectContaining({ type: 'closeTab', id: pooledReuse.currentId }));
  await page.evaluate(() => viewportPoolReuse.row.click());
  await expect
    .poll(() => page.evaluate((start) => viewportTest.calls.slice(start), poolCallStart))
    .toContainEqual(expect.objectContaining({ type: 'clickTab', id: pooledReuse.currentId }));
  expect(
    await page.evaluate(
      ({ start, oldKey }) =>
        viewportTest.calls
          .slice(start)
          .filter(
            (call) =>
              ['closeTab', 'clickTab'].includes(call.type) && call.id === Number(oldKey.slice(4)),
          ),
      { start: poolCallStart, oldKey: pooledReuse.oldKey },
    ),
  ).toEqual([]);
  console.log('✓ Pool reuse preserves controls and text nodes while actions use the new ID');

  await page.evaluate(() => {
    window.watchViewportPoolOwner = (control) => {
      const row = control.closest('.row');
      const key = row.dataset.key;
      const ancestry = new Set();
      for (let node = control; node && node.id !== 'tree'; node = node.parentNode)
        ancestry.add(node);
      let detached = 0;
      let preserved = 0;
      const moveBefore = Element.prototype.moveBefore;
      if (moveBefore)
        Element.prototype.moveBefore = function (node, reference) {
          const owned = this.isConnected && node.isConnected && ancestry.has(node);
          const result = moveBefore.call(this, node, reference);
          if (owned) preserved++;
          return result;
        };
      let rebound = 0;
      let blurred = 0;
      const onBlur = () => blurred++;
      control.addEventListener('blur', onBlur);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') rebound++;
          for (const node of record.removedNodes) if (ancestry.has(node)) detached++;
        }
      });
      observer.observe(document.getElementById('tree'), { childList: true, subtree: true });
      observer.observe(row, { attributes: true, attributeFilter: ['data-key', 'data-id'] });
      window.viewportPoolOwner = {
        stop: () => {
          observer.disconnect();
          if (moveBefore) Element.prototype.moveBefore = moveBefore;
          control.removeEventListener('blur', onBlur);
        },

        snapshot: () => ({
          key,
          currentKey: row.dataset.key,
          connected: control.isConnected,
          sameControl: control === row.querySelector('.close-tab') || control === row,
          // moveBefore emits removal records without disconnecting controls.
          // Count only removals that did not use that state-preserving API.
          detached: detached - preserved,
          rebound,
          blurred,
        }),
      };
    };
  });
  for (const owner of ['focused', 'pressed', 'menu']) {
    await page.evaluate((owner) => {
      viewportTest.reveal('tab:400');
      const row = viewportTest.mount('tab:400');
      const control = owner === 'menu' ? row : row.querySelector('.close-tab');
      document.getElementById('home').focus();
      if (owner === 'focused' || owner === 'menu') control.focus();
      if (owner === 'pressed')
        control.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 7,
            button: 0,
            isPrimary: true,
          }),
        );
      window.viewportPoolOwnerControl = control;
    }, owner);
    if (owner === 'menu') {
      await page.keyboard.press('Shift+F10');
      await expect(page.locator('#menu')).toBeVisible();
    }
    await page.evaluate(() => watchViewportPoolOwner(viewportPoolOwnerControl));
    await page.evaluate(observeSidebar, { traverse: true });
    expect(await page.evaluate(() => viewportPoolOwner.snapshot())).toEqual({
      key: 'tab:400',
      currentKey: 'tab:400',
      connected: true,
      sameControl: true,
      detached: 0,
      rebound: 0,
      blurred: 0,
    });
    if (owner === 'focused')
      expect(await page.evaluate(() => document.activeElement === viewportPoolOwnerControl)).toBe(
        true,
      );
    if (owner === 'menu') {
      await expect(page.locator('#menu')).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.activeElement === viewportPoolOwnerControl)).toBe(
        true,
      );
    }
    await page.evaluate(() => viewportPoolOwner.stop());
    if (owner === 'pressed') {
      await page.evaluate(async () => {
        document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  console.log(
    '✓ Focused, pressed and menu-owned pool rows are neither detached nor rebound during full traversal',
  );

  await page.evaluate(async () => {
    document.getElementById('home').focus();
    viewportTest.reveal('tab:700');
    const first = viewportTest.mount('tab:700').querySelector('.close-tab');
    first.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, isPrimary: true }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 9, button: 0, isPrimary: true }),
    );
    viewportTest.reveal('tab:800');
    window.newerPress = viewportTest.mount('tab:800').querySelector('.close-tab');
    newerPress.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, isPrimary: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await page.evaluate(observeSidebar, { traverse: true });
  expect(
    await page.evaluate(() => ({
      connected: newerPress.isConnected,
      key: newerPress.closest('[data-key]')?.dataset.key,
    })),
  ).toEqual({ connected: true, key: 'tab:800' });
  await page.evaluate(async () => {
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    delete window.newerPress;
  });
  console.log('✓ An earlier pointer-release task cannot release a newer pressed row for reuse');

  await page.evaluate(() => {
    document.getElementById('home').focus();
    window.simultaneousPresses = [];
    for (const [id, pointerId] of [
      [700, 11],
      [800, 12],
    ]) {
      viewportTest.reveal(`tab:${id}`);
      const control = viewportTest.mount(`tab:${id}`).querySelector('.close-tab');
      control.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId,
          button: 0,
          isPrimary: pointerId === 11,
        }),
      );
      simultaneousPresses.push({ control, id, pointerId });
    }
  });
  await page.evaluate(observeSidebar, { traverse: true });
  expect(
    await page.evaluate(() =>
      simultaneousPresses.map(({ control, id }) => ({
        connected: control.isConnected,
        key: control.closest('[data-key]')?.dataset.key,
        id,
      })),
    ),
  ).toEqual([
    { connected: true, key: 'tab:700', id: 700 },
    { connected: true, key: 'tab:800', id: 800 },
  ]);
  await page.evaluate(async () => {
    for (const { pointerId } of simultaneousPresses)
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    delete window.simultaneousPresses;
  });
  console.log('✓ Every simultaneous pointer owner remains attached to its original tab');

  for (const owner of ['pressed', 'menu']) {
    await page.evaluate((owner) => {
      document.getElementById('home').focus();
      viewportTest.reveal('tab:700');
      window.removedOwner = viewportTest.mount('tab:700');
      window.removedControl = removedOwner.querySelector('.close-tab');
      if (owner === 'pressed')
        removedControl.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 14,
            button: 0,
            isPrimary: true,
          }),
        );
      else removedOwner.focus();
    }, owner);
    if (owner === 'menu') {
      await page.keyboard.press('Shift+F10');
      await expect(page.locator('#menu')).toBeVisible();
    }
    const callsBeforeRemoval = await page.evaluate(() => viewportTest.calls.length);
    await page.evaluate((owner) => {
      // State updates may render after pointerup, before its queued click.
      if (owner === 'pressed')
        document.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, pointerId: 14, button: 0 }),
        );
      const next = structuredClone(fixture);
      next.tabs = next.tabs.filter((tab) => tab.id !== 700);
      viewportTest.patch(next);
    }, owner);
    await page.evaluate(observeSidebar, { traverse: true });
    expect(
      await page.evaluate(() => ({
        connected: removedOwner.isConnected,
        key: removedOwner.dataset.key,
      })),
    ).toEqual({ connected: false, key: 'tab:700' });
    if (owner === 'menu') await expect(page.locator('#menu')).toBeHidden();
    await page.evaluate(() => removedControl.click());
    expect(
      await page.evaluate(
        (start) => viewportTest.calls.slice(start).filter((call) => call.type === 'closeTab'),
        callsBeforeRemoval,
      ),
    ).toEqual([]);
    await page.evaluate(async () => {
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 14 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      viewportTest.set(structuredClone(fixture));
      delete window.removedOwner;
      delete window.removedControl;
    });
  }
  console.log('✓ Removing a pressed or menu-owned tab cannot reassign its controls to another tab');

  await page.evaluate(() => {
    window.viewportPoolShape = structuredClone(fixture);
    viewportPoolShape.tabs.find((tab) => tab.id === viewportPoolReuse.currentId).title =
      'Pool shape transition';
    viewportTest.set(structuredClone(viewportPoolShape));
    viewportTest.reveal(`tab:${viewportPoolReuse.currentId}`);
    window.viewportPoolShapeControl = viewportTest
      .mount(`tab:${viewportPoolReuse.currentId}`)
      .querySelector('.close-tab');
    viewportPoolShapeControl.focus();
    watchViewportPoolOwner(viewportPoolShapeControl);
  });
  const poolShapeRow = page.locator(`[data-key="tab:${pooledReuse.currentId}"]`);
  for (const shape of ['audio', 'favicon', 'container', 'parent', 'domain-lines']) {
    await page.evaluate((shape) => {
      const next = structuredClone(viewportPoolShape);
      const tab = next.tabs.find((tab) => tab.id === viewportPoolReuse.currentId);
      if (shape === 'audio') tab.audible = true;
      if (shape === 'favicon')
        tab.favIconUrl =
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Crect width="16" height="16" fill="red"/%3E%3C/svg%3E';
      if (shape === 'container') {
        tab.container = {
          name: 'Pool container',
          colorCode: '#0088ff',
          cookieStoreId: 'firefox-container-pool',
        };
        tab.cookieStoreId = 'firefox-container-pool';
        next.containers = [tab.container];
        next.look.tintFavicons = true;
      }
      if (shape === 'parent') {
        const child = next.tabs.find(
          (child) => child.id !== tab.id && child.groupId === tab.groupId,
        );
        child.parentTabId = tab.id;
      }
      if (shape === 'domain-lines') next.look.domains = true;
      viewportTest.patch(next);
      viewportTest.reveal(`tab:${tab.id}`);
    }, shape);
    if (shape === 'audio') {
      await expect(poolShapeRow.locator('.audio-button')).toHaveAttribute('aria-label', 'Mute tab');
      await expect(poolShapeRow).toHaveAttribute(
        'aria-label',
        'Pool shape transition, This tab is playing audio',
      );
    } else if (shape === 'favicon') {
      await expect(poolShapeRow.locator('.tab-icon img')).toHaveCount(1);
      await expect
        .poll(() =>
          poolShapeRow
            .locator('.tab-icon img')
            .evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
    } else if (shape === 'container') {
      await expect(poolShapeRow).toHaveAttribute(
        'aria-label',
        'Pool shape transition, container: Pool container',
      );
      expect(
        await poolShapeRow.evaluate((row) => row.style.getPropertyValue('--label-color')),
      ).toContain('var(--caption-');
      expect(
        await poolShapeRow
          .locator('.tab-icon')
          .evaluate((icon) => icon.style.getPropertyValue('--favicon-filter')),
      ).not.toBe('');
    } else if (shape === 'parent') {
      await expect(poolShapeRow.locator('.tab-disclosure')).toHaveCount(1);
      await expect(poolShapeRow).toHaveAttribute('aria-expanded', 'true');
      await expect(poolShapeRow).toHaveAttribute(
        'aria-label',
        'Pool shape transition, 1 nested tab',
      );
    } else {
      await expect(poolShapeRow.locator('.row-copy .row-detail')).toHaveText('example.com');
      await expect(poolShapeRow).toHaveCSS('min-height', '38px');
    }
    expect(await page.evaluate(() => document.activeElement === viewportPoolShapeControl)).toBe(
      true,
    );
    await page.evaluate(() => viewportTest.patch(structuredClone(viewportPoolShape)));
    await expect(poolShapeRow).toHaveAttribute('aria-label', 'Pool shape transition');
    await expect(
      poolShapeRow.locator('.audio-button, .tab-disclosure, .row-copy, .tab-icon img'),
    ).toHaveCount(0);
    await expect(poolShapeRow.locator('.close-tab')).toHaveCount(1);
    await expect(poolShapeRow).not.toHaveAttribute('aria-expanded');
    await expect(poolShapeRow).not.toHaveAttribute('aria-description');
    expect(
      await poolShapeRow.evaluate((row) => ({
        label: row.style.getPropertyValue('--label-color'),
        tint: row.querySelector('.tab-icon').style.getPropertyValue('--favicon-filter'),
      })),
    ).toEqual({ label: expect.stringMatching(/^(?:currentColor)?$/), tint: '' });
    expect(await page.evaluate(() => document.activeElement === viewportPoolShapeControl)).toBe(
      true,
    );
  }
  expect(await page.evaluate(() => viewportPoolOwner.snapshot())).toEqual({
    key: pooledReuse.newKey,
    currentKey: pooledReuse.newKey,
    connected: true,
    sameControl: true,
    detached: 0,
    rebound: 0,
    blurred: 0,
  });
  await page.evaluate(() => viewportPoolOwner.stop());
  await page.evaluate(() => viewportTest.poolDomain('example.com', viewportPoolReuse.currentId));
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  await expect(poolShapeRow).toHaveAttribute('aria-description', /Folder: Home/);
  await expect(poolShapeRow.locator('.close-tab')).toHaveCount(1);
  await page.evaluate(() => viewportTest.poolDomain(null));
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  await page.evaluate(() => viewportTest.reveal(`tab:${viewportPoolReuse.currentId}`));
  await expect(poolShapeRow).not.toHaveAttribute('aria-description');
  await expect(
    poolShapeRow.locator('.audio-button, .tab-disclosure, .row-copy, .tab-icon img'),
  ).toHaveCount(0);
  await page.evaluate(() => {
    document.getElementById('home').focus();
    viewportTest.set(structuredClone(fixture));
    delete window.viewportPoolReuse;
    delete window.viewportPoolShape;
    delete window.viewportPoolShapeControl;
    delete window.viewportPoolOwner;
    delete window.viewportPoolOwnerControl;
    delete window.watchViewportPoolOwner;
  });
  console.log(
    '✓ Recycled rows transition through audio, favicon, container, parent and domain shapes without stale controls or styles',
  );

  const iconReuse = await page.evaluate(async () => {
    const next = structuredClone(fixture);
    for (const tab of next.tabs)
      tab.favIconUrl =
        'data:image/svg+xml,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#${tab.id.toString(16).padStart(6, '0')}"/></svg>`,
        );
    document.getElementById('home').focus();
    viewportTest.set(next);
    viewportTest.reveal('tab:10');
    const before = [...document.querySelectorAll('#tree .tab-row')].map((row) => ({
      row,
      key: row.dataset.key,
      image: row.querySelector('img'),
      close: row.querySelector('.close-tab'),
    }));
    const tree = document.getElementById('tree');
    for (const top of [tree.scrollHeight / 2, tree.scrollHeight, 0]) {
      tree.scrollTop = top;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      const reused = before.find(
        (item) => item.row.isConnected && item.row.dataset.key !== item.key,
      );
      if (!reused) continue;
      const current = next.tabs.find((tab) => tab.id === Number(reused.row.dataset.id));
      const image = reused.row.querySelector('img');
      const result = {
        changedOwner: true,
        sameControl: reused.close === reused.row.querySelector('.close-tab'),
        changedImage: image !== reused.image,
        correctSource: image?.getAttribute('src') === current.favIconUrl,
      };
      // A response for the old icon must never damage the new owner's icon.
      reused.image.dispatchEvent(new Event('error'));
      result.oldFailureIgnored =
        reused.row.querySelector('img') === image &&
        !reused.row.querySelector('.tab-icon').classList.contains('tab-globe');
      image.dispatchEvent(new Event('error'));
      result.currentFailureHandled =
        !reused.row.querySelector('img') &&
        reused.row.querySelector('.tab-icon').classList.contains('tab-globe');
      const failedOwner = reused.row.dataset.key;
      const common = structuredClone(next);
      for (const tab of common.tabs) tab.favIconUrl = current.favIconUrl;
      viewportTest.patch(common);
      result.retryForNextOwner = false;
      for (const offset of [0, tree.scrollHeight, tree.scrollHeight / 2]) {
        tree.scrollTop = offset;
        tree.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);
        if (reused.row.isConnected && reused.row.dataset.key !== failedOwner) {
          result.retryForNextOwner =
            reused.row.querySelector('img')?.getAttribute('src') === current.favIconUrl;
          break;
        }
      }
      viewportTest.set(structuredClone(fixture));
      return result;
    }
    return null;
  });
  expect(iconReuse).toEqual({
    changedOwner: true,
    sameControl: true,
    changedImage: true,
    correctSource: true,
    oldFailureIgnored: true,
    currentFailureHandled: true,
    retryForNextOwner: true,
  });
  console.log(
    '✓ Recycled favicon rows keep controls and isolate late failures from the previous icon',
  );

  const beforeBudgetViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 820 });
  await page.evaluate(() => {
    window.budgetFixture = structuredClone(fixture);
    for (const tab of budgetFixture.tabs) tab.audible = true;
    document.getElementById('home').focus();
    viewportTest.set(structuredClone(budgetFixture));
  });
  await page.evaluate(observeSidebar, { traverse: true });
  await page.evaluate(() => {
    for (const tab of budgetFixture.tabs) tab.audible = false;
    viewportTest.set(structuredClone(budgetFixture));
  });
  await page.setViewportSize({ width: 320, height: 220 });
  const dormantBudget = async () =>
    page.evaluate(() => {
      const keys = [
        ...fixture.tabs.flatMap((tab) => [
          `tab:${tab.id}`,
          `pin:${tab.id}`,
          `new-child-tab:${tab.id}`,
        ]),
        ...fixture.groups.flatMap((group) => [
          `group:${group.id}`,
          `pin:group:${group.id}`,
          `new-tab:${group.id}`,
        ]),
        'new-tab:null',
      ];
      const cached = viewportTest.cached(keys);
      const mounted = new Set(
        [...document.querySelectorAll('#tree [data-key], #pinned-tabs [data-key]')].map(
          (node) => node.dataset.key,
        ),
      );
      return {
        pooled: cached.pooled,
        dormant: cached.pooled + cached.keys.filter((key) => !mounted.has(key)).length,
      };
    });
  await expect.poll(async () => (await dormantBudget()).pooled).toBeGreaterThan(0);
  expect((await dormantBudget()).dormant).toBeLessThanOrEqual(96);
  await page.evaluate(() => {
    budgetFixture.look.domains = true;
    viewportTest.set(structuredClone(budgetFixture));
  });
  expect((await dormantBudget()).pooled).toBe(0);
  expect((await dormantBudget()).dormant).toBeLessThanOrEqual(96);
  await page.evaluate(() => {
    delete window.budgetFixture;
    viewportTest.set(structuredClone(fixture));
  });
  await page.setViewportSize(beforeBudgetViewport);
  console.log(
    '✓ Recycling and identity caching share the dormant budget; two-line views release unused pooled rows',
  );

  await page.evaluate(() => {
    viewportTest.reveal('tab:500');
    window.focusedControl = viewportTest.mount('tab:500').querySelector('.close-tab');
    focusedControl.focus();
    window.focusLost = 0;
    focusedControl.addEventListener('blur', () => focusLost++);
    window.detachedFocus = 0;
    window.focusObserver = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node === focusedControl || node.contains?.(focusedControl)) detachedFocus++;
    });
    focusObserver.observe(document.getElementById('tree'), { subtree: true, childList: true });
    window.survivorWrites = 0;
    window.survivorObserver = new MutationObserver((records) => {
      survivorWrites += records.length;
    });
    survivorObserver.observe(focusedControl.closest('.row'), {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
  });
  await page.evaluate(observeSidebar, { traverse: true });
  expect(await page.evaluate(() => survivorWrites)).toBe(0);
  await page.evaluate(() => survivorObserver.disconnect());
  await page.evaluate(() => {
    fixture.tabs[499].title = 'Needle 0499 focused title changed';
    viewportTest.patch(structuredClone(fixture));
  });
  expect(
    await page.evaluate(() => ({
      same: focusedControl === document.activeElement,
      label: focusedControl.getAttribute('aria-label'),
      focusLost,
      detachedFocus,
    })),
  ).toEqual({
    same: true,
    label: 'Close Needle 0499 focused title changed',
    focusLost: 0,
    detachedFocus: 0,
  });
  await page.evaluate(() => focusObserver.disconnect());
  console.log('✓ Keyed rows keep focused controls attached through scrolling and title changes');

  const patchedContent = await page.evaluate(() => {
    const next = structuredClone(fixture);
    const tab = next.tabs[499];
    tab.favIconUrl =
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/%3E';
    tab.audible = true;
    tab.container = { name: 'Work', colorCode: '#008080' };
    next.look.domains = true;
    viewportTest.set(next);
    viewportTest.reveal('tab:500');
    const row = viewportTest.mount('tab:500');
    const image = row.querySelector('img');
    const close = row.querySelector('.close-tab');
    const mute = row.querySelector('.audio-button');
    close.focus();
    const builds = viewportTabBuilds;
    const changed = structuredClone(next);
    changed.tabs[499].title = 'Updated work page';
    changed.tabs[499].url = 'https://changed.example/path';
    viewportTest.patch(changed);
    const result = {
      sameImage: row.querySelector('img') === image,
      sameClose: row.querySelector('.close-tab') === close,
      sameMute: row.querySelector('.audio-button') === mute,
      focused: document.activeElement === close,
      title: row.querySelector('.label').textContent,
      domain: row.querySelector('.row-detail').textContent,
      label: row.getAttribute('aria-label'),
      closeLabel: close.getAttribute('aria-label'),
      built: viewportTabBuilds - builds,
    };
    // A later image failure must still repair the retained icon.
    image.dispatchEvent(new Event('error'));
    result.fallback = row.querySelector('.tab-icon').classList.contains('tab-globe');
    result.imageRemoved = !image.isConnected;
    viewportTest.set(structuredClone(fixture));
    return result;
  });
  expect(patchedContent).toEqual({
    sameImage: true,
    sameClose: true,
    sameMute: true,
    focused: true,
    title: 'Updated work page',
    domain: 'changed.example',
    label: 'Updated work page, container: Work, This tab is playing audio',
    closeLabel: 'Close Updated work page',
    built: 0,
    fallback: true,
    imageRemoved: true,
  });
  console.log(
    '✓ Title/URL updates preserve loaded images, audio controls and focus without row builds',
  );

  await page.evaluate(() => {
    viewportTest.reveal('tab:700');
    window.pressedControl = viewportTest.mount('tab:700').querySelector('.close-tab');
    document.getElementById('home').focus();
    pressedControl.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, isPrimary: true }),
    );
  });
  await page.evaluate(async () => {
    const tree = document.getElementById('tree');
    for (const top of [0, tree.scrollHeight]) {
      tree.scrollTop = top;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
    }
  });
  expect(
    await page.evaluate(() => ({
      connected: pressedControl.isConnected,
      identity: pressedControl.closest('[data-key]')?.dataset.key,
      focused: pressedControl === document.activeElement,
    })),
  ).toEqual({ connected: true, identity: 'tab:700', focused: false });
  await page.evaluate(() =>
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })),
  );
  await page.evaluate(() => {
    viewportTest.reveal('tab:500');
    window.menuOwner = viewportTest.mount('tab:500');
    menuOwner.focus();
  });
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('#menu')).toBeVisible();
  await page.evaluate(async () => {
    const tree = document.getElementById('tree');
    tree.scrollTop = 0;
    tree.dispatchEvent(new Event('scroll'));
    await new Promise(requestAnimationFrame);
  });
  expect(await page.evaluate(() => menuOwner.isConnected)).toBe(true);
  await expect(page.locator('#menu')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement === menuOwner)).toBe(true);
  console.log('✓ Pressed controls and context-menu owners survive offscreen range changes');

  await page.evaluate(() => viewportTest.search('Needle'));
  expect(await page.evaluate(() => viewportTest.targets().length)).toBe(1000);
  expect(await page.locator('.tab-row').count()).toBeLessThan(100);
  await page.evaluate(() => viewportTest.search('0999'));
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await expect(page.locator('[data-key="tab:1000"]')).toBeVisible();
  await page.evaluate(() => viewportTest.search(''));
  await page.evaluate(() => {
    viewportTest.reveal('tab:1');
    fixture.tabs[999].title = 'Changed offscreen';
    fixture.tabs[999].mutedInfo = { muted: true };
    viewportTest.patch(structuredClone(fixture));
    viewportTest.reveal('tab:1000');
  });
  await expect(page.locator('[data-key="tab:1000"] .label')).toHaveText('Changed offscreen');
  await expect(page.locator('[data-key="tab:1000"] .audio-button')).toHaveAttribute(
    'aria-label',
    'Unmute tab',
  );
  await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute('aria-posinset', '100');
  await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute('aria-setsize', '101');
  await page.locator('[data-key="tab:1000"] .close-tab').click();
  expect(await page.evaluate(() => viewportTest.calls)).toContainEqual(
    expect.objectContaining({ type: 'closeTab', id: 1000 }),
  );
  expect(errors).toEqual([]);
  console.log(
    '✓ Complete search targets, far-end matches, latest metadata and close identity survive virtualisation',
  );

  await page.evaluate(() => {
    fixture.groups[1].parentId = 'g0';
    fixture.groups[2].parentId = 'g1';
    for (let i = 1; i < 8; i++) fixture.tabs[i].parentTabId = i;
    fixture.tabs[1].collapsed = true;
    viewportTest.set(structuredClone(fixture));
    viewportTest.reveal('tab:2');
  });
  await expect(page.locator('[data-key="tab:2"]')).toHaveAttribute('aria-level', '3');
  await expect(page.locator('[data-key="tab:3"]')).toHaveCount(0);
  const nested = await page.evaluate(observeSidebar, { traverse: true });
  expect(nested.rows.map((row) => row.id)).toEqual([
    ...Array.from({ length: 100 }, (_, i) => i + 201),
    ...Array.from({ length: 100 }, (_, i) => i + 101),
    1,
    2,
    ...Array.from({ length: 92 }, (_, i) => i + 9),
    ...Array.from({ length: 700 }, (_, i) => i + 301),
  ]);
  const nestedGeometry = await page.evaluate(() => {
    viewportTest.full();
    const tree = document.getElementById('tree');
    const top = tree.getBoundingClientRect().top;
    const rows = ['group:g2', 'tab:300', 'tab:101', 'tab:200', 'tab:1', 'tab:100', 'group:g3'].map(
      (key) => {
        const rect = document.querySelector(`[data-key="${key}"]`).getBoundingClientRect();
        return { key, top: rect.top - top + tree.scrollTop, height: rect.height };
      },
    );
    const height = tree.scrollHeight;
    viewportTest.redraw();
    return { rows, height };
  });
  for (const expected of nestedGeometry.rows) {
    const actual = await page.evaluate((key) => {
      viewportTest.reveal(key);
      const tree = document.getElementById('tree');
      const rect = document.querySelector(`[data-key="${key}"]`).getBoundingClientRect();
      return {
        key,
        top: rect.top - tree.getBoundingClientRect().top + tree.scrollTop,
        height: rect.height,
      };
    }, expected.key);
    expect(actual).toEqual(expected);
  }
  expect(await page.locator('#tree').evaluate((tree) => tree.scrollHeight)).toBe(
    nestedGeometry.height,
  );
  await page.evaluate(() => viewportTest.search('0007'));
  await expect(page.locator('[data-key="tab:8"]')).toBeVisible();
  expect(await page.evaluate(() => viewportTest.targets())).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  await page.evaluate(() => viewportTest.search(''));
  await expect(page.locator('[data-key="tab:3"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    '✓ Nested folders, collapsed tab descendants and search expansion preserve logical order',
  );

  // A deep branch must not change the horizontal extent merely because its
  // rows leave the vertical viewport: that would clamp the user's horizontal scroll.
  const horizontal = await page.evaluate(() => {
    fixture.tabs[1].collapsed = false;
    for (let i = 1; i < 35; i++) fixture.tabs[i].parentTabId = i;
    viewportTest.set(structuredClone(fixture));
    viewportTest.full();
    const tree = document.getElementById('tree');
    const full = tree.scrollWidth;
    viewportTest.redraw();
    viewportTest.reveal('tab:1000');
    return { full, virtual: tree.scrollWidth };
  });
  expect(horizontal.virtual).toBe(horizontal.full);
  console.log('✓ Horizontal overflow remains stable when a deep branch leaves the viewport');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    fixture.tabs.forEach((tab) => {
      tab.parentTabId = null;
      tab.collapsed = false;
    });
    fixture.groups.forEach((group) => {
      group.parentId = null;
    });
    fixture.look.animations = true;
    viewportTest.set(structuredClone(fixture));
    viewportTest.reveal('group:g0');
    window.outgoingRow = document.querySelector('[data-key="tab:1"]');
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches('.branch, .tab-branch')) {
        animation.pause();
        animation.currentTime = 20;
      }
      return animation;
    };
    fixture.view.collapsed = ['g0'];
    viewportTest.set(structuredClone(fixture), 'group:g0');
  });
  await expect(page.locator('[data-tree-motion]')).toHaveCount(1);
  expect(
    await page.evaluate(() => outgoingRow.isConnected && Boolean(outgoingRow.closest('[inert]'))),
  ).toBe(true);
  await page.evaluate(() => document.getElementById('tree').dispatchEvent(new Event('scroll')));
  expect(await page.evaluate(() => outgoingRow.isConnected)).toBe(true);
  const motionGeometry = await page.evaluate(() => {
    const tree = document.getElementById('tree');
    const branch = document.querySelector('[data-tree-motion]');
    const sibling = document.querySelector('[data-key="group:g1"]');

    const sample = () => ({
      branchHeight: branch.getBoundingClientRect().height,
      siblingTop:
        sibling.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop,
    });

    const before = sample();
    const animation = branch.getAnimations().find((item) => item.effect.target === branch);
    animation.currentTime = Number(animation.effect.getTiming().duration) * 0.75;
    return { before, after: sample() };
  });
  expect(motionGeometry.before.branchHeight).toBeGreaterThan(motionGeometry.after.branchHeight);
  expect(motionGeometry.after.branchHeight).toBeGreaterThan(0);
  expect(motionGeometry.before.siblingTop - motionGeometry.after.siblingTop).toBeCloseTo(
    motionGeometry.before.branchHeight - motionGeometry.after.branchHeight,
    0,
  );
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
  await expect(page.locator('[data-tree-motion]')).toHaveCount(0);
  await expect(page.locator('[data-key="tab:1"]')).toHaveCount(0);
  const settledSiblingTop = await page.evaluate(() => {
    const tree = document.getElementById('tree');
    const sibling = document.querySelector('[data-key="group:g1"]');
    return sibling.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop;
  });
  expect(settledSiblingTop).toBeCloseTo(
    motionGeometry.after.siblingTop - motionGeometry.after.branchHeight,
    0,
  );
  console.log(
    '✓ Animated exits keep their visuals owned until completion before rows are released',
  );
  expect(errors).toEqual([]);
} finally {
  await close();
}
