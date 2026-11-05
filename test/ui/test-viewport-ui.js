import { instrumentViewport, instrumentSource } from '../helpers/probes/viewport.js';
import { instrumentRows } from '../helpers/probes/rows.js';
import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startUiTest } from '../helpers/ui-test.js';
import { observeSidebar } from '../../scripts/memory/native-settlement.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 820 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const viewportSource = await readFile('extension/src/tree/viewport.js', 'utf8');
  const viewportApi = '  const api = {';
  expect(viewportSource.split(viewportApi)).toHaveLength(2);
  await page.route('**/extension/src/tree/viewport.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: instrumentViewport(viewportSource, viewportApi),
    }),
  );
  const rowSource = await readFile('extension/src/sidebar/rows.js', 'utf8');
  await page.route('**/extension/src/sidebar/rows.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: instrumentRows(rowSource) }),
  );
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: instrumentSource(source),
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
      firstReleased:
        !tree.querySelector('[data-key="tab:1000"]') &&
        !tree.querySelector('[data-key="group:g9"]'),
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

  for (const mode of ['search', 'domain']) {
    for (const domains of [false, true]) {
      await page.evaluate(
        ({ mode, domains }) => {
          const next = structuredClone(fixture);
          next.look.domains = domains;
          for (const tab of next.tabs) {
            tab.title += ' A long title with enough words to exceed the available sidebar width';
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
        expect(actual.height).toBe(domains ? 36 : 28);
      }
      expect(await page.locator('#tree').evaluate((node) => node.scrollHeight)).toBe(
        reference.height,
      );
      if (mode !== 'domain') {
        await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute('aria-posinset', '100');
        await expect(page.locator('[data-key="tab:1000"]')).toHaveAttribute('aria-setsize', '100');
        await page.evaluate(() => {
          viewportTest.reveal('tab:801');
          viewportTest.mount('tab:801').focus();
          document.getElementById('tree').scrollTop = 0;
        });
        await page.waitForTimeout(50);
        await expect(page.locator('[data-key="tab:801"]')).toBeFocused();
      }
      if (mode === 'search') {
        await page.evaluate(() => {
          viewportTest.reveal('tab:799');
          viewportTest.mount('tab:799').querySelector('.close-tab').focus();
        });
        await page.keyboard.press('Tab');
        await expect(page.locator('[data-key="tab:800"]')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.locator('[data-key="tab:799"] .close-tab')).toBeFocused();
      }
      await page.evaluate(() => {
        viewportTest.poolDomain(null);
        viewportTest.search('');
        viewportTest.set(structuredClone(fixture));
      });
    }
  }
  console.log(
    '✓ Search and domain results share fixed rows, exact geometry, row ARIA and retained focus',
  );

  for (const width of [220, 480]) {
    await page.setViewportSize({ width, height: 820 });
    for (const [sidebarSize, domains] of [
      ['default', false],
      ['comfortable', false],
      ['large', false],
      ['large', true],
      ['comfortable', true],
      ['default', true],
      ['default', false],
    ]) {
      const reference = await page.evaluate(
        ({ sidebarSize, domains }) => {
          fixture.look.sidebarSize = sidebarSize;
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
        },
        { sidebarSize, domains },
      );
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
  console.log(
    '✓ Viewport geometry matches full nested rendering at both widths, all sizes and line modes',
  );

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
      await expect(poolShapeRow).toHaveCSS('min-height', '36px');
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
    // Start with this fixture's controls: dormant rows from the preceding shape
    // transitions can otherwise leave the watched row unused throughout these jumps.
    viewportTest.resetRows();
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
  await page.evaluate(async () => {
    const tree = document.getElementById('tree');
    for (const offset of [tree.scrollHeight, 0, tree.scrollHeight / 2]) {
      tree.scrollTop = offset;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      for (const row of tree.querySelectorAll('.tab-row'))
        if (row.querySelector('.row-detail')?.textContent !== 'example.com')
          throw Error('Two-line virtual reuse lost a domain label');
    }
  });
  expect((await dormantBudget()).pooled).toBeLessThanOrEqual(64);
  expect((await dormantBudget()).dormant).toBeLessThanOrEqual(96);
  await page.evaluate(() => {
    delete window.budgetFixture;
    viewportTest.set(structuredClone(fixture));
  });
  await page.setViewportSize(beforeBudgetViewport);
  console.log(
    '✓ Recycling and identity caching share the dormant budget; line-mode switches clear old views and preserve both dormant budgets',
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

  await page.setViewportSize({ width: 220, height: 820 });
  for (const count of [99, 100, 101, 100, 99]) {
    await page.evaluate((count) => {
      const next = structuredClone(fixture);
      next.tabs = [];
      next.groups = Array.from({ length: count }, (_, i) => ({
        id: `boundary-${i}`,
        name: `Boundary ${i}`,
        parentId: null,
      }));
      next.view = { scopeId: null, collapsed: next.groups.map((group) => group.id) };
      next.look.animations = false;
      viewportTest.set(next);
      viewportTest.search('Boundary');
    }, count);
    const result = await page.evaluate(() => ({
      virtual: document.getElementById('tree').classList.contains('viewport-tree'),
      mounted: document.querySelectorAll('#tree .group-row').length,
    }));
    expect(result.virtual).toBe(count > 100);
    if (count <= 100) expect(result.mounted).toBe(count);
    else expect(result.mounted).toBeLessThan(count);
    expect(
      await page.evaluate(
        (count) => Boolean(viewportTest.mount(`group:boundary-${count - 1}`)?.isConnected),
        count,
      ),
    ).toBe(true);
  }
  console.log('✓ Narrow filtered trees cross the 100-row rendering boundary in both directions');
  const folderReuse = await page.evaluate(async () => {
    viewportTest.search('');
    viewportTest.poolDomain(null);
    const next = structuredClone(fixture);
    next.tabs = [];
    next.groups = Array.from({ length: 500 }, (_, i) => ({
      id: `reuse-${i}`,
      name: `Reuse folder ${i}`,
      parentId: null,
    }));
    next.view = { scopeId: null, collapsed: [] };
    viewportTest.set(next);
    viewportTest.resetRows();
    viewportTest.reveal('group:reuse-0');
    viewportGroupBuilds = 0;
    viewportCreationBuilds = 0;
    const tree = document.getElementById('tree');
    const first = tree.querySelector('[data-key="group:reuse-0"]');
    const children = [...first.childNodes];
    const icon = first.querySelector('.disclosure').firstChild;
    const changed = structuredClone(next);
    changed.tabs = [
      {
        id: 9001,
        treeId: 'reuse-tab',
        windowId: 1,
        index: 0,
        order: 0,
        groupId: 'reuse-0',
        parentTabId: null,
        title: 'Playing',
        audible: true,
      },
    ];
    viewportTest.patch(changed);
    const counted = tree.querySelector('[data-key="group:reuse-0"]');
    const patched =
      first === counted &&
      children.every((child) => counted.contains(child)) &&
      counted.querySelector('.group-count').textContent === '1' &&
      counted.querySelector('.disclosure').firstChild === icon &&
      counted.querySelector('.audio-indicator')?.getAttribute('aria-label') ===
        '1 tab playing audio in this folder';
    viewportTest.patch(next);
    const silent =
      !first.querySelector('.audio-indicator') &&
      first.querySelector('.group-count').textContent === '0';
    document.getElementById('home').focus();
    let correct = true,
      maxPool = 0;
    for (let offset = 0; offset < tree.scrollHeight; offset += 620) {
      tree.scrollTop = offset;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      maxPool = Math.max(maxPool, sidebarRowsProbe().totalPooled);
      for (const row of tree.querySelectorAll('.group-row')) {
        const i = Number(row.dataset.id.slice('reuse-'.length));
        correct &&=
          row.dataset.dropId === row.dataset.id &&
          row.querySelector('.label').textContent === `Reuse folder ${i}`;
      }
      for (const add of tree.querySelectorAll('.new-tab-action'))
        correct &&=
          add.dataset.key === `new-tab:${add.dataset.groupId || 'null'}` &&
          add.closest('.new-tab-item').dataset.dropId === add.dataset.groupId;
    }
    return {
      patched,
      silent,
      correct,
      maxPool,
      groups: viewportGroupBuilds,
      creation: viewportCreationBuilds,
    };
  });
  expect(folderReuse.patched).toBe(true);
  expect(folderReuse.silent).toBe(true);
  expect(folderReuse.correct).toBe(true);
  expect(folderReuse.maxPool).toBeLessThanOrEqual(64);
  expect(folderReuse.groups).toBeLessThan(150);
  expect(folderReuse.creation).toBeLessThan(150);
  const reusedAdd = page.locator('#tree .new-tab-action[data-group-id^="reuse-"]').last();
  const destination = await reusedAdd.getAttribute('data-group-id');
  await reusedAdd.click();
  expect(await page.evaluate(() => viewportTest.calls.at(-1))).toMatchObject({
    type: 'newTab',
    groupId: destination,
  });
  console.log(
    '✓ Folder and creation rows reuse bounded controls with current identities and in-place counts/audio',
  );

  await page.evaluate(() => {
    document.getElementById('home').focus();
    viewportTest.reveal('group:reuse-0');
  });
  const heldCreation = page.locator('[data-key="new-tab:reuse-0"]');
  await heldCreation.scrollIntoViewIfNeeded();
  const heldBounds = await heldCreation.boundingBox();
  await page.mouse.move(heldBounds.x + heldBounds.width / 2, heldBounds.y + heldBounds.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    window.heldCreation = document.querySelector('[data-key="new-tab:reuse-0"]');
    document.getElementById('tree').scrollTop = document.getElementById('tree').scrollHeight;
  });
  await page.waitForTimeout(40);
  expect(
    await page.evaluate(() => ({
      key: heldCreation.dataset.key,
      connected: heldCreation.isConnected,
    })),
  ).toEqual({ key: 'new-tab:reuse-0', connected: true });
  await page.mouse.up();

  for (const childControls of [true, false]) {
    const target = await page.evaluate((childControls) => {
      document.getElementById('home').focus();
      const before = new Set(document.querySelectorAll('#tree .new-tab-action'));
      const next = structuredClone(fixture);
      next.groups = childControls
        ? []
        : Array.from({ length: 500 }, (_, i) => ({
            id: `reuse-${i}`,
            name: `Reuse folder ${i}`,
            parentId: null,
          }));
      next.tabs = childControls
        ? Array.from({ length: 300 }, (_, i) => ({
            ...fixture.tabs[i],
            groupId: null,
            parentTabId: i % 2 ? i : null,
          }))
        : [];
      viewportTest.set(next);
      const prefix = childControls ? 'new-child-tab:' : 'new-tab:reuse-';
      const control = [...document.querySelectorAll('#tree .new-tab-action')].find(
        (node) => before.has(node) && node.dataset.key.startsWith(prefix),
      );
      if (!control) throw new Error('Expected an existing control to cross creation row kinds');
      const key = control.dataset.key;
      const expected = childControls
        ? { type: 'newChildTab', id: Number(control.dataset.parentTabId) }
        : { type: 'newTab', groupId: control.dataset.groupId };
      viewportTest.reveal(key);
      return { key, expected };
    }, childControls);
    await page.locator(`[data-key="${target.key}"]`).click();
    expect(await page.evaluate(() => viewportTest.calls.at(-1))).toMatchObject(target.expected);
  }
  console.log(
    '✓ Recycled creation controls switch between folders and child tabs with the current action target',
  );
  const collapsedFolders = await page.evaluate(() => {
    document.getElementById('home').focus();
    const parents = Array.from({ length: 20 }, (_, i) => ({
      id: `parent-${i}`,
      name: `Parent ${i}`,
      parentId: null,
      appearance: { color: i % 2 ? '#a466ff' : '#37a7ff' },
    }));
    const children = parents.flatMap((parent, p) =>
      Array.from({ length: 49 }, (_, i) => ({
        id: `child-${p}-${i}`,
        name: `Child ${p}/${i}`,
        parentId: parent.id,
        ...(i % 7 === 0 ? { defaultCookieStoreId: 'firefox-container-pool' } : {}),
        ...(i % 11 === 0 ? { appearance: { color: '#e37b40', icon: 'folder' } } : {}),
      })),
    );
    const next = structuredClone(fixture);
    next.groups = [...parents, ...children];
    next.containers = [
      {
        cookieStoreId: 'firefox-container-pool',
        name: 'Work',
        colorCode: '#37a7ff',
        icon: 'briefcase',
      },
    ];
    next.tabs = next.tabs.map((tab, i) => ({
      ...tab,
      groupId: `child-${Math.floor(i / 50)}-${(i % 50) % 49}`,
      parentTabId: null,
      audible: i % 17 === 0,
      mutedInfo: { muted: false },
    }));
    next.view = { scopeId: 'parent-0', collapsed: children.map((group) => group.id) };
    next.look.animations = false;
    viewportTest.set(next);
    viewportGroupBuilds = 0;
    viewportCreationBuilds = 0;
    viewportTest.resetRows();
    const keys = children.map((group) => `group:${group.id}`);
    let maxCached = 0;
    for (let pass = 0; pass < 2; pass++)
      for (let p = 0; p < 20; p++) {
        next.view.scopeId = `parent-${p}`;
        next.look.domains = Boolean(pass);
        viewportTest.set(structuredClone(next));
        const expected = children.filter((group) => group.parentId === `parent-${p}`);
        const rows = [...document.querySelectorAll('#tree .group-row')];
        if (
          rows.length !== 49 ||
          document.querySelector('#tree .tab-row') ||
          rows.some((row, i) => {
            const group = expected[i];
            const tabs = next.tabs.filter((tab) => tab.groupId === group.id);
            const playing = tabs.filter((tab) => tab.audible).length;
            return (
              row.dataset.id !== group.id ||
              row.dataset.dropId !== group.id ||
              row.querySelector('.label').textContent !== group.name ||
              row.querySelector('.group-count').textContent !== String(tabs.length) ||
              row.getAttribute('aria-expanded') !== 'false' ||
              row.querySelector('.disclosure').getAttribute('aria-label') !==
                `Expand ${group.name}` ||
              Boolean(row.querySelector('.audio-indicator')) !== Boolean(playing)
            );
          }) ||
          JSON.stringify(viewportTest.targets()) !==
            JSON.stringify(
              expected.flatMap((group) =>
                next.tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id),
              ),
            )
        )
          throw Error('Collapsed scope changed complete rows or logical targets');
        maxCached = Math.max(maxCached, viewportTest.cached(keys).keys.length);
      }
    const builds = { groups: viewportGroupBuilds, creation: viewportCreationBuilds };
    const describe = () =>
      [...document.querySelectorAll('#tree .group-row')].map((row) => ({
        key: row.dataset.key,
        title: row.title,
        accessible: row.getAttribute('aria-label'),
        style: row.getAttribute('style'),
        wrapperStyle: row.parentElement.getAttribute('style'),
        icon: row.querySelector('.disclosure').innerHTML,
        audio: row.querySelector('.audio-indicator')?.getAttribute('aria-label') || null,
      }));
    const reused = describe();
    viewportTest.resetRows();
    const fresh = describe();
    window.folderScopeFixture = structuredClone(next);
    return { maxCached, builds, reused, fresh };
  });
  expect(collapsedFolders.maxCached).toBeLessThanOrEqual(145);
  expect(collapsedFolders.builds.groups).toBeLessThan(150);
  expect(collapsedFolders.builds.creation).toBeLessThan(10);
  expect(collapsedFolders.reused).toEqual(collapsedFolders.fresh);
  const beforeFolderToggle = await page.evaluate(() => viewportTest.calls.length);
  await page.locator('#tree .group-row[data-id="child-19-48"] .disclosure').click();
  await page.waitForFunction((before) => viewportTest.calls.length > before, beforeFolderToggle);
  expect(
    await page.evaluate((before) => viewportTest.calls.slice(before), beforeFolderToggle),
  ).toEqual([{ type: 'toggleGroup', id: 'child-19-48' }]);
  console.log(
    '✓ Collapsed folder scopes bound retained controls and preserve counts, audio, inherited appearance and current actions',
  );

  for (const owner of ['focus', 'pressed', 'menu']) {
    await page.evaluate((owner) => {
      document.getElementById('home').focus();
      const next = structuredClone(folderScopeFixture);
      next.view.scopeId = 'parent-0';
      viewportTest.set(next);
      viewportTest.resetRows();
      window.heldFolder = document.querySelector('#tree .group-row');
      window.heldFolderDisclosure = heldFolder.querySelector('.disclosure');
      if (owner === 'pressed')
        heldFolderDisclosure.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 42,
            button: 0,
            isPrimary: true,
          }),
        );
      else (owner === 'focus' ? heldFolderDisclosure : heldFolder).focus();
    }, owner);
    if (owner === 'menu') {
      await page.keyboard.press('Shift+F10');
      await expect(page.locator('#menu')).toBeVisible();
    }
    const held = await page.evaluate(async (owner) => {
      const before = viewportTest.calls.length;
      if (owner === 'pressed')
        document.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, pointerId: 42, button: 0 }),
        );
      const next = structuredClone(folderScopeFixture);
      next.view.scopeId = 'parent-1';
      viewportTest.set(next);
      heldFolderDisclosure.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        key: heldFolder.dataset.key,
        first: document.querySelector('#tree .group-row').dataset.id,
        calls: viewportTest.calls.slice(before),
      };
    }, owner);
    expect(held).toEqual({ key: 'group:child-0-0', first: 'child-1-0', calls: [] });
    if (owner === 'menu') await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 42 }));
      document.getElementById('home').focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
      delete window.heldFolder;
      delete window.heldFolderDisclosure;
    });
  }
  const expandedFolder = await page.evaluate(() => {
    const next = structuredClone(folderScopeFixture);
    next.view.scopeId = 'parent-0';
    next.view.collapsed = next.view.collapsed.filter((id) => id !== 'child-0-0');
    viewportTest.set(next);
    const expanded = document.querySelector('#tree .group-row[data-id="child-0-0"]');
    const tabs = () =>
      [...document.querySelectorAll('#tree .tab-row')].map((row) => Number(row.dataset.id));
    const before = tabs();
    const away = structuredClone(folderScopeFixture);
    away.view.scopeId = 'parent-1';
    viewportTest.set(away);
    const keyWhileAway = expanded.dataset.key;
    viewportTest.set(next);
    return {
      before,
      after: tabs(),
      keyWhileAway,
      same: expanded === document.querySelector('#tree .group-row[data-id="child-0-0"]'),
    };
  });
  expect(expandedFolder).toEqual({
    before: [1, 50],
    after: [1, 50],
    keyWhileAway: 'group:child-0-0',
    same: true,
  });
  await page.evaluate(() => {
    delete window.folderScopeFixture;
  });
  console.log(
    '✓ Full folder scopes preserve focused, pressed and menu owners and cached expanded branches',
  );

  const twoLineRebuilds = await page.evaluate(() => {
    document.getElementById('home').focus();
    const next = structuredClone(fixture);
    next.groups = next.groups.slice(0, 2);
    next.tabs = next.tabs.slice(0, 6).map((tab, i) => ({
      ...tab,
      groupId: `g${Math.floor(i / 3)}`,
    }));
    next.look.domains = true;
    next.view.scopeId = 'g0';
    viewportTest.set(structuredClone(next));
    viewportTest.resetRows();
    const row = document.querySelector('#tree .tab-row');
    const close = row.querySelector('.close-tab');
    close.focus();
    const checked = [];
    for (const shape of ['audio', 'parent']) {
      // Prime detail reuse, rebuild children in the same row, then change URLs.
      next.tabs[0].url = `https://before-${shape}.example.test/`;
      viewportTest.patch(structuredClone(next));
      const previousDetail = row.querySelector('.row-detail');
      const complex = structuredClone(next);
      if (shape === 'audio') complex.tabs[0].audible = true;
      else complex.tabs[1].parentTabId = complex.tabs[0].id;
      viewportTest.patch(complex);
      if (!row.querySelector(shape === 'audio' ? '.audio-button' : '.tab-disclosure'))
        throw Error('Two-line row did not gain its complex controls');
      viewportTest.patch(structuredClone(next));
      if (row.querySelector('.row-detail') === previousDetail)
        throw Error('Fixture did not rebuild the row children');
      for (const [url, domain] of [
        ['https://www.current.example.test/page', 'current.example.test'],
        ['https://different.example.test/page', 'different.example.test'],
        ['about:blank', 'New tab'],
        ['file:///example.html', 'New tab'],
        ['invalid-url', ''],
        [undefined, ''],
      ]) {
        next.tabs[0].url = url;
        viewportTest.patch(structuredClone(next));
        if (
          document.querySelector('#tree .tab-row') !== row ||
          row.querySelector('.row-detail')?.textContent !== domain ||
          row.querySelector('.row-detail')?.getAttribute('aria-hidden') !== 'true' ||
          row.querySelector('.audio-button, .tab-disclosure') ||
          row.querySelector('.close-tab') !== close ||
          document.activeElement !== close
        )
          throw Error('Two-line rebuild retained stale children or lost focus');
        checked.push({ shape, domain });
      }
    }
    next.tabs[0].url = 'https://example.com/final';
    for (const domains of [false, true, false, true]) {
      const currentClose = document.activeElement;
      next.look.domains = domains;
      viewportTest.patch(structuredClone(next));
      if (document.activeElement !== currentClose)
        throw Error('Line-mode change lost the focused close control');
      document.getElementById('home').focus();
      for (const scopeId of ['g1', 'g0']) {
        next.view.scopeId = scopeId;
        viewportTest.set(structuredClone(next));
        const expected = next.tabs.filter((tab) => tab.groupId === scopeId);
        const rows = [...document.querySelectorAll('#tree .tab-row')];
        if (
          rows.length !== expected.length ||
          rows.some(
            (node, i) =>
              Number(node.dataset.id) !== expected[i].id ||
              node.querySelector('.label').textContent !== expected[i].title ||
              (domains
                ? node.querySelector('.row-detail')?.textContent !== 'example.com'
                : Boolean(node.querySelector('.row-copy, .row-detail'))),
          )
        )
          throw Error('Revisiting a scope retained the previous line mode');
      }
      // The focused owner may be reused after navigating; check the current one.
      document.querySelector('#tree .tab-row .close-tab').focus();
    }
    document.getElementById('home').focus();
    viewportTest.set(structuredClone(fixture));
    return checked;
  });
  expect(twoLineRebuilds).toHaveLength(12);
  console.log(
    '✓ Two-line rebuilds refresh domains and preserve focused controls across line modes',
  );

  for (const domains of [false, true]) {
    const smallFolders = await page.evaluate((domains) => {
      document.getElementById('home').focus();
      const next = structuredClone(fixture);
      next.groups = Array.from({ length: 20 }, (_, i) => ({
        id: `small-${i}`,
        name: `Small folder ${i}`,
        parentId: null,
      }));
      next.tabs = next.tabs.map((tab, i) => ({
        ...tab,
        groupId: `small-${Math.floor(i / 50)}`,
        url: `https://www.folder-${Math.floor(i / 50)}.example.test/${i}`,
        parentTabId: null,
        audible: false,
        mutedInfo: { muted: false },
      }));
      next.look.domains = domains;
      next.view.scopeId = 'small-0';
      viewportTest.set(next);
      viewportTest.resetRows();
      const keys = next.tabs.map((tab) => `tab:${tab.id}`);
      let maximumCached = 0;
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < 20; i++) {
          viewportTest.set({ ...next, view: { ...next.view, scopeId: `small-${i}` } });
          const expected = next.tabs.filter((tab) => tab.groupId === `small-${i}`);
          const rows = [...document.querySelectorAll('#tree .tab-row')];
          if (
            document.getElementById('tree').classList.contains('viewport-tree') ||
            rows.length !== expected.length ||
            rows.some(
              (row, n) =>
                Number(row.dataset.id) !== expected[n].id ||
                row.querySelector('.label').textContent !== expected[n].title ||
                (domains
                  ? row.querySelector('.row-detail')?.textContent !== `folder-${i}.example.test` ||
                    row.querySelector('.row-detail')?.getAttribute('aria-hidden') !== 'true'
                  : Boolean(row.querySelector('.row-detail'))) ||
                row.querySelector('.close-tab').getAttribute('aria-label') !==
                  `Close ${expected[n].title}`,
            ) ||
            JSON.stringify(viewportTest.targets()) !== JSON.stringify(expected.map((tab) => tab.id))
          )
            throw new Error('Small-folder reuse changed complete rows or action labels');
          maximumCached = Math.max(maximumCached, viewportTest.cached(keys).keys.length);
        }
      return { maximumCached, built: viewportTabBuilds, lastId: next.tabs.at(-1).id };
    }, domains);
    expect(smallFolders.maximumCached).toBeLessThanOrEqual(146);
    expect(smallFolders.built).toBeLessThan(150);
    const callsBeforeClose = await page.evaluate(() => viewportTest.calls.length);
    await page.locator(`#tree .tab-row[data-id="${smallFolders.lastId}"] .close-tab`).click();
    expect(
      await page.evaluate((before) => viewportTest.calls.slice(before), callsBeforeClose),
    ).toEqual([{ type: 'closeTab', id: smallFolders.lastId, promoteFirstChild: true }]);
    console.log(
      `✓ ${domains ? 'Two-line' : 'One-line'} small-folder visits bound dormant controls and preserve complete rows and actions`,
    );
  }
  const mixedFolders = await page.evaluate(() => {
    document.getElementById('home').focus();
    const next = structuredClone(fixture);
    const parents = Array.from({ length: 20 }, (_, i) => ({
      id: `mixed-${i}`,
      name: `Mixed ${i}`,
      parentId: null,
      appearance: { color: i % 2 ? '#a466ff' : '#37a7ff' },
    }));
    const children = parents.flatMap((parent, p) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `mixed-child-${p}-${i}`,
        name: `Mixed child ${p}/${i}`,
        parentId: parent.id,
      })),
    );
    next.groups = [...parents, ...children];
    next.tabs = next.tabs.map((tab, i) => ({
      ...tab,
      groupId: `mixed-${Math.floor(i / 50)}`,
      parentTabId: null,
      audible: false,
      mutedInfo: { muted: false },
    }));
    next.look.domains = false;
    next.look.animations = false;
    next.view = { scopeId: 'mixed-0', collapsed: children.map((group) => group.id) };
    window.checkMixedScope = (next) => {
      const groups = next.groups.filter((group) => group.parentId === next.view.scopeId);
      const tabs = next.tabs.filter((tab) => tab.groupId === next.view.scopeId);
      const rows = [...document.querySelectorAll('#tree .group-row, #tree .tab-row')];
      const expected = [
        ...groups.map((group) => `group:${group.id}`),
        ...tabs.map((tab) => `tab:${tab.id}`),
      ];
      if (
        JSON.stringify(rows.map((row) => row.dataset.key)) !== JSON.stringify(expected) ||
        JSON.stringify(viewportTest.targets()) !== JSON.stringify(tabs.map((tab) => tab.id))
      )
        throw Error('Mixed scope changed complete order or action targets');
      for (const row of rows) {
        if (row.classList.contains('group-row')) {
          const group = groups.find((group) => group.id === row.dataset.id);
          if (
            row.dataset.dropId !== group.id ||
            row.querySelector('.label').textContent !== group.name ||
            row.querySelector('.group-count').textContent !== '0' ||
            row.getAttribute('aria-expanded') !== 'false' ||
            row.querySelector('.disclosure').getAttribute('aria-label') !== `Expand ${group.name}`
          )
            throw Error('Stale mixed folder control');
        } else {
          const tab = tabs.find((tab) => tab.id === Number(row.dataset.id));
          if (
            row.querySelector('.label').textContent !== tab.title ||
            (next.look.domains
              ? row.querySelector('.row-detail')?.textContent !== 'example.com'
              : Boolean(row.querySelector('.row-copy, .row-detail'))) ||
            row.querySelector('.close-tab').getAttribute('aria-label') !== `Close ${tab.title}`
          )
            throw Error('Stale mixed tab control');
        }
      }
      return rows.map((row) => ({
        key: row.dataset.key,
        label: row.getAttribute('aria-label'),
        title: row.title,
        style: row.getAttribute('style'),
        wrapperStyle: row.parentElement.getAttribute('style'),
        icon: row.querySelector('.disclosure, .tab-icon')?.innerHTML,
      }));
    };
    viewportTest.set(structuredClone(next));
    viewportGroupBuilds = viewportCreationBuilds = 0;
    viewportTest.resetRows();
    const keys = [
      ...children.map((group) => `group:${group.id}`),
      ...next.tabs.map((tab) => `tab:${tab.id}`),
    ];
    let maximumCached = 0;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < 20; i++) {
        next.view.scopeId = `mixed-${i}`;
        viewportTest.set(structuredClone(next));
        checkMixedScope(next);
        maximumCached = Math.max(maximumCached, viewportTest.cached(keys).keys.length);
      }
    const builds = {
      tabs: viewportTabBuilds,
      groups: viewportGroupBuilds,
      creations: viewportCreationBuilds,
    };
    const reused = checkMixedScope(next);
    viewportTest.resetRows();
    const fresh = checkMixedScope(next);
    window.mixedScopeFixture = structuredClone(next);
    let maximumSwitchedCached = 0;
    for (const domains of [true, false, true, false]) {
      next.look.domains = domains;
      for (let i = 0; i < 20; i++) {
        next.view.scopeId = `mixed-${i}`;
        viewportTest.set(structuredClone(next));
        checkMixedScope(next);
        maximumSwitchedCached = Math.max(
          maximumSwitchedCached,
          viewportTest.cached(keys).keys.length,
        );
        if (sidebarRowsProbe().totalPooled > 64)
          throw Error('Mixed line-mode switch exceeded the unused control budget');
      }
    }
    return { maximumCached, maximumSwitchedCached, builds, reused, fresh };
  });
  expect(mixedFolders.maximumCached).toBeLessThanOrEqual(150);
  expect(mixedFolders.maximumSwitchedCached).toBeLessThanOrEqual(150);
  expect(mixedFolders.builds.tabs).toBeLessThan(150);
  expect(mixedFolders.builds.groups).toBeLessThan(20);
  expect(mixedFolders.builds.creations).toBeLessThan(10);
  expect(mixedFolders.reused).toEqual(mixedFolders.fresh);
  const beforeMixedActions = await page.evaluate(() => viewportTest.calls.length);
  await page.locator('#tree .tab-row[data-id="1000"] .close-tab').click();
  await page.locator('#tree .group-row[data-id="mixed-child-19-3"] .disclosure').click();
  await expect
    .poll(() => page.evaluate((before) => viewportTest.calls.slice(before), beforeMixedActions))
    .toEqual([
      { type: 'closeTab', id: 1000, promoteFirstChild: true },
      { type: 'toggleGroup', id: 'mixed-child-19-3' },
    ]);
  for (const kind of ['tab', 'group'])
    for (const owner of ['focus', 'pressed', 'menu']) {
      await page.evaluate(
        ({ kind, owner }) => {
          document.getElementById('home').focus();
          const next = structuredClone(mixedScopeFixture);
          next.view.scopeId = 'mixed-0';
          viewportTest.set(next);
          viewportTest.resetRows();
          window.heldMixedRow = document.querySelector(`#tree .${kind}-row`);
          window.heldMixedControl = heldMixedRow.querySelector(
            kind === 'tab' ? '.close-tab' : '.disclosure',
          );
          if (owner === 'pressed')
            heldMixedControl.dispatchEvent(
              new PointerEvent('pointerdown', {
                bubbles: true,
                pointerId: 42,
                button: 0,
                isPrimary: true,
              }),
            );
          else (owner === 'focus' ? heldMixedControl : heldMixedRow).focus();
        },
        { kind, owner },
      );
      if (owner === 'menu') {
        await page.keyboard.press('Shift+F10');
        await expect(page.locator('#menu')).toBeVisible();
      }
      const held = await page.evaluate(async (owner) => {
        const before = viewportTest.calls.length;
        if (owner === 'pressed')
          document.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerId: 42, button: 0 }),
          );
        const next = structuredClone(mixedScopeFixture);
        next.view.scopeId = 'mixed-1';
        viewportTest.set(next);
        checkMixedScope(next);
        heldMixedControl.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { key: heldMixedRow.dataset.key, calls: viewportTest.calls.slice(before) };
      }, owner);
      expect(held).toEqual({ key: kind === 'tab' ? 'tab:1' : 'group:mixed-child-0-0', calls: [] });
      if (owner === 'menu') await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 42 }));
        document.getElementById('home').focus();
        await new Promise((resolve) => setTimeout(resolve, 0));
        delete window.heldMixedRow;
        delete window.heldMixedControl;
      });
    }
  const largerMixedScopes = await page.evaluate(() => {
    for (const [scope, tabCount, groupCount] of [
      [2, 7, 1],
      [3, 50, 4],
      [4, 0, 0],
      [5, 1, 4],
      [6, 50, 0],
      [7, 0, 4],
      [19, 50, 4],
    ]) {
      const next = structuredClone(mixedScopeFixture);
      const id = `mixed-${scope}`;
      const keptTabs = new Set(
        next.tabs
          .filter((tab) => tab.groupId === id)
          .slice(0, tabCount)
          .map((tab) => tab.id),
      );
      const keptGroups = new Set(
        next.groups
          .filter((group) => group.parentId === id)
          .slice(0, groupCount)
          .map((group) => group.id),
      );
      next.tabs = next.tabs.filter((tab) => tab.groupId !== id || keptTabs.has(tab.id));
      next.groups = next.groups.filter(
        (group) => group.parentId !== id || keptGroups.has(group.id),
      );
      next.view.scopeId = id;
      viewportTest.set(next);
      checkMixedScope(next);
    }
    for (const mode of ['expanded', 'parents', 'audio']) {
      const next = structuredClone(mixedScopeFixture);
      next.view.scopeId = 'mixed-0';
      if (mode === 'expanded')
        next.view.collapsed = next.view.collapsed.filter((id) => id !== 'mixed-child-0-0');
      if (mode === 'parents') next.tabs[1].parentTabId = next.tabs[0].id;
      if (mode === 'audio') next.tabs[0].audible = true;
      viewportTest.set(next);
      const selector =
        mode === 'expanded' ? '[data-key="group:mixed-child-0-0"]' : '[data-key="tab:1"]';
      const held = document.querySelector(selector);
      const key = held.dataset.key;
      viewportTest.set({ ...next, view: { ...next.view, scopeId: 'mixed-1' } });
      if (held.dataset.key !== key) throw Error('Mixed navigation reassigned a complex control');
      viewportTest.set(next);
      if (document.querySelector(selector) !== held)
        throw Error('Mixed navigation discarded a cached complex control');
    }
    document.getElementById('home').focus();
    const large = structuredClone(mixedScopeFixture);
    const parentIds = new Set(Array.from({ length: 12 }, (_, i) => `mixed-${i}`));
    large.groups = large.groups.filter((group) => parentIds.has(group.parentId ?? group.id));
    large.tabs = large.tabs.slice(0, 960).map((tab, i) => ({
      ...tab,
      groupId: `mixed-${Math.floor(i / 80)}`,
    }));
    large.view = {
      scopeId: 'mixed-0',
      collapsed: large.groups.filter((group) => group.parentId !== null).map((group) => group.id),
    };
    viewportTest.set(large);
    viewportTest.resetRows();
    const keys = [
      ...large.tabs.map((tab) => `tab:${tab.id}`),
      ...large.groups.map((group) => `group:${group.id}`),
      ...parentIds.values().map((id) => `new-tab:${id}`),
    ];
    let maximumCached = 0;
    for (let pass = 0; pass < 2; pass++)
      for (const id of parentIds) {
        large.view.scopeId = id;
        viewportTest.set(structuredClone(large));
        checkMixedScope(large);
        maximumCached = Math.max(maximumCached, viewportTest.cached(keys).keys.length);
        if (sidebarRowsProbe().totalPooled > 64) throw Error('Unused row pool exceeded its budget');
      }
    // Transfer demand belongs to each control kind; spare tab views cannot
    // justify retaining extra folder or creation controls after the render.
    for (const [tabCount, groupCount] of [
      [0, 80],
      [80, 0],
      [0, 0],
      [1, 4],
      [80, 4],
    ]) {
      const next = structuredClone(large);
      next.view.scopeId = 'mixed-0';
      next.tabs = next.tabs.filter((tab) => tab.groupId !== 'mixed-0' || tab.id <= tabCount);
      next.groups = next.groups.filter((group) => group.parentId !== 'mixed-0');
      const children = Array.from({ length: groupCount }, (_, i) => ({
        id: `large-child-${i}`,
        name: `Large child ${i}`,
        parentId: 'mixed-0',
      }));
      next.groups.push(...children);
      next.view.collapsed = children.map((group) => group.id);
      viewportTest.set(next);
      checkMixedScope(next);
      if (sidebarRowsProbe().totalPooled > 64) throw Error('Mixed kinds enlarged the unused pool');
    }
    delete window.mixedScopeFixture;
    delete window.checkMixedScope;
    return { maximumCached };
  });
  expect(largerMixedScopes.maximumCached).toBeLessThanOrEqual(100);
  console.log(
    '✓ Mixed tab/folder scopes preserve full results, appearance, actions, protected owners and varying shapes',
  );

  for (const domains of [false, true]) {
    const flatTransitions = await page.evaluate((domains) => {
      document.getElementById('home').focus();
      const next = structuredClone(fixture);
      next.look.domains = domains;
      const sizes = [0, 1, 7, 35, 50, 63, 64, 90, 690];
      next.groups = sizes.map((_, i) => ({ id: `vary-${i}`, name: `Vary ${i}`, parentId: null }));
      let offset = 0;
      next.tabs = sizes.flatMap((size, i) => {
        const tabs = fixture.tabs
          .slice(offset, offset + size)
          .map((tab) => ({ ...tab, groupId: `vary-${i}` }));
        offset += size;
        return tabs;
      });
      for (const i of [2, 4, 3, 6, 7, 1, 0, 4, 2, 8, 4]) {
        viewportTest.set({ ...next, view: { ...next.view, scopeId: `vary-${i}` } });
        const expected = next.tabs.filter((tab) => tab.groupId === `vary-${i}`);
        if (expected.length <= 100) {
          const rows = [...document.querySelectorAll('#tree .tab-row')];
          if (
            rows.length !== expected.length ||
            rows.some(
              (row, n) =>
                Number(row.dataset.id) !== expected[n].id ||
                row.querySelector('.label').textContent !== expected[n].title ||
                (domains
                  ? row.querySelector('.row-detail')?.textContent !== 'example.com'
                  : Boolean(row.querySelector('.row-detail'))) ||
                row.querySelector('.close-tab').getAttribute('aria-label') !==
                  `Close ${expected[n].title}`,
            )
          )
            throw Error('Variable-size folder recycling changed rows or targets');
        }
      }
      const owned = document.querySelector('#tree .tab-row .close-tab');
      owned.focus();
      const key = owned.closest('[data-key]').dataset.key;
      viewportTest.set({ ...next, view: { ...next.view, scopeId: 'vary-3' } });
      const ownerPreserved = owned.closest('[data-key]').dataset.key === key;
      document.getElementById('home').focus();
      return { ownerPreserved };
    }, domains);
    expect(flatTransitions.ownerPreserved).toBe(true);
    console.log(
      '✓ Variable-size, empty and virtual folder transitions preserve rows and focused ownership',
    );
    for (const [owner, audio] of [
      ['pressed', false],
      ['menu', false],
      ['pressed', true],
      ['menu', true],
    ]) {
      await page.evaluate(
        ({ owner, domains, audio }) => {
          document.getElementById('home').focus();
          const next = structuredClone(fixture);
          next.groups = Array.from({ length: 20 }, (_, i) => ({
            id: `owned-${i}`,
            name: `Owned ${i}`,
            parentId: null,
          }));
          next.tabs = next.tabs.map((tab, i) => ({
            ...tab,
            groupId: `owned-${Math.floor(i / 50)}`,
            parentTabId: null,
            audible: false,
            mutedInfo: { muted: audio && i % 50 === 0 },
          }));
          next.look.domains = domains;
          next.view.scopeId = 'owned-0';
          viewportTest.set(next);
          window.fullOwnerFixture = next;
          window.fullOwner = document.querySelector('#tree .tab-row');
          window.fullOwnerClose = fullOwner.querySelector('.close-tab');
          if (owner === 'pressed')
            fullOwnerClose.dispatchEvent(
              new PointerEvent('pointerdown', {
                bubbles: true,
                pointerId: 42,
                button: 0,
                isPrimary: true,
              }),
            );
          else fullOwner.focus();
        },
        { owner, domains, audio },
      );
      if (owner === 'menu') {
        await page.keyboard.press('Shift+F10');
        await expect(page.locator('#menu')).toBeVisible();
      }
      const ownership = await page.evaluate((owner) => {
        const before = viewportTest.calls.length;
        if (owner === 'pressed')
          document.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerId: 42, button: 0 }),
          );
        viewportTest.set({
          ...fullOwnerFixture,
          view: { ...fullOwnerFixture.view, scopeId: 'owned-1' },
        });
        fullOwnerClose.click();
        return {
          oldKey: fullOwner.dataset.key,
          firstVisibleId: Number(document.querySelector('#tree .tab-row').dataset.id),
          closes: viewportTest.calls.slice(before).filter((call) => call.type === 'closeTab'),
        };
      }, owner);
      expect(ownership).toEqual({ oldKey: 'tab:1', firstVisibleId: 51, closes: [] });
      if (owner === 'menu') await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 42 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        delete window.fullOwner;
        delete window.fullOwnerClose;
        delete window.fullOwnerFixture;
      });
    }
    console.log('✓ Small-folder navigation cannot reassign a pressed or menu-owned close control');
  }
  for (const domains of [false, true])
    for (const audioMode of ['muted', 'audible']) {
      const sparseAudio = await page.evaluate(
        ({ domains, audioMode }) => {
          document.getElementById('home').focus();
          const next = structuredClone(fixture);
          next.groups = Array.from({ length: 20 }, (_, i) => ({
            id: `audio-${i}`,
            name: `Audio folder ${i}`,
            parentId: null,
          }));
          next.tabs = next.tabs.map((tab, i) => ({
            ...tab,
            groupId: `audio-${Math.floor(i / 50)}`,
            parentTabId: null,
            audible: audioMode === 'audible' && i % 50 === Math.floor(i / 50),
            mutedInfo: { muted: audioMode === 'muted' && i % 50 === Math.floor(i / 50) },
          }));
          next.look.domains = domains;
          next.view.scopeId = 'audio-0';
          viewportTest.set(next);
          viewportTest.resetRows();
          const keys = next.tabs.map((tab) => `tab:${tab.id}`);
          const audioOwners = new Map();
          let maximumCached = 0;
          for (let pass = 0; pass < 2; pass++)
            for (let i = 0; i < 20; i++) {
              next.view.scopeId = `audio-${i}`;
              viewportTest.set(structuredClone(next));
              const expected = next.tabs.filter((tab) => tab.groupId === next.view.scopeId);
              const rows = [...document.querySelectorAll('#tree .tab-row')];
              if (
                document.getElementById('tree').classList.contains('viewport-tree') ||
                rows.length !== 50 ||
                rows.some((row, n) => {
                  const tab = expected[n];
                  const button = row.querySelector('.audio-button');
                  return (
                    Number(row.dataset.id) !== tab.id ||
                    row.querySelector('.label').textContent !== tab.title ||
                    row.querySelector('.close-tab').getAttribute('aria-label') !==
                      `Close ${tab.title}` ||
                    (domains
                      ? row.querySelector('.row-detail')?.textContent !== 'example.com'
                      : Boolean(row.querySelector('.row-detail'))) ||
                    (n === i
                      ? button?.getAttribute('aria-label') !==
                        (audioMode === 'muted' ? 'Unmute tab' : 'Mute tab')
                      : Boolean(button))
                  );
                }) ||
                JSON.stringify(viewportTest.targets()) !==
                  JSON.stringify(expected.map((tab) => tab.id))
              )
                throw Error('Sparse audio reuse changed complete rows, labels or actions');
              const id = expected[i].id;
              const button = rows[i].querySelector('.audio-button');
              const previous = audioOwners.get(id);
              if (previous && (previous.row !== rows[i] || previous.button !== button))
                throw Error('Quiet sibling reuse rebuilt an audio control');
              audioOwners.set(id, { row: rows[i], button });
              maximumCached = Math.max(maximumCached, viewportTest.cached(keys).keys.length);
              if (sidebarRowsProbe().totalPooled > 64)
                throw Error('Sparse audio scope exceeded the unused pool budget');
            }
          const lastId = next.tabs[969].id;
          const row = document.querySelector(`#tree .tab-row[data-id="${lastId}"]`);
          const close = row.querySelector('.close-tab');
          close.focus();
          for (const shape of ['quiet', 'muted', 'audible']) {
            next.tabs[969].audible = shape === 'audible';
            next.tabs[969].mutedInfo = { muted: shape === 'muted' };
            viewportTest.patch(structuredClone(next));
            const button = row.querySelector('.audio-button');
            if (
              document.activeElement !== close ||
              row.querySelector('.close-tab') !== close ||
              (shape === 'quiet'
                ? Boolean(button)
                : button?.getAttribute('aria-label') !==
                  (shape === 'muted' ? 'Unmute tab' : 'Mute tab'))
            )
              throw Error('Audio shape change lost the focused current control');
          }
          document.getElementById('home').focus();
          return { maximumCached, built: viewportTabBuilds, audioOwners: audioOwners.size, lastId };
        },
        { domains, audioMode },
      );
      expect(sparseAudio.maximumCached).toBeLessThanOrEqual(100);
      expect(sparseAudio.built).toBeLessThan(100);
      expect(sparseAudio.audioOwners).toBe(20);
      const beforeMute = await page.evaluate(() => viewportTest.calls.length);
      await page.locator(`#tree .tab-row[data-id="${sparseAudio.lastId}"] .audio-button`).click();
      expect(await page.evaluate((before) => viewportTest.calls.slice(before), beforeMute)).toEqual(
        [{ type: 'muteTab', id: sparseAudio.lastId }],
      );
    }
  console.log(
    '✓ Quiet siblings reuse controls while sparse audio buttons keep identity and actions',
  );

  const audioDemand = await page.evaluate(async () => {
    document.getElementById('home').focus();
    const next = structuredClone(fixture);
    const sizes = [80, 90, 1, 80];
    next.groups = sizes.map((_, i) => ({ id: `demand-${i}`, name: `Demand ${i}`, parentId: null }));
    let offset = 0;
    next.tabs = sizes.flatMap((size, i) => {
      const tabs = fixture.tabs.slice(offset, offset + size).map((tab, n) => ({
        ...tab,
        groupId: `demand-${i}`,
        audible: false,
        mutedInfo: { muted: i === 1 || (i === 3 && n % 2 === 0) },
      }));
      offset += size;
      return tabs;
    });
    viewportTest.set({ ...next, view: { ...next.view, scopeId: 'demand-0' } });
    viewportTest.resetRows();
    let maximumUnused = 0;
    for (const i of [1, 2, 3, 0, 1, 3, 2, 0]) {
      viewportTest.set({ ...next, view: { ...next.view, scopeId: `demand-${i}` } });
      const expected = next.tabs.filter((tab) => tab.groupId === `demand-${i}`);
      const rows = [...document.querySelectorAll('#tree .tab-row')];
      if (
        rows.length !== expected.length ||
        rows.some(
          (row, n) =>
            Number(row.dataset.id) !== expected[n].id ||
            row.querySelector('.label').textContent !== expected[n].title ||
            Boolean(row.querySelector('.audio-button')) !== expected[n].mutedInfo.muted,
        )
      )
        throw Error('Mixed audio demand lost complete rows or mute controls');
      maximumUnused = Math.max(maximumUnused, sidebarRowsProbe().totalPooled);
    }
    viewportTest.set({ ...next, view: { ...next.view, scopeId: 'demand-1' } });
    const audioOwner = document.querySelector('#tree .tab-row .audio-button');
    const ownerId = Number(audioOwner.closest('.tab-row').dataset.id);
    audioOwner.focus();
    const large = structuredClone(next);
    large.tabs.push(
      ...fixture.tabs.slice(offset, offset + 150).map((tab, i) => ({
        ...tab,
        groupId: 'demand-1',
        mutedInfo: { muted: i % 5 === 0 },
      })),
    );
    for (const state of [large, next]) {
      viewportTest.set({ ...state, view: { ...state.view, scopeId: 'demand-1' } });
      await new Promise(requestAnimationFrame);
      if (
        document.getElementById('tree').classList.contains('viewport-tree') !== (state === large) ||
        document.activeElement !== audioOwner ||
        Number(audioOwner.closest('.tab-row').dataset.id) !== ownerId ||
        audioOwner.getAttribute('aria-label') !== 'Unmute tab'
      )
        throw Error('Full/virtual audio transition lost its focused current mute control');
      const expectedIds = state.tabs
        .filter((tab) => tab.groupId === 'demand-1')
        .map((tab) => tab.id);
      if (JSON.stringify(viewportTest.targets()) !== JSON.stringify(expectedIds))
        throw Error('Full/virtual audio transition lost logical members');
      const keys = state.tabs.map((tab) => `tab:${tab.id}`);
      const dormant = viewportTest.cached(keys);
      if (
        state === large &&
        dormant.keys.length - document.querySelectorAll('#tree .tab-row').length + dormant.pooled >
          96
      )
        throw Error('Virtual audio transition exceeded its dormant budget');
      maximumUnused = Math.max(maximumUnused, sidebarRowsProbe().totalPooled);
    }
    const overlapping = structuredClone(next);
    const moved = overlapping.tabs.filter((tab) => tab.groupId === 'demand-1').slice(0, 5);
    for (const tab of moved) tab.groupId = 'demand-3';
    viewportTest.set({ ...overlapping, view: { ...overlapping.view, scopeId: 'demand-3' } });
    if (
      document.activeElement !== audioOwner ||
      document.querySelector(`#tree .tab-row[data-id="${ownerId}"] .audio-button`) !== audioOwner
    )
      throw Error('Overlapping audio scopes lost their focused owner');
    const expectedOverlap = overlapping.tabs.filter((tab) => tab.groupId === 'demand-3');
    const overlapRows = [...document.querySelectorAll('#tree .tab-row')];
    if (
      overlapRows.length !== expectedOverlap.length ||
      overlapRows.some(
        (row, i) =>
          Number(row.dataset.id) !== expectedOverlap[i].id ||
          row.querySelector('.label').textContent !== expectedOverlap[i].title,
      )
    )
      throw Error('Overlapping audio scopes changed complete order or labels');
    maximumUnused = Math.max(maximumUnused, sidebarRowsProbe().totalPooled);
    document.getElementById('home').focus();
    return maximumUnused;
  });
  expect(audioDemand).toBeLessThanOrEqual(64);
  console.log('✓ All-muted and dense-audio scopes cannot inflate unused quiet-control demand');

  await page.evaluate(() => {
    document.getElementById('home').focus();
    for (const audioPosition of [0, 79]) {
      const next = structuredClone(fixture);
      next.groups = [0, 1].map((i) => ({ id: `edge-${i}`, name: `Edge ${i}`, parentId: null }));
      next.tabs = next.tabs.slice(0, 160).map((tab, i) => ({
        ...tab,
        groupId: `edge-${Math.floor(i / 80)}`,
        audible: false,
        mutedInfo: { muted: i % 80 === audioPosition },
      }));
      next.view.scopeId = 'edge-0';
      viewportTest.set(next);
      viewportTest.resetRows();
      const audio = document.querySelector('#tree .audio-button');
      const observer = new MutationObserver(() => {});
      observer.observe(document.getElementById('tree'), { childList: true });
      for (const scopeId of ['edge-1', 'edge-0']) {
        viewportTest.set({ ...next, view: { ...next.view, scopeId } });
        const records = observer.takeRecords();
        if (
          records.reduce((count, record) => count + record.removedNodes.length, 0) !== 1 ||
          records.reduce((count, record) => count + record.addedNodes.length, 0) !== 1
        )
          throw Error('Audio position forced quiet siblings out of their connected wrappers');
        const expected = next.tabs.filter((tab) => tab.groupId === scopeId);
        const rows = [...document.querySelectorAll('#tree .tab-row')];
        if (
          rows.length !== expected.length ||
          rows.some(
            (row, i) =>
              Number(row.dataset.id) !== expected[i].id ||
              row.querySelector('.label').textContent !== expected[i].title,
          )
        )
          throw Error('In-place larger audio scopes changed complete order or labels');
      }
      observer.disconnect();
      if (document.querySelector('#tree .audio-button') !== audio)
        throw Error('In-place larger audio scopes replaced the cached audio button');
      if (sidebarRowsProbe().totalPooled > 64)
        throw Error('Audio wrapper release raised the unused pool budget');
    }
  });
  console.log('✓ Larger flat scopes leave quiet controls connected with audio at either end');

  for (const domains of [false, true])
    for (const parentPosition of [0, 48]) {
      const collapsedParents = await page.evaluate(
        ({ domains, parentPosition }) => {
          document.getElementById('home').focus();
          const next = structuredClone(fixture);
          next.groups = Array.from({ length: 20 }, (_, i) => ({
            id: `parent-${i}`,
            name: `Parent folder ${i}`,
            parentId: null,
          }));
          // Toggle actions retain selection. Give each reuse case independent identities.
          const firstId = 10001 + Number(domains) * 2000 + Number(parentPosition > 0) * 1000;
          next.tabs = next.tabs.map((tab, i) => ({
            ...tab,
            id: firstId + i,
            treeId: `parent-test-${firstId + i}`,
            groupId: `parent-${Math.floor(i / 50)}`,
            parentTabId: i % 50 === parentPosition + 1 ? firstId + i - 1 : null,
            collapsed: true,
            audible: false,
            mutedInfo: { muted: false },
          }));
          next.look.domains = domains;
          next.view.scopeId = 'parent-0';
          viewportTest.set(structuredClone(next));
          viewportTest.resetRows();
          const keys = next.tabs.map((tab) => `tab:${tab.id}`);
          const parents = new Map();
          const quiet = [...document.querySelectorAll('#tree .tab-row:not([aria-expanded])')];
          let maximumCached = 0;
          for (let pass = 0; pass < 2; pass++)
            for (let i = 0; i < 20; i++) {
              next.view.scopeId = `parent-${i}`;
              viewportTest.set(structuredClone(next));
              const logical = next.tabs.filter((tab) => tab.groupId === next.view.scopeId);
              const visible = logical.filter((tab) => tab.parentTabId === null);
              const rows = [...document.querySelectorAll('#tree .tab-row')];
              if (
                rows.length !== 49 ||
                rows.some((row, n) => {
                  const tab = visible[n];
                  return (
                    Number(row.dataset.id) !== tab.id ||
                    row.querySelector('.label').textContent !== tab.title ||
                    row.querySelector('.close-tab').getAttribute('aria-label') !==
                      `Close ${tab.title}` ||
                    (domains
                      ? row.querySelector('.row-detail')?.textContent !== 'example.com'
                      : Boolean(row.querySelector('.row-detail')))
                  );
                }) ||
                JSON.stringify(viewportTest.targets()) !==
                  JSON.stringify(logical.map((tab) => tab.id)) ||
                quiet.some((row) => !row.isConnected || !rows.includes(row))
              )
                throw Error(
                  `Collapsed-parent reuse lost siblings, labels or hidden logical tabs: ${JSON.stringify(
                    {
                      domains,
                      parentPosition,
                      pass,
                      scope: i,
                      mounted: rows.length,
                      unavailable: quiet
                        .filter((row) => !row.isConnected || !rows.includes(row))
                        .map((row) => ({
                          key: row.dataset.key,
                          selected: row.classList.contains('selected'),
                        })),
                      logicalMatch:
                        JSON.stringify(viewportTest.targets()) ===
                        JSON.stringify(logical.map((tab) => tab.id)),
                    },
                  )}`,
                );
              const id = logical[parentPosition].id;
              const row = rows.find((node) => Number(node.dataset.id) === id);
              const button = row.querySelector('.tab-disclosure');
              const previous = parents.get(id);
              if (
                button?.getAttribute('aria-expanded') !== 'false' ||
                (previous && (previous.row !== row || previous.button !== button))
              )
                throw Error('Sibling reuse changed the collapsed parent control');
              parents.set(id, { row, button });
              maximumCached = Math.max(maximumCached, viewportTest.cached(keys).keys.length);
              if (sidebarRowsProbe().totalPooled > 64)
                throw Error('Collapsed-parent reuse exceeded the unused pool budget');
            }
          const lastId = next.tabs[950 + parentPosition].id;
          const owner = parents.get(lastId);
          owner.button.focus();
          for (const extraGroups of [1, 2, 0]) {
            const changed = structuredClone(next);
            for (const tab of changed.tabs)
              if (Number(tab.groupId.slice('parent-'.length)) >= 19 - extraGroups)
                tab.groupId = 'parent-19';
            viewportTest.set(changed);
            const expected = changed.tabs.filter((tab) => tab.groupId === 'parent-19');
            // Leaving the virtual renderer uses the existing row-focus fallback.
            const focused = extraGroups === 0 ? owner.row : owner.button;
            if (
              document.activeElement !== focused ||
              document.querySelector(`#tree .tab-row[data-id="${lastId}"]`) !== owner.row ||
              owner.row.querySelector('.tab-disclosure') !== owner.button ||
              JSON.stringify(viewportTest.targets()) !==
                JSON.stringify(expected.map((tab) => tab.id)) ||
              document.getElementById('tree').classList.contains('viewport-tree') !==
                (extraGroups === 2)
            )
              throw Error('Full/virtual parent transition lost focus, identity or logical tabs');
          }
          document.getElementById('home').focus();
          return { maximumCached, parents: parents.size, lastId };
        },
        { domains, parentPosition },
      );
      expect(collapsedParents.maximumCached).toBeLessThanOrEqual(100);
      expect(collapsedParents.parents).toBe(20);
      const beforeToggle = await page.evaluate(() => viewportTest.calls.length);
      await page
        .locator(`#tree .tab-row[data-id="${collapsedParents.lastId}"] .tab-disclosure`)
        .click();
      expect(
        await page.evaluate((before) => viewportTest.calls.slice(before), beforeToggle),
      ).toEqual([{ type: 'toggleTab', id: collapsedParents.lastId, activate: true }]);
    }
  console.log('✓ Collapsed parents retain identity and focus while quiet siblings reuse controls');

  const complexRevisits = await page.evaluate(() => {
    document.getElementById('home').focus();
    return ['parents', 'audio'].map((mode) => {
      const next = structuredClone(fixture);
      next.groups = Array.from({ length: 20 }, (_, i) => ({
        id: `complex-${i}`,
        name: `Complex ${i}`,
        parentId: null,
      }));
      next.look.domains = false;
      next.tabs = next.tabs.map((tab, i) => ({
        ...tab,
        groupId: `complex-${Math.floor(i / 50)}`,
        parentTabId: mode === 'parents' && i % 50 === 1 ? next.tabs[i - 1].id : null,
        audible: mode === 'audio' && i % 50 === 0,
      }));
      let first;
      for (let i = 0; i < 20; i++) {
        viewportTest.set({ ...next, view: { ...next.view, scopeId: `complex-${i}` } });
        if (!i) first = document.querySelector('#tree .tab-row');
      }
      const before = viewportTabBuilds;
      viewportTest.set({ ...next, view: { ...next.view, scopeId: 'complex-0' } });
      return {
        mode,
        sameControl: first === document.querySelector('#tree .tab-row'),
        rebuilt: viewportTabBuilds - before,
      };
    });
  });
  expect(complexRevisits).toEqual(
    ['parents', 'audio'].map((mode) => ({ mode, sameControl: true, rebuilt: 0 })),
  );
  console.log('✓ Parent and audio rows retain their cached controls across 20 small scopes');
  await page.evaluate(() => viewportTest.set(structuredClone(fixture)));
  expect(errors).toEqual([]);
} finally {
  await close();
}
