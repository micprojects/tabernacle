import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Button, Key } from 'selenium-webdriver';
import { ScreenshotBrowser } from './screenshot-browser.js';
import { previewServer } from './preview.js';

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
  await closeWithShortcut(fixture.parent.id);
  let state = await read();
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, null);
  state = await browser.evaluate(() => window.closeCheckSend('undoCloseTab'));
  const restored = state.tabs.find((tab) => tab.id === state.restoredTabId);
  assert.notEqual(restored.id, fixture.parent.id);
  assert.equal(restored.treeId, fixture.parent.treeId);
  assert.equal(restored.groupId, fixture.groupId);
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).parentTabId, restored.id);

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = await browser.evaluate(async (groupId) => {
      const state = await window.closeCheckSend('newTab', { groupId });
      return state.createdTabId;
    }, fixture.groupId);
    await closeWithShortcut(id);
    assert(!(await read()).tabs.some((tab) => tab.id === id));
  }

  // Click the actual sidebar x as well, through WebDriver pointer input.
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

  const settingsRect = await browser.evaluate(() => {
    const rect = document.getElementById('settings').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
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

  const evidence = {
    environment: browser.environment,
    reopenings,
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
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
