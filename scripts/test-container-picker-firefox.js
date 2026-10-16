import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';

const session = new ScreenshotBrowser();
const fixture = {
  window: { width: 1040, height: 760 },
  sidebarWidth: 360,
  capture: { sourceSize: { width: 360, height: 600 }, scale: 2 },
};
await mkdir('test-results', { recursive: true });
try {
  await session.open(fixture, 'test-results/container-picker-firefox.log');
  console.log('✓ Isolated Firefox sidebar opened');
  const { sourceId, targetId, currentId } = await session.evaluate(async () => {
    const win = await browser.windows.getCurrent();
    const testing = (window.containerPickerTest = {
      async send(type, args = {}) {
        const result = await browser.runtime.sendMessage({
          type: `tabernacle:${type}`,
          windowId: win.id,
          ...args,
        });
        if (!result.ok) throw new Error(result.error);
        return result.data;
      },

      async waitFor(predicate) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error('Container picker did not reach the expected state');
      },
    });
    const current = await testing.send('createContainer', {
      name: 'projects',
      color: 'purple',
      icon: 'fence',
    });
    const target = await testing.send('createContainer', {
      name: 'Finance',
      color: 'green',
      icon: 'dollar',
    });
    const source = await testing.send('newTab', {
      cookieStoreId: current.createdCookieStoreId,
    });
    const sourceId = source.createdTabId;
    await testing.waitFor(() => document.querySelector(`[data-key="tab:${sourceId}"]`));
    const row = document.querySelector(`[data-key="tab:${sourceId}"]`);
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: rect.x + 24, clientY: rect.y + 12 }),
    );
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent === 'Reopen in container…')
      .click();
    await testing.waitFor(() => document.activeElement?.id === 'container-search');
    return {
      sourceId,
      targetId: target.createdCookieStoreId,
      currentId: current.createdCookieStoreId,
    };
  });
  const inspect = await session.evaluate((currentId) => {
    const search = document.querySelector('#container-search');
    const submit = document.querySelector('#dialog-submit');
    const list = document.querySelector('#dialog-options');
    const initialDisabled = submit.disabled;
    search.value = ' fINAnce ';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const results = [...list.querySelectorAll('.container-option:not([hidden])')];
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const selected = list.querySelector('input:checked');
    const filtered = {
      count: results.length,
      name: results[0].querySelector('.container-name').textContent,
      target: selected.value,
      enabled: !submit.disabled,
      open: document.querySelector('#dialog').open,
    };
    document.querySelector('#container-search-clear').click();
    const current = [...list.querySelectorAll('input')].find((radio) => radio.value === currentId);
    const rect = document.querySelector('#dialog').getBoundingClientRect();
    return {
      initialDisabled,
      filtered,
      currentChecked: current.checked,
      currentBadge: current.parentElement.querySelector('.container-current').textContent,
      contained:
        rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
    };
  }, currentId);
  assert.equal(inspect.initialDisabled, true);
  assert.deepEqual(inspect.filtered, {
    count: 1,
    name: 'Finance',
    target: targetId,
    enabled: true,
    open: true,
  });
  assert.equal(inspect.currentChecked, false);
  assert.equal(inspect.currentBadge, 'Current');
  assert.equal(inspect.contained, true);
  for (const scheme of ['light', 'dark']) {
    await session.setColorScheme(scheme);
    await session.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await writeFile(
      `test-results/container-picker-firefox-${scheme}.png`,
      await session.screenshot(fixture.capture),
    );
  }
  const reopened = await session.evaluate(async (sourceId) => {
    const { send, waitFor } = window.containerPickerTest;
    document.querySelector('#dialog-submit').click();
    await waitFor(() => !document.querySelector('#dialog').open);
    const state = await send('snapshot');
    return {
      original: state.tabs.some((tab) => tab.id === sourceId),
      activeStore: state.tabs.find((tab) => tab.active).cookieStoreId,
    };
  }, sourceId);
  assert.equal(reopened.original, false);
  assert.equal(reopened.activeStore, targetId);
  console.log(
    '✓ Native Firefox searches, preserves the current marker and reopens only on confirmation',
  );
} finally {
  await session.close();
}
