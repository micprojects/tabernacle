import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 820 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const source = await readFile('extension/src/sidebar.js', 'utf8');
  await page.route('**/extension/src/sidebar.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        source +
        `
        window.coldTest = {
          ready: () => Boolean(state),
          set: next => { acceptState(next); render(); },
          search: query => { $('search').value = query; render(); },
          stop: () => refreshScheduler.dispose(),
          calls: [],
          intercept: () => { request = async (type, args) => {
            coldTest.calls.push({type, ...args}); return confirmedState;
          }; },
        };`,
    }),
  );
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.waitForFunction(() => window.coldTest?.ready());
  const timing = await page.evaluate(() => {
    coldTest.stop();
    coldTest.intercept();
    window.fixture = {
      generation: 'cold-render-test',
      groups: Array.from({ length: 10 }, (_, i) => ({
        id: `g${i}`,
        name: `Folder ${i}`,
        parentId: null,
      })),
      tabs: Array.from({ length: 5000 }, (_, i) => ({
        id: i + 1,
        treeId: `t${i}`,
        windowId: 1,
        index: i,
        order: i,
        groupId: `g${Math.floor(i / 500)}`,
        title: `Tab ${i}`,
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
    const start = performance.now();
    coldTest.set(structuredClone(fixture));
    return performance.now() - start;
  });
  await expect(page.locator('.tab-row')).toHaveCount(5000);
  console.log(`5,000-tab cold render: ${timing.toFixed(1)} ms (diagnostic only)`);

  // All rows remain real tree items. Compare the entire scroll extent and a
  // spread of row positions with ordinary layout, including after domains and
  // viewport width change while most rows have never been on screen.
  for (const width of [220, 480]) {
    await page.setViewportSize({ width, height: 820 });
    for (const domains of [false, true, false]) {
      const geometry = await page.evaluate(async (domains) => {
        fixture.look.domains = domains;
        coldTest.set(structuredClone(fixture));
        const tree = document.querySelector('#tree');
        tree.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const measure = () => ({
          height: tree.scrollHeight,
          rows: [1, 500, 2500, 4999, 5000].map((id) => {
            const row = document.querySelector(`[data-key="tab:${id}"]`);
            const rect = row.getBoundingClientRect();
            return [rect.top + tree.scrollTop, rect.height, rect.width];
          }),
        });
        const deferred = measure();
        const style = document.createElement('style');
        style.textContent = '.tab-row { content-visibility: visible; }';
        document.head.append(style);
        const ordinary = measure();
        style.remove();
        return { deferred, ordinary };
      }, domains);
      expect(geometry.deferred).toEqual(geometry.ordinary);
    }
  }
  console.log('✓ Large-tree geometry survives domain and width changes');

  await page.locator('[data-key="group:g0"]').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-key="new-tab:null"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-key="group:g0"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-key="tab:1"]')).toBeFocused();
  const last = page.locator('[data-key="tab:5000"]');
  await last.scrollIntoViewIfNeeded();
  await last.focus();
  await expect(last).toHaveAttribute('role', 'treeitem');
  await expect(last).toHaveAttribute('aria-label', 'Tab 4999');
  await expect(last.locator('.close-tab')).toBeInViewport();
  await last.locator('.close-tab').click();
  await expect
    .poll(() => page.evaluate(() => coldTest.calls))
    .toContainEqual({ type: 'closeTab', id: 5000 });
  console.log('✓ Keyboard traversal and offscreen row controls retain their targets');

  await page.evaluate(() => coldTest.search('Tab 4999'));
  await expect(page.locator('.tab-row')).toHaveCount(1);
  await expect(last).toHaveAttribute('aria-label', 'Tab 4999');
  await page.evaluate(() => coldTest.search(''));
  await expect(page.locator('.tab-row')).toHaveCount(5000);
  console.log('✓ Search finds and restores the far end of the large tree');

  await page.evaluate(() => {
    const row = document.querySelector('[data-key="tab:1"]');
    const parent = row.parentElement;
    for (const nested of [true, false, true]) {
      fixture.tabs[1].parentTabId = nested ? 1 : null;
      fixture.tabs[0].container = nested ? { name: 'Work', colorCode: '#37adff' } : null;
      coldTest.set(structuredClone(fixture));
      if (document.querySelector('[data-key="tab:1"]') !== row)
        throw new Error('A leaf/parent transition replaced the focused row');
      if (Boolean(parent.querySelector(':scope > .tab-branch')) !== nested)
        throw new Error('Leaf/parent transition retained the wrong branch');
      if (!nested && row.style.getPropertyValue('--label-color'))
        throw new Error('Removing a container retained its label colour');
      if (nested) {
        fixture.tabs[0].collapsed = true;
        coldTest.set(structuredClone(fixture));
        if (parent.querySelector(':scope > .tab-branch'))
          throw new Error('Fold left children attached');
        fixture.tabs[0].collapsed = false;
        coldTest.set(structuredClone(fixture));
        if (!parent.querySelector('[data-key="tab:2"]')) throw new Error('Unfold lost its child');
      }
    }
  });
  console.log('✓ Leaf/parent transitions preserve row identity, children and container colours');

  await page.setViewportSize({ width: 220, height: 820 });
  const deepGeometry = await page.evaluate(() => {
    fixture.tabs = fixture.tabs.slice(0, 35).map((tab, i) => ({
      ...tab,
      parentTabId: i ? i : null,
      audible: true,
      mutedInfo: { muted: i % 2 === 0 },
    }));
    fixture.look.domains = true;
    coldTest.set(structuredClone(fixture));
    const tree = document.querySelector('#tree');
    const measure = () => [tree.scrollWidth, tree.scrollHeight];
    const deferred = measure();
    const style = document.createElement('style');
    style.textContent = '.tab-row { content-visibility: visible; }';
    document.head.append(style);
    const ordinary = measure();
    style.remove();
    return { deferred, ordinary };
  });
  expect(deepGeometry.deferred).toEqual(deepGeometry.ordinary);
  const deepClose = page.locator('[data-key="tab:35"] .close-tab');
  await deepClose.scrollIntoViewIfNeeded();
  await expect(deepClose).toBeInViewport();
  await deepClose.click();
  await expect
    .poll(() => page.evaluate(() => coldTest.calls))
    .toContainEqual({ type: 'closeTab', id: 35 });
  console.log('✓ Deep narrow trees preserve horizontal overflow and reachable controls');

  await page.evaluate(async () => {
    const { icon, svgIcon } = await import('/extension/src/icons.js');
    const a = icon('group', 'first');
    a.querySelector('use').setAttribute('href', '#changed');
    a.style.color = 'red';
    const b = icon('group', 'second');
    if (
      b.classList.contains('first') ||
      !b.classList.contains('folder-icon') ||
      b.style.color ||
      b.querySelector('use').getAttribute('href') === '#changed'
    )
      throw new Error('Icon instances share mutable state');
    const c = svgIcon('close-12', '/other.svg', 'custom');
    if (c.querySelector('use').getAttribute('href') !== '/other.svg#close-12')
      throw new Error('Icon template reused the wrong sprite');
  });
  expect(errors).toEqual([]);
  console.log('✓ Icon instances remain independent; cold-render regression checks passed');
} finally {
  await close();
}
