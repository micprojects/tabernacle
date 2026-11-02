import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Button, Key } from 'selenium-webdriver';
import { ScreenshotBrowser } from "../../scripts/screenshot-browser.js";
import { previewServer } from "../../scripts/preview.js";

// Use the real browser accelerator and enable close animations: tabs.remove()
// and reduced motion miss the interval where query() still lists an invalid ID.
const browser = new ScreenshotBrowser();
const server = await previewServer(0);
const size = { width: 330, height: 720 };
const modifier = process.platform === 'darwin' ? Key.META : Key.CONTROL;
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      headed: process.env.FIREFOX_CLOSE_HEADED === '1',
      window: { width: 1100, height: 850 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-tab-close.log',
  );
  console.log('Tab close: creating native parent and child fixture');
  await browser.chrome(() => Services.prefs.setIntPref('ui.prefersReducedMotion', 0));
  const fixture = await browser.evaluate(async (url) => {
    window.closeEvidence = { events: [], errors: [] };
    window.closeCheckSend = async (type, args = {}) => {
      const { id: windowId } = await browser.windows.getCurrent();
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    new MutationObserver(() => {
      const toast = document.getElementById('toast');
      if (!toast.hidden && toast.classList.contains('error'))
        window.closeEvidence.errors.push(toast.textContent);
    }).observe(document.getElementById('toast'), {
      attributes: true,
      childList: true,
      subtree: true,
    });
    browser.tabs.onRemoved.addListener(async (id) => {
      const tabs = await browser.tabs.query({});
      const lookup = await browser.tabs.get(id).then(
        () => 'exists',
        (error) => error.message,
      );
      window.closeEvidence.events.push({ id, listed: tabs.some((tab) => tab.id === id), lookup });
    });
    const groupId = (await window.closeCheckSend('createGroup', { name: 'Close regression' }))
      .createdGroupId;
    const parent = await browser.tabs.create({ url, active: true });
    await window.closeCheckSend('moveTab', { id: parent.id, groupId });
    const child = await browser.tabs.create({ url, active: false });
    await window.closeCheckSend('nestTab', { id: child.id, parentTabId: parent.id });
    const state = await window.closeCheckSend('snapshot');
    return { groupId, parent: state.tabs.find((tab) => tab.id === parent.id), child: child.id };
  }, `http://127.0.0.1:${server.address().port}/preview/index.html`);

  const read = () => browser.evaluate(() => window.closeCheckSend('snapshot'));
  const visible = (id, expected) =>
    browser.driver.wait(
      () =>
        browser.evaluate(
          (id, expected) => Boolean(document.querySelector(`[data-key="tab:${id}"]`)) === expected,
          id,
          expected,
        ),
      7000,
    );

  async function closeWithShortcut(id) {
    await visible(id, true);
    // Let the opening animation finish so the close uses its animated path.
    await browser.driver.sleep(300);
    await browser.chrome(() => gBrowser.selectedBrowser.focus());
    await browser.driver.actions().keyDown(modifier).sendKeys('w').keyUp(modifier).perform();
    await visible(id, false);
  }

  // A native close affects only the parent; undo must restore its identity and
  // reconnect the surviving child even though Firefox assigns a new tab ID.
  console.log('Tab close: checking native parent close and undo');
  await closeWithShortcut(fixture.parent.id);
  let state = await read();
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, null);
  state = await browser.evaluate(() => window.closeCheckSend('undoCloseTab'));
  let restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.notEqual(restored.id, fixture.parent.id);
  assert.equal(restored.treeId, fixture.parent.treeId);
  assert.equal(restored.groupId, fixture.groupId);
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, restored.id);

  console.log('Tab close: checking repeated native shortcuts');
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = await browser.evaluate(async (groupId) => {
      const state = await window.closeCheckSend('newTab', { groupId });
      return state.createdTabId;
    }, fixture.groupId);
    await closeWithShortcut(id);
    assert(!(await read()).tabs.some((tab) => tab.id === id));
  }

  // Click the actual sidebar x as well, through WebDriver pointer input.
  console.log('Tab close: checking sidebar close button');
  const leaf = await browser.evaluate(async (groupId) => {
    const state = await window.closeCheckSend('newTab', { groupId });
    return state.createdTabId;
  }, fixture.groupId);
  await visible(leaf, true);
  const offset = await browser.chrome(() => {
    const sidebar = document.getElementById('sidebar');
    const outer = sidebar.getBoundingClientRect();
    const inner = sidebar.contentDocument
      .getElementById('webext-panels-browser')
      .getBoundingClientRect();
    return { x: outer.x + inner.x, y: outer.y + inner.y };
  });
  const rect = await browser.evaluate((id) => {
    const rect = document
      .querySelector(`[data-key="tab:${id}"] .close-tab`)
      .getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, leaf);
  await browser.driver
    .actions()
    .move({ x: Math.round(offset.x + rect.x), y: Math.round(offset.y + rect.y) })
    .press(Button.LEFT)
    .release(Button.LEFT)
    .perform();
  await visible(leaf, false);
  state = await read();
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, restored.id);
  assert(state.groups.some((group) => group.id === fixture.groupId));

  console.log('Tab close: checking branch promotion and undo');
  const branch = await browser.evaluate(
    async ({ parent, child }) => {
      const grandchild = (await window.closeCheckSend('newChildTab', { id: child })).tabs.find(
        (tab) => tab.active,
      ).id;
      const sibling = (await window.closeCheckSend('newChildTab', { id: parent })).tabs.find(
        (tab) => tab.active,
      ).id;
      await window.closeCheckSend('activateTab', { id: parent });
      return { grandchild, sibling };
    },
    { parent: restored.id, child: fixture.child },
  );
  for (const [selector, button] of [
    ['.label', Button.MIDDLE],
    ['.close-tab', Button.LEFT],
  ]) {
    await visible(restored.id, true);
    await visible(branch.sibling, true);
    const parentRect = await browser.evaluate(
      (id, selector) => {
        const rect = document
          .querySelector(`[data-key="tab:${id}"] ${selector}`)
          .getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      restored.id,
      selector,
    );
    await browser.driver
      .actions()
      .move({ x: Math.round(offset.x + parentRect.x), y: Math.round(offset.y + parentRect.y) })
      .press(button)
      .release(button)
      .perform();
    await visible(restored.id, false);
    state = await read();
    assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, null);
    assert.equal(state.tabs.find((tab) => tab.id === branch.sibling).parentTabId, fixture.child);
    assert.equal(state.tabs.find((tab) => tab.id === branch.grandchild).parentTabId, fixture.child);
    state = await browser.evaluate(() => window.closeCheckSend('undoCloseTab'));
    restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
    assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, restored.id);
    assert.equal(state.tabs.find((tab) => tab.id === branch.sibling).parentTabId, restored.id);
    assert.equal(state.tabs.find((tab) => tab.id === branch.grandchild).parentTabId, fixture.child);
  }
  console.log(
    '✓ Native middle click and close button promote the first child, preserve descendants and support undo',
  );

  console.log('Tab close: checking folder-aware successor selection');
  const selection = await browser.evaluate(async (outsideId) => {
    const groupId = (await window.closeCheckSend('createGroup', { name: 'Folder-aware close' }))
      .createdGroupId;
    await window.closeCheckSend('enterGroup', { id: groupId });
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push((await window.closeCheckSend('newTab', { groupId })).createdTabId);
    const [above, closing, below] = ids;
    await window.closeCheckSend('activateTab', { id: closing });
    // Make Firefox's own choice deterministic and outside the current folder.
    await browser.tabs.update(closing, { successorTabId: outsideId });
    return { groupId, above, closing, below, outsideId };
  }, fixture.child);

  async function selected(id, hidden = false) {
    await browser.driver.wait(async () => {
      const state = await read();
      return state.tabs.find((tab) => tab.active)?.id === id;
    }, 7000);
    await browser.driver.wait(
      () =>
        browser.evaluate((hidden) => document.getElementById('reveal').hidden !== hidden, hidden),
      7000,
    );
    assert.equal((await read()).view.scopeId, selection.groupId);
  }

  async function closeFromSidebar(id) {
    await visible(id, true);
    const rect = await browser.evaluate((id) => {
      const rect = document
        .querySelector(`[data-key="tab:${id}"] .close-tab`)
        .getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, id);
    await browser.driver
      .actions()
      .move({ x: Math.round(offset.x + rect.x), y: Math.round(offset.y + rect.y) })
      .press(Button.LEFT)
      .release(Button.LEFT)
      .perform();
    await visible(id, false);
  }

  await closeWithShortcut(selection.closing);
  await selected(selection.below);
  await browser.evaluate(
    async ({ below, outsideId }) => browser.tabs.update(below, { successorTabId: outsideId }),
    selection,
  );
  await closeFromSidebar(selection.below);
  await selected(selection.above);

  const returning = await browser.evaluate(async ({ groupId, above }) => {
    const id = (await window.closeCheckSend('newTab', { groupId })).createdTabId;
    await browser.tabs.update(id, { successorTabId: above });
    return id;
  }, selection);
  await closeWithShortcut(returning);
  await selected(selection.above);

  const background = await browser.evaluate(async ({ groupId, above }) => {
    const id = (await window.closeCheckSend('newTab', { groupId })).createdTabId;
    await window.closeCheckSend('activateTab', { id: above });
    return id;
  }, selection);
  await closeFromSidebar(background);
  await selected(selection.above);
  await browser.evaluate(
    async ({ above, outsideId }) => browser.tabs.update(above, { successorTabId: outsideId }),
    selection,
  );
  await closeWithShortcut(selection.above);
  await selected(selection.outsideId, true);

  const settingsRect = await browser.evaluate(() => {
    const rect = document.getElementById('settings').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  console.log('Tab close: checking Settings reopenings during close animations');
  const reopenings = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const { tabId: closingId } = await browser.evaluate(() =>
      window.closeCheckSend('openPage', { page: 'settings' }),
    );
    await browser.driver.sleep(350);
    // Position the pointer before closing: moving it afterwards can outlast
    // the close animation and miss the stale ID returned by tabs.query().
    await browser.driver
      .actions()
      .move({ x: Math.round(offset.x + settingsRect.x), y: Math.round(offset.y + settingsRect.y) })
      .perform();
    await browser.chrome(() => gBrowser.selectedBrowser.focus());
    await browser.driver.actions().keyDown(modifier).sendKeys('w').keyUp(modifier).perform();
    await browser.driver.actions().press(Button.LEFT).release(Button.LEFT).perform();
    await browser.driver.sleep(400);
    const tabs = await browser.evaluate(async () =>
      (await browser.tabs.query({}))
        .filter((tab) => tab.url === browser.runtime.getURL('settings.html'))
        .map((tab) => ({ id: tab.id, active: tab.active })),
    );
    reopenings.push({ closingId, tabs });
  }

  console.log('Tab close: checking reviewed branch IDs across live native changes');
  const confirmedBranch = await browser.evaluate(async (url) => {
    const groupId = (await window.closeCheckSend('createGroup', { name: 'Reviewed branch' }))
      .createdGroupId;

    const create = async (title) => {
      const tab = await browser.tabs.create({ url, title, active: false, discarded: true });
      await window.closeCheckSend('moveTab', { id: tab.id, groupId });
      return tab.id;
    };

    const root = await create('Reviewed root');
    const child = await create('Reviewed child');
    const deep = await create('Reviewed grandchild');
    const detached = await create('Later detached child');
    const unrelated = await create('Unrelated branch control');
    await window.closeCheckSend('nestTab', { id: child, parentTabId: root });
    await window.closeCheckSend('nestTab', { id: deep, parentTabId: child });
    await window.closeCheckSend('nestTab', { id: detached, parentTabId: root });
    await window.closeCheckSend('toggleTab', { id: root });
    await window.closeCheckSend('activateTab', { id: unrelated });
    await window.closeCheckSend('enterGroup', { id: groupId });
    return { groupId, root, child, deep, detached, unrelated };
  }, `http://127.0.0.1:${server.address().port}/preview/index.html?reviewed-branch`);
  await visible(confirmedBranch.root, true);
  await visible(confirmedBranch.unrelated, true);
  await visible(confirmedBranch.child, false);
  await visible(confirmedBranch.deep, false);
  await visible(confirmedBranch.detached, false);
  await browser.driver.wait(
    () =>
      browser.evaluate(async (id) => {
        const tab = await browser.tabs.get(id);
        return tab.active && tab.status === 'complete';
      }, confirmedBranch.unrelated),
    7000,
  );

  const clickBranchControl = async (selector, text = null, button = Button.LEFT) => {
    const rect = await browser.evaluate(
      (selector, text) => {
        const node = [...document.querySelectorAll(selector)].find(
          (node) => text === null || node.textContent.trim() === text,
        );
        if (!node) throw new Error(`Missing branch confirmation control: ${selector} ${text}`);
        node.scrollIntoView({ block: 'nearest' });
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      },
      selector,
      text,
    );
    await browser.driver
      .actions()
      .move({ x: Math.round(offset.x + rect.x), y: Math.round(offset.y + rect.y) })
      .press(button)
      .release(button)
      .perform();
  };

  await clickBranchControl(`[data-key="tab:${confirmedBranch.root}"] .label`, null, Button.RIGHT);
  await browser.driver.wait(
    () => browser.evaluate(() => !document.getElementById('menu').hidden),
    7000,
  );
  await clickBranchControl('#menu [role="menuitem"]', 'Close tab and nested tabs…');
  await browser.driver.wait(
    () => browser.evaluate(() => document.getElementById('dialog').open),
    7000,
  );
  const branchDialog = () =>
    browser.evaluate(() => ({
      open: document.getElementById('dialog').open,
      title: document.getElementById('dialog-title').textContent,
      description: document.getElementById('dialog-description').textContent,
      submit: document.getElementById('dialog-submit').textContent,
      cancelFocused: document.activeElement === document.getElementById('dialog-cancel'),
      menuHidden: document.getElementById('menu').hidden,
    }));
  const openingBranchDialog = await branchDialog();
  assert.deepEqual(openingBranchDialog, {
    open: true,
    title: 'Close tab and nested tabs?',
    description: '“Reviewed root” and its 3 nested tabs will close.',
    submit: 'Close 4 tabs',
    cancelFocused: true,
    menuHidden: true,
  });

  // Change the actual native/controller state while leaving the original modal
  // open. The new child was not reviewed; the detached child is no longer in it.
  const newBranchChild = await browser.evaluate(
    async ({ root, detached, url }) => {
      const tab = await browser.tabs.create({
        url,
        title: 'New unreviewed child',
        active: false,
        discarded: true,
      });
      const nested = await window.closeCheckSend('nestTab', { id: tab.id, parentTabId: root });
      if (nested.tabs.find((tab) => tab.id === root).collapsed)
        throw new Error('Nesting a new child must expand its parent');
      await window.closeCheckSend('toggleTab', { id: root });
      await window.closeCheckSend('detachTab', { id: detached });
      return tab.id;
    },
    {
      ...confirmedBranch,
      url: `http://127.0.0.1:${server.address().port}/preview/index.html?unreviewed-child`,
    },
  );
  await visible(confirmedBranch.detached, true);
  await visible(newBranchChild, false);
  assert.deepEqual(await branchDialog(), openingBranchDialog);
  const branchRecords = () =>
    browser.evaluate(async () => {
      const state = await window.closeCheckSend('snapshot');
      return {
        state,
        native: (await browser.tabs.query({})).map(
          ({ id, windowId, url, active, pinned, discarded, cookieStoreId }) => ({
            id,
            windowId,
            url,
            active,
            pinned,
            discarded,
            cookieStoreId,
          }),
        ),
        memberships: await Promise.all(
          state.tabs
            .map(({ id }) => id)
            .sort((a, b) => a - b)
            .map(async (id) => [
              id,
              await browser.sessions.getTabValue(id, 'tabernacle.membership.v1'),
            ]),
        ),
      };
    });
  const beforeBranchClose = await branchRecords();
  const branchTab = (records, id) => records.state.tabs.find((tab) => tab.id === id);
  assert.equal(branchTab(beforeBranchClose, confirmedBranch.root).collapsed, true);
  assert.equal(branchTab(beforeBranchClose, confirmedBranch.detached).parentTabId, null);
  assert.equal(branchTab(beforeBranchClose, newBranchChild).parentTabId, confirmedBranch.root);
  const branchClosedIds = [confirmedBranch.root, confirmedBranch.child, confirmedBranch.deep];
  await clickBranchControl('#dialog-submit', 'Close 4 tabs');
  await browser.driver.wait(async () => {
    const current = await read();
    const nativeIds = await browser.evaluate(async () =>
      (await browser.tabs.query({})).map((tab) => tab.id),
    );
    return (
      !(await branchDialog()).open &&
      branchClosedIds.every(
        (id) => !current.tabs.some((tab) => tab.id === id) && !nativeIds.includes(id),
      )
    );
  }, 7000);
  const afterBranchClose = await branchRecords();
  assert.deepEqual(
    afterBranchClose.native,
    beforeBranchClose.native.filter((tab) => !branchClosedIds.includes(tab.id)),
  );
  assert.deepEqual(afterBranchClose.state.groups, beforeBranchClose.state.groups);
  assert.deepEqual(afterBranchClose.state.view, beforeBranchClose.state.view);
  // Missing parents affect the resolved tree, not saved ancestry. Keeping the
  // original membership lets native undo reconnect the surviving new child.
  assert.deepEqual(
    afterBranchClose.memberships,
    beforeBranchClose.memberships.filter(([id]) => !branchClosedIds.includes(id)),
  );
  for (const before of beforeBranchClose.state.tabs.filter(
    (tab) => !branchClosedIds.includes(tab.id),
  )) {
    const after = branchTab(afterBranchClose, before.id);
    assert(after, `Unreviewed or detached tab ${before.id} must survive`);
    for (const key of [
      'treeId',
      'groupId',
      'order',
      'ancestors',
      'collapsed',
      'openedAt',
      'pinned',
      'cookieStoreId',
      'windowId',
      'url',
    ])
      assert.deepEqual(after[key], before[key], `Surviving tab ${before.id} changed ${key}`);
    assert.equal(after.parentTabId, before.id === newBranchChild ? null : before.parentTabId);
  }
  await visible(newBranchChild, true);
  await visible(confirmedBranch.detached, true);
  await visible(confirmedBranch.unrelated, true);
  console.log(
    '✓ Native branch confirmation preserves its opening set across new and detached children',
  );

  const evidence = {
    environment: browser.environment,
    folderAwareSelection: selection,
    reopenings,
    branchConfirmation: {
      fixture: confirmedBranch,
      newChild: newBranchChild,
      closedIds: branchClosedIds,
      opening: openingBranchDialog,
      before: beforeBranchClose,
      after: afterBranchClose,
    },
    ...(await browser.evaluate(() => window.closeEvidence)),
  };
  await writeFile('test-results/firefox-tab-close.json', JSON.stringify(evidence, null, 2));
  assert.deepEqual(evidence.errors, [], 'Closing and reopening tabs must not display errors');
  assert(
    evidence.events.some(({ id, listed, lookup }) => listed && lookup === `Invalid tab ID: ${id}`),
    'The test must exercise a close animation with an invalid ID still present in query()',
  );
  for (const { closingId, tabs } of reopenings) {
    assert.equal(tabs.length, 1, 'Immediately reopening Settings must create exactly one page');
    assert.notEqual(tabs[0].id, closingId);
    assert.equal(tabs[0].active, true);
  }
  console.log('✓ Native close shortcut, sidebar x and undo preserve organisation without errors');
  console.log(
    '✓ Settings reopens immediately during close animations without errors or duplicates',
  );
  console.log(
    '✓ Folder-aware native and sidebar closes preserve visible choices and empty folders',
  );
} finally {
  console.log('Tab close: closing isolated browser');
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
