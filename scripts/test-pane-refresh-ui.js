import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest();
try {
  await page.route('**/pane-refresh-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><main><button id="tree-toggle">Fold</button><button id="recently-closed-toggle">History</button></main>',
    }),
  );
  await page.goto(`${base}/pane-refresh-fixture`);
  const result = await page.evaluate(async () => {
    const { createLaterView } = await import('/extension/src/later-view.js');
    const { createDomainsView } = await import('/extension/src/domains-view.js');
    const root = document.querySelector('main');
    const state = {
      groups: [{ id: 'folder', name: 'Original', parentId: null }],
      domainPins: [],
      tabs: Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        index: i,
        title: `Saved ${i + 1}`,
        url: `https://host${Math.floor(i / 2)}.example.test/${i}`,
        groupId: 'folder',
        savedForLaterAt: 1000 + i,
      })),
    };
    const options = {
      root,
      getState: () => state,

      onOpen() {},

      onClose() {},
    };
    const domains = createDomainsView(options);
    const later = createLaterView(options);
    const results = {};
    const observer = new MutationObserver(() => {});
    const observe = (node) =>
      observer.observe(node, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    const changedRows = (selector) =>
      [...new Set(observer.takeRecords().map((record) => record.target.closest?.(selector)))]
        .filter(Boolean)
        .map((row) => row.dataset.id || row.dataset.domain);

    later.open();
    const list = root.querySelector('.later-list');
    const savedRow = (id) => list.querySelector(`[data-id="${id}"]`);
    const selectedText = savedRow(500).querySelector('.later-label').firstChild;
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    observe(list);
    later.update(state);
    results.laterUnchanged = changedRows('.later-row');
    // Same snapshot object, edited fields: no identity-based invalidation shortcut.
    state.tabs[0].title = 'Changed title';
    later.update(state);
    results.laterChanged = changedRows('.later-row');
    results.selectionPreserved =
      selectedText.isConnected &&
      window.getSelection().anchorNode === selectedText &&
      window.getSelection().toString() === 'Saved 500';
    results.savedLabels = [...list.querySelectorAll('.later-label')].map(
      (node) => node.textContent,
    );
    results.changedTitle = savedRow(1).querySelector('.later-open-tab').title;
    state.tabs[0].active = true;
    state.tabs[0].pinned = true;
    state.tabs[1].url = 'about:reader?url=https%3A%2F%2Fexample.test%2Farticle';
    state.groups[0].name = 'Renamed';
    later.update(state);
    results.active = savedRow(1).querySelector('.later-open-tab').getAttribute('aria-current');
    results.pinnedReturn = savedRow(1).querySelector('[data-row-action="return"]').title;
    results.renamedReturn = savedRow(2).querySelector('[data-row-action="return"]').title;
    results.readerTitle = savedRow(2).querySelector('.later-open-tab').title;
    savedRow(500).querySelector('.later-open-tab').focus();
    state.tabs = state.tabs.filter((tab) => tab.id !== 500);
    later.update(state);
    results.focusAfterRemoval = document.activeElement.closest('.later-row')?.dataset.id;
    results.laterRemaining = list.children.length;
    observer.disconnect();
    later.close();
    results.laterReleased = list.children.length;

    state.tabs = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      title: `Tab ${i + 1}`,
      url: `https://host${Math.floor(i / 2)}.example.test/${i}`,
    }));
    domains.open();
    const pane = root.querySelector('.domains-view');
    const domainRow = (host) => pane.querySelector(`[data-domain="${host}.example.test"]`);
    const selectedCount = domainRow('host200').querySelector('.domains-tab-count').firstChild;
    observe(pane);
    domains.update(state);
    results.domainsUnchanged = changedRows('.domains-row');
    // Titles and source IDs can change without changing the displayed domain.
    state.tabs[0].title = 'New page title';
    state.tabs[0].id = 2000;
    domains.update(state);
    results.domainsMetadata = changedRows('.domains-row');
    state.domainPins.push('host0.example.test');
    domains.update(state);
    results.pinLabel = domainRow('host0').querySelector('.domains-pin').title;
    results.pinPressed = domainRow('host0')
      .querySelector('.domains-pin')
      .getAttribute('aria-pressed');
    state.tabs.push({ id: 3000, url: 'https://host0.example.test/extra' });
    domains.update(state);
    results.domainCount = domainRow('host0')
      .querySelector('.domains-open-domain')
      .getAttribute('aria-label');
    results.domainTextPreserved =
      selectedCount === domainRow('host200').querySelector('.domains-tab-count').firstChild;
    results.domainRows = pane.querySelectorAll('.domains-row').length;
    domainRow('host200').querySelector('.domains-pin').focus();
    state.tabs = state.tabs.filter((tab) => !tab.url.startsWith('https://host200.'));
    domains.update(state);
    results.domainFocusRetained = Boolean(document.activeElement.closest('.domains-row'));
    observer.disconnect();
    domains.close();
    results.domainsReleased = pane.querySelectorAll('.domains-row').length;
    later.dispose();
    domains.dispose();
    return results;
  });
  expect(result.laterUnchanged).toEqual([]);
  expect(result.laterChanged).toEqual(['1']);
  expect(result.selectionPreserved).toBe(true);
  expect(result.savedLabels).toEqual(
    Array.from({ length: 1000 }, (_, i) => (i === 999 ? 'Changed title' : `Saved ${1000 - i}`)),
  );
  expect(result.changedTitle).toBe('Changed title\nhttps://host0.example.test/0');
  expect(result.active).toBe('true');
  expect(result.pinnedReturn).toBe('Return to pinned tabs');
  expect(result.renamedReturn).toBe('Return to Renamed');
  expect(result.readerTitle).toBe('Saved 2\nhttps://example.test/article');
  expect(result.focusAfterRemoval).toBe('499');
  expect(result.laterRemaining).toBe(999);
  expect(result.laterReleased).toBe(0);
  expect(result.domainsUnchanged).toEqual([]);
  expect(result.domainsMetadata).toEqual([]);
  expect(result.pinLabel).toBe('Unpin host0.example.test');
  expect(result.pinPressed).toBe('true');
  expect(result.domainCount).toBe('host0.example.test, 3 tabs');
  expect(result.domainTextPreserved).toBe(true);
  expect(result.domainRows).toBe(500);
  expect(result.domainFocusRetained).toBe(true);
  expect(result.domainsReleased).toBe(0);
  console.log(
    'Pane refresh: sparse DOM changes, full results, selection, focus and release passed.',
  );
} finally {
  await close();
}
