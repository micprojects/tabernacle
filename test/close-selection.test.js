import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import {
  closeFallback,
  createCloseSelection,
  visibleTabOrder,
} from '../extension/src/close-selection.js';
import { VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';
import { captureTarget } from '../extension/src/tab-collection.js';

async function fixture({ events = true, windowId = 1, readCloseFilter } = {}) {
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
  const controller = createController(api, undefined, { readCloseFilter });
  const send = (type, args = {}) => controller.request({ type, windowId, ...args });
  await send('snapshot');
  return { api, controller, send, windowId };
}

const activeId = (state) => state.tabs.find((tab) => tab.active)?.id;

for (const events of [false, true]) {
  test(`reviewed closes retain filtered selection after earlier inactive removals (events: ${events})`, async (t) => {
    const f = await filteredFixture({ events });
    t.after(() => f.controller.dispose());
    await f.api.tabs.update(3, { successorTabId: 1 });
    const before = await f.send('snapshot');
    const after = await f.send('closeTabSet', {
      scope: { kind: 'window' },
      targets: [2, 3].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id))),
    });
    assert.deepEqual(after.batchResult.completed, [2, 3]);
    assert.equal(activeId(after), 5, 'The nested match is now the nearest result above');
    assert.equal(after.view.scopeId, 'work');
    assert.deepEqual(after.view.collapsed, ['nested']);
  });
}

test('a target activated between reviewed removals gets the active-close fallback', async (t) => {
  const f = await filteredFixture();
  t.after(() => f.controller.dispose());
  await f.api.tabs.update(4, { successorTabId: 1 });
  const before = await f.send('snapshot');
  const remove = f.api.tabs.remove;
  f.api.tabs.remove = async (id) => {
    await remove(id);
    if (id === 2) await f.api.tabs.update(4, { active: true });
  };
  const after = await f.send('closeTabSet', {
    scope: { kind: 'window' },
    targets: [2, 4].map((id) => captureTarget(before.tabs.find((tab) => tab.id === id))),
  });
  assert.deepEqual(after.batchResult.completed, [2, 4]);
  assert.equal(activeId(after), 3);
});

function retains(root, target, seen = new Set()) {
  if (root === target) return true;
  if (!root || typeof root !== 'object' || seen.has(root)) return false;
  seen.add(root);
  return Object.values(root).some((value) => retains(value, target, seen));
}

function observedSelection(t, correct) {
  const api = memoryBrowser({ events: true });
  const selection = createCloseSelection(api, correct);
  t.after(() => selection.dispose());
  const before = {
    groups: [],
    view: { scopeId: null, collapsed: [] },
    tabs: [{ id: 1, active: true }, { id: 2 }, { id: 3 }],
  };
  // Observe the retained entry without adding a production inspection API.
  let entry;
  const set = Map.prototype.set;
  const observe = t.mock.method(Map.prototype, 'set', function (key, value) {
    if (value?.state === before) entry = value;
    return set.call(this, key, value);
  });
  try {
    selection.remember(1, before);
  } finally {
    observe.mock.restore();
  }
  assert(entry);
  return { api, selection, before, entry };
}

test('a deliberate activation does not retain an obsolete close snapshot', (t) => {
  let corrections = 0;
  const f = observedSelection(t, async () => corrections++);
  const current = f.selection.guard(1, [1]);
  f.api.tabs.onActivated.emit({ windowId: 1, tabId: 2, previousTabId: 1 });
  f.selection.remember(1, { ...f.before, tabs: [{ id: 2, active: true }] });
  assert.equal(retains(f.entry, f.before), false);
  assert.equal(retains(f.entry, f.before.tabs), false);
  assert.equal(current(), false);
  f.api.tabs.onRemoved.emit(1, { windowId: 1 });
  assert.equal(corrections, 0, 'Closing the old background tab cannot redirect selection');
});

for (const activationFirst of [false, true]) {
  test(`paired close releases its old snapshot while correction remains valid (activation first: ${activationFirst})`, async (t) => {
    const calls = [];
    let release;
    let completedBefore;
    const pending = new Promise((resolve) => (release = resolve));
    const f = observedSelection(t, async (windowId, before, closedId, current) => {
      calls.push({ windowId, before, closedId, current });
      await pending;
      completedBefore = before;
    });
    const activate = () => f.api.tabs.onActivated.emit({ windowId: 1, tabId: 2 });
    const remove = () => f.api.tabs.onRemoved.emit(1, { windowId: 1 });
    const managedCurrent = f.selection.guard(1, [1]);
    (activationFirst ? activate : remove)();
    const after = { ...f.before, tabs: [{ id: 2, active: true }, { id: 3 }] };
    f.selection.remember(1, after);
    assert(retains(f.entry, f.before), 'The unpaired event still needs the pre-close state');
    assert.equal(calls.length, 0);
    (activationFirst ? remove : activate)();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].windowId, 1);
    assert.equal(calls[0].closedId, 1);
    assert.equal(calls[0].before, f.before);
    assert.equal(calls[0].current(), true);
    assert.equal(managedCurrent(), true);
    assert.equal(retains(f.entry, f.before), false);
    assert.equal(retains(f.entry, f.before.tabs), false);
    f.selection.remember(1, { ...after, tabs: [...after.tabs] });
    assert.equal(retains(f.entry, after), false, 'An intermediate refresh is released too');
    assert.equal(retains(f.entry, after.tabs), false);
    remove();
    assert.equal(calls.length, 1, 'The consumed transition cannot schedule twice');
    f.api.tabs.onActivated.emit({ windowId: 1, tabId: 3, previousTabId: 2 });
    assert.equal(calls[0].current(), false);
    assert.equal(managedCurrent(), false);
    release();
    await pending;
    assert.equal(completedBefore, f.before, 'Queued work keeps its own pre-close state');
  });
}

test('filtered close follows the selected sort, preserving pre-close viewed order', () => {
  const before = {
    groups: [],
    view: { scopeId: null, collapsed: [] },
    tabs: [
      { id: 1, title: 'Z', openedAt: 100, lastAccessed: 100 },
      { id: 2, title: 'A', openedAt: 400, lastAccessed: 200 },
      { id: 3, title: 'B', openedAt: 200, lastAccessed: 400, active: true },
      { id: 4, title: 'C', openedAt: 300, lastAccessed: 300 },
      { id: 5, url: 'https://outside.test' },
    ].map((tab, index) => ({
      url: 'https://youtube.com',
      index,
      groupId: null,
      parentTabId: null,
      ...tab,
    })),
  };
  const after = {
    ...before,
    tabs: before.tabs
      .filter((tab) => tab.id !== 3)
      .map((tab) => ({
        ...tab,
        active: tab.id === 5,
        lastAccessed: tab.id === 5 ? 500 : tab.lastAccessed,
      })),
  };
  for (const [sort, expected] of [
    ['newest', 4],
    ['oldest', 1],
    ['viewed', 4],
    ['title', 2],
    ['tree', 2],
  ]) {
    assert.equal(closeFallback(before, after, 3, { domain: 'youtube.com', sort }), expected, sort);
  }
});

async function filteredFixture(options = {}) {
  const f = await fixture({
    readCloseFilter: () => ({ domain: 'youtube.com', query: '' }),
    ...options,
  });
  for (const id of [2, 3, 4, 5, 6])
    await f.api.tabs.update(id, { url: `https://youtube.com/watch?v=${id}` });
  await f.send('snapshot');
  return f;
}

for (const events of [false, true]) {
  test(`filtered close prefers above, then below, including pins and collapsed folders (events: ${events})`, async () => {
    const f = await filteredFixture({ events });
    const state = await f.send('closeTab', { id: 3 });
    assert.equal(activeId(state), 2);
    assert.deepEqual(state.view.collapsed, ['nested']);
    assert.equal(state.view.scopeId, 'work');
    await f.send('activateTab', { id: 6, expandAncestors: false });
    assert.equal(
      activeId(await f.send('closeTab', { id: 6 })),
      5,
      'First result falls forward into a collapsed folder',
    );
  });
}

test('filtered close keeps a visible native successor and ignores background closes', async () => {
  const f = await filteredFixture();
  await f.api.tabs.update(3, { successorTabId: 4 });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 4);
  await f.send('activateTab', { id: 1 });
  assert.equal(activeId(await f.send('closeTab', { id: 2 })), 1);
});

test('filtered close respects extra search text and leaves the native choice when no matches remain', async () => {
  const f = await filteredFixture({
    readCloseFilter: () => ({ domain: 'youtube.com', query: 'keep' }),
  });
  await f.api.tabs.update(3, { title: 'Keep this', successorTabId: 2 });
  await f.api.tabs.update(4, { title: 'Keep next', successorTabId: 2 });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 4);
  assert.equal(activeId(await f.send('closeTab', { id: 4 })), 2);
});

test('filtered native closes use above-first fallback in either event order', async () => {
  for (const activationFirst of [false, true]) {
    const f = await filteredFixture();
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
          const saved = pending;
          pending = null;
          removed(...saved);
        }
      };
    }
    await f.api.tabs.remove(3);
    assert.equal(activeId(await f.send('snapshot')), 2);
  }
});

test('filtered fallback rechecks fresh tabs and does not interrupt a deliberate activation during lookup', async () => {
  let release;
  let queried;
  const started = new Promise((resolve) => {
    queried = resolve;
  });
  const f = await filteredFixture({
    readCloseFilter: () =>
      new Promise((resolve) => {
        release = () => resolve({ domain: 'youtube.com', query: '' });
        queried();
      }),
  });
  const close = f.send('closeTab', { id: 3 });
  await started;
  await f.api.tabs.update(6, { active: true });
  release();
  assert.equal(activeId(await close), 6);
});

test('missing sidebars and cleared domain filters use the existing folder fallback', async () => {
  for (const readCloseFilter of [
    () => null,
    () => {
      throw new Error('No receiver');
    },
  ]) {
    const f = await filteredFixture({ readCloseFilter });
    assert.equal(activeId(await f.send('closeTab', { id: 3 })), 4);
  }
});

test('a result navigating away during sidebar lookup is excluded from the fallback', async () => {
  const f = await filteredFixture({
    readCloseFilter: async () => {
      await f.api.tabs.update(2, { url: 'https://example.com' });
      return { domain: 'youtube.com', query: '' };
    },
  });
  assert.equal(activeId(await f.send('closeTab', { id: 3 })), 5);
});

test('native lookup uses only the closing window and ignores stale tabs no longer matching', async () => {
  const f = await filteredFixture({ windowId: 2, readCloseFilter: undefined });
  f.api.runtime = {
    sendMessage: async (message) => {
      assert.deepEqual(message, { type: 'tabernacle:getCloseFilter', windowId: 2 });
      return { domain: 'youtube.com', query: '' };
    },
  };
  await f.api.tabs.update(2, { url: 'https://example.com' });
  await f.send('snapshot');
  await f.api.tabs.remove(3);
  assert.equal(activeId(await f.send('snapshot')), 5);
  assert.equal((await f.api.windows.get(1)).focused, true);
});

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
