import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Button, Key } from 'selenium-webdriver';
import { ScreenshotBrowser } from './screenshot-browser.js';
import { previewServer } from './preview.js';

// Exercise the actual native sidebar, whose viewport and pointer capture differ
// from opening sidebar.html as a normal extension tab. This browser owns its profile.
const browser = new ScreenshotBrowser();
const server = await previewServer(0);
const size = { width: 330, height: 720 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      headed: process.env.FIREFOX_DRAG_HEADED === '1',
      window: { width: 1100, height: 850 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-native-drag.log',
  );
  const fixture = await browser.evaluate(async (url) => {
    const win = await browser.windows.getCurrent();
    window.dragCheckSend = async (type, args = {}) => {
      const result = await browser.runtime.sendMessage({
        type: 'tabernacle:' + type,
        windowId: win.id,
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const send = window.dragCheckSend;
    const source = (await send('createGroup', { name: 'Source' })).createdGroupId;
    const destination = (await send('createGroup', { name: 'Destination' })).createdGroupId;
    const inner = (await send('createGroup', { name: 'Inner', parentId: destination }))
      .createdGroupId;
    const moving = await browser.tabs.create({ url, active: true });
    const parent = await browser.tabs.create({ url, active: false });
    const child = await browser.tabs.create({ url, active: false });
    await send('moveTab', { id: moving.id, groupId: source });
    await send('moveTab', { id: parent.id, groupId: inner });
    await send('nestTab', { id: child.id, parentTabId: parent.id });
    await send('toggleTab', { id: parent.id });
    await send('toggleGroup', { id: inner });
    await send('toggleGroup', { id: destination });
    // Home must virtualise while the drag crosses into it. These real,
    // discarded tabs avoid loading extra pages in the isolated profile.
    for (let i = 0; i < 150; i++)
      await browser.tabs.create({
        url,
        title: `Viewport filler ${i}`,
        active: false,
        discarded: true,
      });
    await send('enterGroup', { id: source });
    return { source, destination, inner, moving: moving.id, parent: parent.id, child: child.id };
  }, `http://127.0.0.1:${server.address().port}/preview/index.html`);

  const tab = (id) => `[data-key="tab:${id}"]`;
  const group = (id) => `[data-key="group:${id}"]`;
  const read = () => browser.evaluate(() => window.dragCheckSend('snapshot'));
  const wait = (fn, ...args) => browser.driver.wait(() => browser.evaluate(fn, ...args), 7000);
  const visible = (selector) =>
    wait(
      (selector) => Boolean(document.querySelector(selector)?.getClientRects().length),
      selector,
    );

  async function point(selector) {
    const offset = await browser.chrome(() => {
      const sidebar = document.getElementById('sidebar');
      const outer = sidebar.getBoundingClientRect();
      const inner = sidebar.contentDocument
        .getElementById('webext-panels-browser')
        .getBoundingClientRect();
      return { x: outer.x + inner.x, y: outer.y + inner.y };
    });
    const rect = await browser.evaluate((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x + Math.min(60, rect.width / 2), y: rect.y + rect.height / 2 };
    }, selector);
    return { x: Math.round(offset.x + rect.x), y: Math.round(offset.y + rect.y) };
  }

  async function hover(selector) {
    await browser.driver
      .actions()
      .move({ ...(await point(selector)), duration: 180 })
      .perform();
  }

  async function begin(selector) {
    const start = await point(selector);
    await browser.driver
      .actions()
      .move(start)
      .press(Button.LEFT)
      .move({ ...start, y: start.y + 7, duration: 100 })
      .perform();
    await wait(() => !document.querySelector('.move-preview').hidden);
  }

  await visible(tab(fixture.moving));
  const initial = await read();
  await begin(tab(fixture.moving));
  await hover('#home');
  await visible(group(fixture.destination));
  assert.equal(
    await browser.evaluate(() =>
      document.querySelector('#tree').classList.contains('viewport-tree'),
    ),
    true,
  );
  await hover(group(fixture.destination));
  await visible(group(fixture.inner));
  await hover(group(fixture.inner));
  await visible(tab(fixture.parent));
  await hover(tab(fixture.parent));
  await visible(tab(fixture.child));
  await hover(tab(fixture.child));
  assert.deepEqual((await read()).view, initial.view, 'Hover navigation must remain temporary');
  await writeFile(
    'test-results/firefox-native-drag-preview.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  await browser.driver.actions().release(Button.LEFT).perform();
  await wait(
    async (id, parentId) =>
      (await window.dragCheckSend('snapshot')).tabs.find((tab) => tab.id === id)?.parentTabId ===
      parentId,
    fixture.moving,
    fixture.child,
  );
  await visible(tab(fixture.moving));
  assert.equal((await read()).tabs.find((tab) => tab.active).id, fixture.moving);
  console.log(
    '✓ Actual Firefox sidebar: uninterrupted pointer capture across Home, two collapsed folders and a collapsed tab; result revealed without page activation',
  );

  const beforeCancel = await read();
  await begin(tab(fixture.moving));
  await hover('#home');
  await visible(group(fixture.source));
  await browser.driver
    .actions()
    .keyDown(Key.ESCAPE)
    .keyUp(Key.ESCAPE)
    .release(Button.LEFT)
    .perform();
  await wait(() => document.querySelector('.move-preview').hidden);
  assert.deepEqual((await read()).view, beforeCancel.view);
  assert.equal(
    await browser.evaluate(
      () => document.querySelectorAll('.dragging,.drop-inside,.drop-before,.drop-after').length,
    ),
    0,
  );
  await writeFile(
    'test-results/firefox-native-drag-result.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  console.log('✓ Actual Firefox sidebar: Escape restores the view and removes all drag feedback');

  await browser.evaluate(() => window.dragCheckSend('enterGroup', { id: null }));
  await wait(() => document.getElementById('tree').classList.contains('viewport-tree'));
  const focus = await browser.evaluate(async () => {
    const tree = document.getElementById('tree');
    tree.scrollTop = 0;
    tree.dispatchEvent(new Event('scroll'));
    const control = tree.querySelector('.tab-row .close-tab');
    control.focus();
    window.viewportFocusControl = control;
    let blurred = 0;
    let detached = 0;
    control.addEventListener('blur', () => blurred++);
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node === control || node.contains?.(control)) detached++;
    });
    observer.observe(tree, { childList: true, subtree: true });
    const limit = tree.scrollHeight - tree.clientHeight;
    const step = Math.max(1, tree.clientHeight - 60);
    for (let top = 0; top <= limit + step; top += step) {
      tree.scrollTop = Math.min(limit, top);
      tree.dispatchEvent(new Event('scroll'));
      await new Promise(window.requestAnimationFrame);
    }
    observer.disconnect();
    return {
      same: document.activeElement === control,
      connected: control.isConnected,
      blurred,
      detached,
      mounted: tree.querySelectorAll('.tab-row').length,
    };
  });
  assert.deepEqual(
    { ...focus, mounted: undefined },
    { same: true, connected: true, blurred: 0, detached: 0, mounted: undefined },
  );
  assert(focus.mounted < 100);
  const scrolledId = await browser.evaluate(() => {
    const row = [...document.querySelectorAll('#tree .tab-row')].at(-1);
    const id = Number(row.dataset.id);
    row.querySelector('.close-tab').click();
    return id;
  });
  await wait(
    async (id) => !(await window.dragCheckSend('snapshot')).tabs.some((tab) => tab.id === id),
    scrolledId,
  );
  assert.equal(await browser.evaluate(() => viewportFocusControl === document.activeElement), true);
  console.log(
    '✓ Actual Firefox sidebar: viewport scrolling keeps the focused control attached; closing a newly mounted row targets the correct tab',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
