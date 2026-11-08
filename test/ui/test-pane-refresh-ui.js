import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest();
try {
  await page.route('**/pane-refresh-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><main><button id="tree-toggle">Fold</button><footer><button id="recently-closed-toggle">History</button></footer></main>',
    }),
  );
  await page.goto(`${base}/pane-refresh-fixture`);
  const result = await page.evaluate(async () => {
    const { createBookmarksView } = await import('/extension/src/bookmarks-view.js');
    const { memoryBookmarks } = await import('/preview/bookmarks.js');
    const api = memoryBookmarks([
      {
        id: 'root',
        children: [
          {
            id: 'folder',
            type: 'folder',
            title: 'References',
            children: Array.from({ length: 500 }, (_, index) => ({
              id: `b${index}`,
              type: 'bookmark',
              title: `Bookmark ${index}`,
              url: `https://example.test/${index}`,
            })),
          },
        ],
      },
    ]);
    const root = document.querySelector('main');
    const state = { groups: [], view: { scopeId: null }, look: { connectingLines: true } };
    let reads = 0;
    const getTree = api.bookmarks.getTree;
    api.bookmarks.getTree = () => {
      reads++;
      return getTree();
    };
    const calls = [];
    let release;
    const view = createBookmarksView({
      root,
      getState: () => state,
      getBrowser: () => api,

      onOpen() {},

      onClose() {},

      onSelect: (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });

    const waitFor = async (condition) => {
      const end = Date.now() + 3000;
      while (!condition()) {
        if (Date.now() > end) throw new Error('Bookmark view did not settle');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    view.open();
    await waitFor(() => root.querySelectorAll('.bookmark-row').length === 501);
    const selected = root.querySelector('[data-bookmark-id="b200"]');
    selected.focus();
    const observer = new MutationObserver(() => {});
    observer.observe(root.querySelector('#bookmarks-tree'), {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    for (let i = 0; i < 10; i++) view.update();
    const idleMutations = observer.takeRecords().length;
    const idleReads = reads;
    await api.bookmarks.update('b0', { title: 'Changed title' });
    await waitFor(() =>
      root.querySelector('[data-bookmark-id="b0"]').textContent.includes('Changed title'),
    );
    const focused = selected === document.activeElement;
    const retained = selected === root.querySelector('[data-bookmark-id="b200"]');
    observer.disconnect();
    selected.querySelector('.label').click();
    selected.click();
    const busyCalls = calls.length;
    release(null);
    await Promise.resolve();
    selected.click();
    const sameOperation = calls[0].operationId === calls[1].operationId;
    release(true);
    await waitFor(() => !view.isOpen);
    const released = root.querySelectorAll('.bookmark-row').length;
    selected.click();
    const staleCalls = calls.length;
    let finishRead;
    api.bookmarks.getTree = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });
    view.open();
    await waitFor(() => finishRead);
    view.close();
    finishRead(await getTree());
    await Promise.resolve();
    await Promise.resolve();
    const lateRows = root.querySelectorAll('.bookmark-row').length;
    let finishPermission;
    let latePermissionReads = 0;
    api.permissions.contains = () =>
      new Promise((resolve) => {
        finishPermission = resolve;
      });
    api.bookmarks.getTree = () => {
      latePermissionReads++;
      return getTree();
    };
    view.open();
    view.close();
    finishPermission(true);
    await Promise.resolve();
    await Promise.resolve();
    view.dispose();
    return {
      idleMutations,
      idleReads,
      focused,
      retained,
      busyCalls,
      sameOperation,
      released,
      staleCalls,
      lateRows,
      latePermissionReads,
    };
  });
  expect(result).toEqual({
    idleMutations: 0,
    idleReads: 1,
    focused: true,
    retained: true,
    busyCalls: 1,
    sameOperation: true,
    released: 0,
    staleCalls: 2,
    lateRows: 0,
    latePermissionReads: 0,
  });
  console.log(
    '✓ Bookmark pane sparse refresh, row identity, focus, busy/retry guards, stale targets and release',
  );
} finally {
  await close();
}
