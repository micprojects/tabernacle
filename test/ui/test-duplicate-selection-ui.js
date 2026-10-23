import { expect } from '@playwright/test';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest();
try {
  await page.route('**/duplicate-selection-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><button id="dialog-submit"></button><button id="dialog-cancel">Cancel</button><div id="dialog-icon"></div><div id="review-host"></div>',
    }),
  );
  await page.goto(`${base}/duplicate-selection-fixture`);
  const result = await page.evaluate(async () => {
    const { createCollectionDialogs } = await import('/extension/src/collection-dialogs.js');
    const state = {
      groups: [],
      tabs: Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        treeId: `tab-${i + 1}`,
        windowId: 1,
        index: i,
        title: `Tab ${i + 1}`,
        url: `https://example.test/${Math.floor(i / 2)}`,
        groupId: null,
        lastAccessed: i % 2 ? 100 : 200,
      })),
    };
    let options,
      fail = true;
    const calls = [];
    const host = document.getElementById('review-host');
    const dialogs = createCollectionDialogs({
      getState: () => state,

      showDialog(value) {
        options = value;
        host.replaceChildren(value.content);
      },

      request(type, args) {
        calls.push({ type, ...args });
        if (fail) throw new Error('Temporary failure');
        return { batchResult: { completed: [], skipped: args.targets, failed: [] } };
      },

      onChange() {},

      onNotice() {},
    });
    dialogs.reviewDuplicates({ kind: 'window' }, state.tabs);
    const list = host.querySelector('.duplicate-groups');
    const rows = [...list.querySelectorAll('.duplicate-copy')];
    const blocks = [...list.children];
    const checks = rows.map((row) => row.querySelector('input'));
    const submit = document.getElementById('dialog-submit');
    const selectedText = rows[899].querySelector('.duplicate-title').firstChild;
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    checks[1].focus();
    const observer = new MutationObserver(() => {});
    observer.observe(list, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    checks[1].click();
    const result = {
      rowMutations: observer.takeRecords().length,
      summary: submit.textContent,
      focus: document.activeElement === checks[1],
      sameBlocks: [...list.children].every((node, i) => node === blocks[i]),
      sameRows: [...list.querySelectorAll('.duplicate-copy')].every((node, i) => node === rows[i]),
      selection:
        selectedText.isConnected &&
        window.getSelection().anchorNode === selectedText &&
        window.getSelection().toString() === 'Tab 900',
    };
    observer.disconnect();
    checks[1].click();
    checks[0].click();
    result.noKeeperDisabled = submit.disabled;
    result.noKeeperWarning = host.querySelector('.duplicate-note').textContent;
    checks[0].click();
    result.keeperRestored = !submit.disabled;

    // A state change not yet rendered must still be checked at submission.
    state.tabs[0].url = 'https://example.test/navigated';
    state.tabs.push({ ...state.tabs[1], id: 1001, treeId: 'new-tab' });
    try {
      await options.onSubmit();
    } catch (error) {
      result.failure = error.message;
    }
    result.firstTargets = calls[0].targets.map((target) => target.id);
    result.firstKeepers = calls[0].keepers.map((target) => target.id);
    result.staleGroupRemoved = list.children.length === 499;

    // Incoming protected state removes an automatic selection after a failed submit.
    state.tabs[3].audible = true;
    dialogs.refresh();
    result.protectedDeselected = !list.querySelectorAll('input')[1].checked;
    // Manual selection stays possible, and the retry captures the new choice.
    list.querySelectorAll('input')[1].click();
    fail = false;
    await options.onSubmit();
    result.retryTargets = calls[1].targets.map((target) => target.id);
    result.retryKeepers = calls[1].keepers.map((target) => target.id);
    options.cleanup();
    host.replaceChildren();
    dialogs.refresh();
    result.released = host.children.length === 0;
    return result;
  });
  expect(result.rowMutations).toBe(0);
  expect(result.summary).toBe('Close 499 tabs');
  expect(result.focus).toBe(true);
  expect(result.sameBlocks).toBe(true);
  expect(result.sameRows).toBe(true);
  expect(result.selection).toBe(true);
  expect(result.noKeeperDisabled).toBe(true);
  expect(result.noKeeperWarning).toBe('Keep at least one copy of each page.');
  expect(result.keeperRestored).toBe(true);
  expect(result.failure).toBe('Temporary failure');
  const targets = Array.from({ length: 499 }, (_, i) => 4 + i * 2);
  const keepers = Array.from({ length: 499 }, (_, i) => 3 + i * 2);
  expect(result.firstTargets).toEqual(targets);
  expect(result.firstKeepers).toEqual(keepers);
  expect(result.staleGroupRemoved).toBe(true);
  expect(result.protectedDeselected).toBe(true);
  expect(result.retryTargets).toEqual(targets);
  expect(result.retryKeepers).toEqual(keepers);
  expect(result.released).toBe(true);
  console.log(
    'Duplicate selection: connected rows, keeper checks, stale targets and retry passed.',
  );
} finally {
  await close();
}
