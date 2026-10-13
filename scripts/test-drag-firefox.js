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
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
