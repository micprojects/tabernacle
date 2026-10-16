import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';

const session = new ScreenshotBrowser();
const ids = {
  work: 'a7799750-3d73-4d2b-8daa-11fcd598e001',
  project: 'a7799750-3d73-4d2b-8daa-11fcd598e002',
  personal: 'a7799750-3d73-4d2b-8daa-11fcd598e003',
};
const fixture = {
  window: { width: 1040, height: 760 },
  sidebarWidth: 360,
  capture: { sourceSize: { width: 360, height: 600 }, scale: 2 },
};
await mkdir('test-results', { recursive: true });
try {
  await session.open(fixture, 'test-results/move-dialog-firefox.log');
  console.log('✓ Isolated Firefox sidebar opened');
  const sourceId = await session.evaluate(async (ids) => {
    const win = await browser.windows.getCurrent();
    window.moveDialogTest = {
      async send(type, args = {}) {
        const result = await browser.runtime.sendMessage({
          type: `tabernacle:${type}`,
          windowId: win.id,
          ...args,
        });
        if (!result.ok) {
          console.error('Native move check:', type, result.error);
          throw new Error(result.error);
        }
        return result.data;
      },

      async waitFor(predicate) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error('Move dialog did not reach the expected state');
      },
    };
    const { send, waitFor } = window.moveDialogTest;
    await send('createGroup', { id: ids.work, name: 'Work', parentId: null });
    await send('createGroup', { id: ids.project, name: 'Tabernacle', parentId: ids.work });
    await send('createGroup', { id: ids.personal, name: 'Personal', parentId: null });
    await send('newTab', { groupId: ids.project });
    const source = await send('newTab', { groupId: null });
    const child = await send('newChildTab', { id: source.createdTabId });
    window.moveDialogTest.childId = child.tabs.find(
      (tab) => tab.parentTabId === source.createdTabId,
    ).id;
    // The source row can predate the child; open the picker only after the
    // sidebar has rendered the complete branch from the latest snapshot.
    await waitFor(() =>
      document.querySelector(`[data-key="tab:${window.moveDialogTest.childId}"]`),
    );
    const row = document.querySelector(`[data-key="tab:${source.createdTabId}"]`);
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: rect.x + 24, clientY: rect.y + 12 }),
    );
    const action = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'Move tab…',
    );
    if (!action) throw new Error('Missing Move tab action');
    action.click();
    await waitFor(() => document.querySelector('#dialog').open);
    return source.createdTabId;
  }, ids);
  const inspect = await session.evaluate(() => {
    const dialog = document.querySelector('#dialog');
    const search = document.querySelector('#move-search');
    search.value = 'Tabernacle';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...document.querySelectorAll('#move-tree [role="treeitem"]')];
    const target = items.find((item) => item.getAttribute('aria-label') === 'Tabernacle');
    target.querySelector(':scope > .move-tree-row').click();
    const rect = dialog.getBoundingClientRect();
    return {
      folders: items.map((item) => item.getAttribute('aria-label')),
      selected: target.getAttribute('aria-selected'),
      enabled: !document.querySelector('#dialog-submit').disabled,
      forbiddenCopy: /Pinned items|Added at the end|Home \/|Position/.test(dialog.textContent),
      contained:
        rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
      description: document.querySelector('.move-source-detail').textContent,
    };
  });
  assert.deepEqual(inspect.folders, ['Home', 'Work', 'Tabernacle']);
  assert.equal(inspect.selected, 'true');
  assert.equal(inspect.enabled, true);
  assert.equal(inspect.forbiddenCopy, false);
  assert.equal(inspect.contained, true);
  assert.equal(inspect.description, 'Includes 1 child tab');
  for (const scheme of ['light', 'dark']) {
    await session.setColorScheme(scheme);
    await session.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await writeFile(
      `test-results/move-dialog-firefox-${scheme}.png`,
      await session.screenshot(fixture.capture),
    );
  }
  const result = await session.evaluate(
    async (id, projectId) => {
      const { send, waitFor, childId } = window.moveDialogTest;
      document.querySelector('#dialog-submit').click();
      await waitFor(() => !document.querySelector('#dialog').open);
      const state = await send('snapshot');
      const source = state.tabs.find((tab) => tab.id === id);
      const child = state.tabs.find((tab) => tab.id === childId);
      return {
        source: [source.groupId, source.parentTabId],
        child: [child.groupId, child.parentTabId],
        roots: state.tabs
          .filter((tab) => tab.groupId === projectId && tab.parentTabId === null)
          .sort((a, b) => a.order - b.order)
          .map((tab) => tab.id),
      };
    },
    sourceId,
    ids.project,
  );
  assert.deepEqual(result.source, [ids.project, null]);
  assert.deepEqual(result.child, [ids.project, sourceId]);
  assert.equal(result.roots.at(-1), sourceId);
  console.log(
    '✓ Native Firefox sidebar filters folders, renders both appearances and appends the complete branch',
  );
} finally {
  await session.close();
}
