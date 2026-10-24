import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

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
    const { createDomainsView } = await import('/extension/src/domains-view.js');
    const root = document.querySelector('main');
    const state = {
      groups: [{ id: 'folder', name: 'Original', parentId: null }],
      domainPins: [],
      tabs: Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        index: i,
        title: `Tab ${i + 1}`,
        url: `https://host${Math.floor(i / 2)}.example.test/${i}`,
        groupId: 'folder',
      })),
    };
    const options = {
      root,
      getState: () => state,

      onOpen() {},

      onClose() {},
    };
    const domains = createDomainsView(options);
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
    domains.dispose();
    return results;
  });
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
