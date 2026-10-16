import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { visibleTabOrder } from '../extension/src/close-selection.js';
import { VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

async function fixture({ events = true, windowId = 1 } = {}) {
  const api = memoryBrowser({
    events,
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'nested', name: 'Nested', parentId: 'work' },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      { id: 1, windowId, index: 0, title: 'Outside' },
      { id: 2, windowId, index: 1, title: 'Above' },
      { id: 3, windowId, index: 2, title: 'Closing', active: true },
      { id: 4, windowId, index: 3, title: 'Below' },
      { id: 5, windowId, index: 4, title: 'Nested' },
      { id: 6, windowId, index: 5, title: 'Pin', pinned: true },
    ],
    memberships: Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((id) => [
        id,
        {
          groupId: id === 1 ? 'other' : id === 5 ? 'nested' : 'work',
          treeId: `t${id}`,
          ancestors: [],
        },
      ]),
    ),
  });
  await api.sessions.setWindowValue(windowId, VIEW_KEY, { scopeId: 'work', collapsed: ['nested'] });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId, ...args });
  await send('snapshot');
  return { api, controller, send, windowId };
}

const activeId = (state) => state.tabs.find((tab) => tab.active)?.id;

test('visible order follows folders and tab trees, excluding collapsed branches and pins', () => {
  const state = {
    groups: [
      { id: 'work', parentId: null },
      { id: 'nested', parentId: 'work' },
    ],
    tabs: [
      { id: 1, groupId: 'work', index: 0, parentTabId: null, collapsed: true },
      { id: 2, groupId: 'work', index: 1, parentTabId: 1 },
      { id: 3, groupId: 'work', index: 2, parentTabId: null },
      { id: 4, groupId: 'nested', index: 3, parentTabId: null },
      { id: 5, groupId: 'work', index: 4, parentTabId: null, pinned: true },
      { id: 6, groupId: 'work', index: 5, parentTabId: 5 },
    ],
    view: { scopeId: 'work', collapsed: [] },
  };
  assert.deepEqual(visibleTabOrder(state), [4, 1, 3, 6]);
  state.view.collapsed = ['nested'];
  state.tabs[0].collapsed = false;
  assert.deepEqual(visibleTabOrder(state), [1, 2, 3, 6]);
});

for (const events of [false, true]) {
  test(`sidebar close selects below, then above (events: ${events})`, async () => {
    const f = await fixture({ events });
    let state = await f.send('closeTab', { id: 3 });
    assert.equal(activeId(state), 4);
    assert.equal(state.view.scopeId, 'work');
    state = await f.send('closeTab', { id: 4 });
    assert.equal(activeId(state), 2);
    state = await f.send('closeTab', { id: 2 });
    assert.equal(activeId(state), 1, 'An empty visible folder keeps the native choice');
    assert.equal(state.view.scopeId, 'work');
    assert(
      state.tabs.some((tab) => tab.id === 5),
      'Collapsed tabs remain untouched',
    );
  });
}

test('preserves Firefox choice within the visible folder even when below is closer', async () => {
  const f = await fixture();
  await f.api.tabs.update(3, { successorTabId: 2 });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 2);
});

test('prefers folder tabs over a native pinned successor', async () => {
  const f = await fixture();
  await f.api.tabs.update(3, { successorTabId: 6 });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 4);
});

test('background, pinned and already hidden closes do not redirect selection', async () => {
  const f = await fixture();
  assert.equal(activeId(await f.send('closeTab', { id: 4 })), 3);
  await f.send('activateTab', { id: 6 });
  assert.equal(activeId(await f.send('closeTab', { id: 6 })), 1);
  assert.equal(activeId(await f.send('closeTab', { id: 1 })), 2);
});

test('uses sidebar order after reordering rather than native tab indices', async () => {
  const f = await fixture();
  await f.send('moveTab', { id: 4, groupId: 'work', beforeId: 2 });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 2);
});

test('closing a tree skips every removed descendant', async () => {
  const f = await fixture();
  await f.send('nestTab', { id: 4, parentTabId: 3 });
  const state = await f.send('closeTabTree', { id: 3, tabIds: [3, 4] });
  assert.equal(activeId(state), 2);
  assert(!state.tabs.some((tab) => [3, 4].includes(tab.id)));
});

test('a native close can select a newly revealed child of a collapsed parent', async () => {
  const f = await fixture();
  await f.send('closeTab', { id: 2 });
  await f.send('closeTab', { id: 4 });
  await f.send('nestTab', { id: 5, parentTabId: 3 });
  await f.send('toggleTab', { id: 3 });
  assert.deepEqual(visibleTabOrder(await f.send('snapshot')), [3]);
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 5);
});

test('native closes use the same fallback in either lifecycle event order', async () => {
  for (const activationFirst of [false, true]) {
    const f = await fixture();
    if (activationFirst) {
      const removed = f.api.tabs.onRemoved.emit;
      const activated = f.api.tabs.onActivated.emit;
      let pending;
      f.api.tabs.onRemoved.emit = (...args) => {
        pending = args;
      };
      f.api.tabs.onActivated.emit = (...args) => {
        activated(...args);
        if (pending) {
          const args = pending;
          pending = null;
          removed(...args);
        }
      };
    }
    await f.api.tabs.remove(3);
    assert.equal(activeId(await f.send('snapshot')), 4);
  }
});

test('a deliberate tab switch followed by closing the old background tab is respected', async () => {
  const f = await fixture();
  await f.api.tabs.update(1, { active: true });
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 1);
});

test('a user activation racing a native close cancels the queued fallback', async () => {
  const f = await fixture();

  const listener = ({ tabId }) => {
    if (tabId === 1) f.api.tabs.update(6, { active: true });
  };

  f.api.tabs.onActivated.addListener(listener);
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 6);
});

test('a later folder navigation cancels a queued native correction', async () => {
  const f = await fixture();
  const navigation = f.send('enterGroup', { id: 'other' });
  await f.api.tabs.remove(3);
  await navigation;
  assert.equal(activeId(await f.send('snapshot')), 1);
});

test('closing a window does not activate a replacement', async () => {
  const f = await fixture();
  const removed = f.api.tabs.onRemoved.emit;
  f.api.tabs.onRemoved.emit = (id, info) => removed(id, { ...info, isWindowClosing: true });
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 1);
});

test('a close in another window changes only that window and does not focus it', async () => {
  const f = await fixture({ windowId: 2 });
  await f.api.tabs.create({ windowId: 1, title: 'Other window', active: true });
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 4);
  assert.equal((await f.api.windows.get(1)).focused, true);
  assert.equal((await f.api.windows.get(2)).focused, false);
});
