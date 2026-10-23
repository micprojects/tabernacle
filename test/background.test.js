import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';

test('background validates messages and forwards container and session lifecycle events', async () => {
  const event = () => ({
    listeners: [],

    addListener(fn) {
      this.listeners.push(fn);
    },
  });
  const api = memoryBrowser({
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'One', url: 'https://example.com/one' },
      { id: 2, windowId: 1, index: 1, title: 'Two', url: 'https://example.com/two' },
    ],
    memberships: {
      1: { treeId: 'one', order: 0, ancestors: [] },
      2: { treeId: 'two', order: 1, ancestors: [] },
    },
  });
  api.sessions.onChanged = event();
  const messages = [];
  api.runtime = {
    id: 'tabernacle-background-test',
    onMessage: event(),

    sendMessage: async (message) => {
      messages.push(message);
    },
  };
  for (const name of [
    'onCreated',
    'onUpdated',
    'onRemoved',
    'onActivated',
    'onMoved',
    'onAttached',
    'onDetached',
  ])
    api.tabs[name] = event();
  for (const name of ['onCreated', 'onUpdated', 'onRemoved'])
    api.contextualIdentities[name] = event();
  api.action = {
    onClicked: event(),

    setIcon: async () => {},
  };
  api.sidebarAction = { setIcon: async () => {} };
  for (const name of ['onCreated', 'onRemoved']) api.windows[name] = event();
  const previous = globalThis.browser;
  globalThis.browser = api;
  try {
    await import('../extension/src/background.js');
    const receive = api.runtime.onMessage.listeners[0];
    const sender = { id: api.runtime.id };
    for (const message of [
      null,
      {},
      { type: 42 },
      { type: 'other' },
      { type: 'tabernacle:changed' },
      { type: 'tabernacle:getCloseFilter', windowId: 1 },
    ]) {
      assert.equal(receive(message, sender), undefined);
    }
    assert.equal(
      receive({ type: 'tabernacle:snapshot', windowId: 1 }, { id: 'another-extension' }),
      undefined,
    );
    const success = await receive({ type: 'tabernacle:snapshot', windowId: 1 }, sender);
    assert.equal(success.ok, true);
    assert.equal(
      Object.hasOwn(success.data, 'token'),
      false,
      'legacy callers receive a full snapshot',
    );
    assert(Array.isArray(success.data.tabs));
    assert(Array.isArray(success.data.groups));
    assert(success.data.view);
    // runtime messaging clones the response before it reaches the receiving page.
    const wire = structuredClone(success);
    wire.data.tabs[0].title = 'Receiver mutation';
    wire.data.view.collapsed.push('Receiver folder');
    assert.deepEqual(
      structuredClone(await receive({ type: 'tabernacle:snapshot', windowId: 1 }, sender)),
      structuredClone(success),
    );
    const incremental = await receive(
      { type: 'tabernacle:snapshot', windowId: 1, incremental: true },
      sender,
    );
    assert.equal(typeof incremental.data.token, 'string');
    assert.deepEqual(structuredClone(incremental.data.state), structuredClone(success.data));
    const unchanged = await receive(
      {
        type: 'tabernacle:snapshot',
        windowId: 1,
        incremental: true,
        snapshotToken: incremental.data.token,
      },
      sender,
    );
    assert.equal(unchanged.data.baseToken, incremental.data.token);
    assert.deepEqual(unchanged.data.changes, []);
    for (const type of ['tabernacle:snapshot', 'tabernacle:getNewTabState']) {
      const full = await receive({ type, windowId: 1 }, sender);
      assert.equal(full.ok, true);
      assert.equal(full.data.token, undefined);
      assert(Array.isArray(full.data.tabs));
      const initial = await receive({ type, windowId: 1, incremental: true }, sender);
      assert.deepEqual(initial.data.state, full.data);
      const delta = await receive(
        { type, windowId: 1, incremental: true, snapshotToken: initial.data.token },
        sender,
      );
      assert.equal(delta.data.baseToken, initial.data.token);
      assert.deepEqual(delta.data.changes, []);
      assert.deepEqual({ ...delta.data.state, tabs: full.data.tabs }, full.data);
      if (type === 'tabernacle:getNewTabState') {
        assert.deepEqual(delta.data.state.newTab, full.data.newTab);
        assert(full.data.newTab.links);
      }
    }
    const generation = success.data.generation;
    assert.equal(typeof generation, 'string');
    const failure = await receive({ type: 'tabernacle:unknown', windowId: 1 }, sender);
    assert.deepEqual(failure, { ok: false, error: 'Unknown Tabernacle action.' });
    for (const name of ['onCreated', 'onUpdated', 'onRemoved']) {
      const listeners = api.contextualIdentities[name].listeners;
      assert.equal(listeners.length, 1);
      listeners[0]({ contextualIdentity: { cookieStoreId: 'firefox-container-1' } });
    }
    assert.equal(api.sessions.onChanged.listeners.length, 1);
    api.sessions.onChanged.listeners[0]();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(messages, [
      { type: 'tabernacle:changed', windowIds: null, revision: 4, generation },
    ]);
    messages.length = 0;
    api.tabs.onUpdated.listeners[0](1, { status: 'loading' }, { windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(messages.length, 0);
    api.tabs.onUpdated.listeners[0](1, { title: 'New title' }, { windowId: 1 });
    api.tabs.onActivated.listeners[0]({ windowId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(messages, [
      { type: 'tabernacle:changed', windowIds: [1, 2], revision: 6, generation },
    ]);
    const actionBase = await receive(
      { type: 'tabernacle:snapshot', windowId: 1, incremental: true },
      sender,
    );
    const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const action = await receive(
      {
        type: 'tabernacle:createGroup',
        windowId: 1,
        id: groupId,
        name: 'Transport folder',
        incremental: 2,
        snapshotToken: actionBase.data.token,
      },
      sender,
    );
    assert.equal(action.data.snapshotProtocol, 2);
    assert.equal(action.data.baseToken, actionBase.data.token);
    assert.equal(action.data.state.createdGroupId, groupId);
    for (const incremental of [undefined, true, 1, 99]) {
      const legacy = await receive(
        { type: 'tabernacle:enterGroup', windowId: 1, id: null, incremental },
        sender,
      );
      assert(Array.isArray(legacy.data.tabs));
      assert.equal(legacy.data.token, undefined);
    }
    const settings = await receive(
      { type: 'tabernacle:getSettings', windowId: 1, incremental: 2 },
      sender,
    );
    assert(settings.data.look);
    assert.equal(settings.data.token, undefined);
    const failedAction = await receive(
      { type: 'tabernacle:muteTab', windowId: 1, id: -1, incremental: 2 },
      sender,
    );
    assert.equal(failedAction.ok, false);
    assert.equal(typeof failedAction.error, 'string');
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  }
});
