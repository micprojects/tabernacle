import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { By, Button, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { startFirefox } from '../../scripts/firefox-session.js';
import { ScreenshotBrowser } from '../../scripts/screenshot-browser.js';
import { previewServer } from '../../scripts/preview.js';

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

  console.log('Tab close: checking collapsed middle-click confirmation');
  const collapsedBranch = await browser.evaluate(async (groupId) => {
    const parent = (await window.closeCheckSend('newTab', { groupId })).createdTabId;
    const newChild = async (id) =>
      (await window.closeCheckSend('newChildTab', { id })).tabs.find((tab) => tab.active).id;
    const child = await newChild(parent);
    const grandchild = await newChild(child);
    const sibling = await newChild(parent);
    await window.closeCheckSend('toggleTab', { id: parent });
    return [parent, child, grandchild, sibling];
  }, fixture.groupId);
  const collapsedSelector = `[data-key="tab:${collapsedBranch[0]}"]`;
  await browser.driver.wait(
    () =>
      browser.evaluate(
        (selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false',
        collapsedSelector,
      ),
    7000,
  );
  const beforeCollapsedClose = await read();

  async function clickSidebar(selector, button = Button.LEFT) {
    const rect = await browser.evaluate((selector) => {
      const node = document.querySelector(selector);
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);
    await browser.driver
      .actions()
      .move({ x: Math.round(offset.x + rect.x), y: Math.round(offset.y + rect.y) })
      .press(button)
      .release(button)
      .perform();
  }

  for (const button of ['dialog-cancel', 'dialog-close', 'dialog-submit']) {
    await clickSidebar(`${collapsedSelector} .label`, Button.MIDDLE);
    await browser.driver.wait(
      () => browser.evaluate(() => document.getElementById('dialog').open),
      7000,
    );
    assert.equal(
      await browser.evaluate(() => document.getElementById('dialog-submit').textContent),
      'Close 4 tabs',
    );
    assert.match(
      await browser.evaluate(() => document.getElementById('dialog-description').textContent),
      /and its 3 nested tabs/,
    );
    assert.deepEqual((await read()).tabs, beforeCollapsedClose.tabs);
    await clickSidebar(`#${button}`);
    await browser.driver.wait(
      () => browser.evaluate(() => !document.getElementById('dialog').open),
      7000,
    );
    if (button !== 'dialog-submit')
      assert.deepEqual((await read()).tabs, beforeCollapsedClose.tabs);
  }
  await visible(collapsedBranch[0], false);
  const afterCollapsedClose = await read();
  assert.deepEqual(
    afterCollapsedClose.tabs.map((tab) => tab.id),
    beforeCollapsedClose.tabs
      .filter((tab) => !collapsedBranch.includes(tab.id))
      .map((tab) => tab.id),
  );
  assert.deepEqual(afterCollapsedClose.groups, beforeCollapsedClose.groups);
  console.log('✓ Collapsed middle click confirms the total, cancels safely and closes every depth');

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

async function checkCloseConfirmation() {
  const root = 'test-results/';
  const report = { startedAt: new Date().toISOString(), stages: [] };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Unsaved close QA</title><button id="dirty">Edit document</button><script>document.getElementById("dirty").onclick=()=>{window.onbeforeunload=event=>{event.preventDefault();event.returnValue="";};document.title="Unsaved document";};</script>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  let session, driver;
  try {
    const options = new firefox.Options()
      .enableBidi()
      .setAlertBehavior({ default: 'ignore', beforeUnload: 'ignore' });
    session = await startFirefox({ options });
    driver = session.driver;
    report.environment = { version: session.version, profile: session.profile };
    await driver.manage().setTimeouts({ script: 15000, pageLoad: 15000 });
    const addon = await driver.installAddon(resolve('extension'), true);
    await driver.setContext(firefox.Context.CHROME);
    const uuid = await driver.executeScript(
      'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
      addon,
    );
    await driver.setContext(firefox.Context.CONTENT);
    await driver.get(`moz-extension://${uuid}/settings.html`);
    await driver.wait(
      async () => await driver.findElement(By.id('look-color-scheme')).isEnabled(),
      10000,
    );
    const control = await driver.getWindowHandle();
    const sidebar = new ScreenshotBrowser();
    sidebar.driver = driver;
    sidebar.sidebarUrl = `moz-extension://${uuid}/sidebar.html`;

    const inSidebar = async (fn, ...args) => {
      await driver.setContext(firefox.Context.CHROME);
      try {
        return await sidebar.evaluate(fn, ...args);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    };

    const call = async (body, ...args) => {
      const result = await driver.executeAsyncScript(
        `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),e=>done({ok:false,error:e.message}));`,
        ...args,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };

    const f = await call(
      `
  const {windowId}=await browser.tabs.getCurrent();
  window.send=async(type,args={})=>browser.runtime.sendMessage({type:'tabernacle:'+type,windowId,...args});
  const parent=await browser.tabs.create({url:arguments[0]+'?parent',active:true});
  const child=await browser.tabs.create({url:arguments[0]+'?child',active:false});
  const sibling=await browser.tabs.create({url:arguments[0]+'?sibling',active:false});
  for(const tab of [child,sibling]){const result=await send('nestTab',{id:tab.id,parentTabId:parent.id});if(!result.ok)throw new Error(result.error);}
  return {windowId,parent:parent.id,child:child.id,sibling:sibling.id};
 `,
      url,
    );
    let dirtyHandle;
    await driver.wait(async () => {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()) === url + '?parent') {
          dirtyHandle = handle;
          return true;
        }
      }
      return false;
    }, 10000);
    await driver.findElement(By.id('dirty')).click();
    assert.equal(
      await driver.executeScript('return navigator.userActivation.hasBeenActive;'),
      true,
    );
    await driver.switchTo().window(control);
    const before = await call(
      `return {snapshot:await send('snapshot'),raw:await Promise.all(arguments[0].map(async id=>[id,await browser.sessions.getTabValue(id,'tabernacle.membership.v1')]))};`,
      [f.parent, f.child, f.sibling],
    );
    report.fixture = f;
    report.before = before;

    await inSidebar(() => {
      const send = browser.runtime.sendMessage.bind(browser.runtime);
      browser.runtime.sendMessage = (...args) =>
        send(...args).then((result) => {
          if (args[0]?.type === 'tabernacle:closeTab') window.closeResult = result;
          return result;
        });
    });

    const attempt = async (type, args, accept) => {
      await driver.switchTo().window(control);
      if (type === 'closeTab') {
        await driver.wait(
          () =>
            inSidebar(
              (id) => Boolean(document.querySelector(`[data-key="tab:${id}"] .close-tab`)),
              args.id,
            ),
          10000,
        );
        const hiddenImmediately = await inSidebar((id) => {
          window.closeResult = undefined;
          document.querySelector(`[data-key="tab:${id}"] .close-tab`).click();
          return !document.querySelector(`[data-key="tab:${id}"]`);
        }, args.id);
        assert.equal(hiddenImmediately, true, 'The sidebar hides before Firefox answers the close');
      } else {
        await driver.executeScript(
          `window.closeResult=undefined;window.send(arguments[0],arguments[1]).then(value=>window.closeResult=value,e=>window.closeResult={ok:false,error:e.message});`,
          type,
          args,
        );
      }
      await driver.switchTo().window(dirtyHandle);
      const alert = await driver.wait(
        async () => {
          try {
            const alert = await driver.switchTo().alert();
            await alert.getText();
            return alert;
          } catch (error) {
            if (error.name === 'NoSuchAlertError') return false;
            throw error;
          }
        },
        10000,
        'Extension close must display the real unsaved-page prompt',
      );
      const prompt = await alert.getText();
      if (accept) await alert.accept();
      else await alert.dismiss();
      await driver.switchTo().window(control);
      const readResult = () =>
        type === 'closeTab'
          ? inSidebar(() => window.closeResult)
          : driver.executeScript('return window.closeResult;');
      await driver.wait(async () => Boolean(await readResult()), 10000);
      const result = await readResult();
      const after = await call(
        `return {snapshot:await send('snapshot'),raw:await Promise.all(arguments[0].map(async id=>[id,await browser.sessions.getTabValue(id,'tabernacle.membership.v1').catch(()=>null)]))};`,
        [f.parent, f.child, f.sibling],
      );
      report.stages.push({ type, accept, prompt, result, after });
      if (type === 'closeTab') {
        await driver.wait(
          () =>
            inSidebar(
              ({ id, accept }) =>
                Boolean(document.querySelector(`[data-key="tab:${id}"]`)) === !accept,
              { id: args.id, accept },
            ),
          10000,
        );
        const order = await inSidebar(() =>
          [...document.querySelectorAll('#tree .tab-row')].map((row) => Number(row.dataset.id)),
        );
        assert.deepEqual(
          order.filter((id) => [f.parent, f.child, f.sibling].includes(id)),
          accept ? [f.child, f.sibling] : [f.parent, f.child, f.sibling],
        );
      }
      return { result, after };
    };

    const single = await attempt('closeTab', { id: f.parent, promoteFirstChild: true }, false);
    const target = before.snapshot.data.tabs.find((tab) => tab.id === f.parent);
    const capture = await call(
      `const {captureTarget}=await import(browser.runtime.getURL('src/tab-collection.js'));return captureTarget(arguments[0]);`,
      target,
    );
    const batch = await attempt(
      'closeTabSet',
      { scope: { kind: 'window' }, targets: [capture] },
      false,
    );

    assert.equal(single.result.ok, false, 'A cancelled parent close must not report success');
    assert.deepEqual(
      single.after.raw,
      before.raw,
      'Cancelling rolls back the prepared child promotion',
    );
    assert.deepEqual(batch.result.data.batchResult.completed, []);
    assert.equal(batch.result.data.batchResult.failed.length, 1);
    const accepted = await attempt('closeTab', { id: f.parent, promoteFirstChild: true }, true);
    assert.equal(accepted.result.ok, true);
    assert(!accepted.after.snapshot.data.tabs.some((tab) => tab.id === f.parent));
    report.passed = true;
    console.log(
      'Real Firefox cancelled close keeps data, reports failure and retries successfully when accepted.',
    );
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(
      root + 'cancelled-close-native-report.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    try {
      if (driver) {
        try {
          await driver.switchTo().alert().dismiss();
        } catch {}
        await driver.setContext(firefox.Context.CONTENT);
        for (const handle of await driver.getAllWindowHandles()) {
          await driver.switchTo().window(handle);
          if ((await driver.getCurrentUrl()).startsWith(url))
            await driver.executeScript('window.onbeforeunload=null;');
        }
      }
    } catch {
    } finally {
      try {
        await session?.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
}

await checkCloseConfirmation();
