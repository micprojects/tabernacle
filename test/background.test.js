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
  const api = memoryBrowser();
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
  api.action = { onClicked: event() };
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
    ]) {
      assert.equal(receive(message, sender), undefined);
    }
    assert.equal(
      receive({ type: 'tabernacle:snapshot', windowId: 1 }, { id: 'another-extension' }),
      undefined,
    );
    const success = await receive({ type: 'tabernacle:snapshot', windowId: 1 }, sender);
    assert.equal(success.ok, true);
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
  } finally {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  }
});
