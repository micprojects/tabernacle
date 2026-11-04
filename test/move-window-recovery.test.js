import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { moveSource, resolveMove } from '../extension/src/move-plan.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';
import { MOVE_WINDOW_KEY } from '../extension/src/move-windows.js';
import { TAB_KEY, VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

async function fixture() {
  const api = memoryBrowser({
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, windowId: 7, index: 0, pinned: true, active: true },
      { id: 2, windowId: 7, index: 1, pinned: true },
      { id: 3, windowId: 9, index: 0, pinned: true, active: true },
    ],
    memberships: {
      1: { treeId: 'a', groupId: null, ancestors: [], order: 0 },
      2: { treeId: 'b', groupId: null, ancestors: [], order: 1024 },
      3: { treeId: 'other', groupId: null, ancestors: [], order: 0 },
    },
  });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 7, ...args });
  await send('setGroupPin', { id: 'work', action: 'open' });
  await send('snapshot', { windowId: 9 });
  const state = await send('snapshot');
  return { api, controller, send, state };
}

async function interrupt(f, kind = 'unpin') {
  const source = moveSource(
    f.state,
    kind === 'folder' ? 'pin-group' : 'tab',
    kind === 'folder' ? 'work' : 1,
  );
  const destination =
    kind === 'unpin'
      ? { kind: 'group', id: 'work' }
      : { kind: 'pins', before: { kind: 'tab', id: 'a' } };
  const message = {
    operationId: 'interrupted-move',
    source,
    destination,
    expected: resolveMove(f.state, source, destination).expected,
  };
  const set = f.api.storage.local.set;
  let reached;
  const pending = new Promise((resolve) => {
    reached = resolve;
  });
  f.api.storage.local.set = async (value) => {
    await set(value);
    if (!value[PENDING_MOVE_KEY]) return;
    reached();
    return new Promise(() => {});
  };
  void f.send('moveItem', message).catch(() => {});
  await pending;
  f.api.storage.local.set = set;
  f.controller.dispose();
  return message;
}

async function restore(api) {
  // Firefox may reuse an old ID for another window, and reassign every tab ID.
  const remap = (id) => (id === 7 ? 24 : id === 9 ? 7 : id);
  const tabs = await api.tabs.query({});
  const next = memoryBrowser({
    tabs: tabs.map((tab) => ({ ...tab, id: tab.id + 100, windowId: remap(tab.windowId) })),
    memberships: Object.fromEntries(
      await Promise.all(
        tabs.map(async (tab) => [tab.id + 100, await api.sessions.getTabValue(tab.id, TAB_KEY)]),
      ),
    ),
  });
  Object.assign(next.testing.saved, structuredClone(api.testing.saved));
  for (const window of await api.windows.getAll())
    for (const key of [VIEW_KEY, MOVE_WINDOW_KEY]) {
      const value = await api.sessions.getWindowValue(window.id, key);
      if (value !== undefined) await next.sessions.setWindowValue(remap(window.id), key, value);
    }
  const controller = createController(next);
  return {
    api: next,
    controller,
    send: (type, args = {}) => controller.request({ type, windowId: 24, ...args }),
  };
}

test('interrupted pin moves follow restored windows and retain retry receipts', async () => {
  const f = await fixture();
  const other = structuredClone(f.api.testing.windowValues.get(9));
  const message = await interrupt(f);
  const restored = await restore(f.api);
  const state = await restored.send('snapshot');
  assert.equal(state.tabs.find((tab) => tab.treeId === 'a').pinned, false);
  assert.equal(state.tabs.find((tab) => tab.treeId === 'a').groupId, 'work');
  assert.equal(restored.api.testing.saved[PENDING_MOVE_KEY], null);
  assert.deepEqual(restored.api.testing.windowValues.get(7), other);
  assert.equal((await restored.api.tabs.get(103)).pinned, true);
  const receipt = await restored.send('moveStatus');
  assert.equal(receipt.operationId, message.operationId);
  assert.equal(receipt.windowId, 24);
  assert.equal(await restored.send('moveStatus', { windowId: 7 }), null);
  await restored.send('moveTab', { id: 101, groupId: null });
  const retried = await restored.send('moveItem', message);
  assert.equal(retried.tabs.find((tab) => tab.treeId === 'a').groupId, null);
  assert(retried.moveResult.committed);
  restored.controller.dispose();
});

test('interrupted folder pin layouts use the restored window, without a source tab', async () => {
  const f = await fixture();
  const other = structuredClone(f.api.testing.windowValues.get(9));
  await interrupt(f, 'folder');
  const restored = await restore(f.api);
  const state = await restored.send('snapshot');
  assert.deepEqual(
    state.pins.map((pin) => pin.id),
    ['work', 'a', 'b'],
  );
  assert.deepEqual(restored.api.testing.windowValues.get(7), other);
  assert.equal(restored.api.testing.saved[PENDING_MOVE_KEY], null);
  restored.controller.dispose();
});

test('a rollback uses restored window identities and preserves unrelated fields', async () => {
  const f = await fixture();
  await interrupt(f);
  const journal = f.api.testing.saved[PENDING_MOVE_KEY];
  journal.direction = 'before';
  for (const change of journal.changes)
    f.api.testing.tabValues.set(1, { ...change.after, future: { retained: true } });
  await f.api.tabs.update(1, { pinned: false });
  const restored = await restore(f.api);
  const state = await restored.send('snapshot');
  const tab = state.tabs.find((tab) => tab.treeId === 'a');
  assert.equal(tab.pinned, true);
  assert.equal(tab.groupId, null);
  assert.deepEqual(restored.api.testing.tabValues.get(101).future, { retained: true });
  assert.equal(await restored.send('moveStatus'), null);
  assert.equal(restored.api.testing.saved[PENDING_MOVE_KEY], null);
  restored.controller.dispose();
});

for (const failure of ['read', 'write']) {
  test(`failed window identity ${failure}s preserve organisation and allow retry`, async () => {
    const f = await fixture();
    const method = failure === 'read' ? 'getWindowValue' : 'setWindowValue';
    const original = f.api.sessions[method];
    f.api.sessions[method] = async (...args) => {
      if (args[1] === MOVE_WINDOW_KEY) throw new Error('Identity unavailable');
      return original(...args);
    };
    const source = moveSource(f.state, 'tab', 1);
    const destination = { kind: 'group', id: 'work' };
    const message = {
      operationId: 'retry',
      source,
      destination,
      expected: resolveMove(f.state, source, destination).expected,
    };
    const before = structuredClone(f.api.testing.saved);
    await assert.rejects(f.send('moveItem', message), /Identity unavailable/);
    assert.deepEqual(f.api.testing.saved, before);
    assert.equal((await f.api.tabs.get(1)).pinned, true);
    f.api.sessions[method] = original;
    assert((await f.send('moveItem', message)).moveResult.committed);
    f.controller.dispose();
  });
}

test('a tab genuinely moved to another window still blocks pin recovery', async () => {
  const f = await fixture();
  await interrupt(f);
  const restored = await restore(f.api);
  await restored.api.testing.attach(101, 7);
  const journal = structuredClone(restored.api.testing.saved[PENDING_MOVE_KEY]);
  await assert.rejects(restored.send('snapshot'), /moving tab changed windows/);
  assert.equal((await restored.api.tabs.get(101)).pinned, true);
  assert.deepEqual(restored.api.testing.saved[PENDING_MOVE_KEY], journal);
  await restored.api.testing.attach(101, 24);
  assert.equal(
    (await restored.send('snapshot')).tabs.find((tab) => tab.treeId === 'a').pinned,
    false,
  );
  restored.controller.dispose();
});

for (const failure of ['missing', 'duplicate', 'read']) {
  test(`${failure} restored window identities preserve the journal before recovery writes`, async () => {
    const f = await fixture();
    await interrupt(f);
    const restored = await restore(f.api);
    const key = await restored.api.sessions.getWindowValue(24, MOVE_WINDOW_KEY);
    const read = restored.api.sessions.getWindowValue;
    if (failure === 'duplicate')
      await restored.api.sessions.setWindowValue(7, MOVE_WINDOW_KEY, key);
    else
      restored.api.sessions.getWindowValue = async (id, name) => {
        if (name === MOVE_WINDOW_KEY) {
          if (failure === 'read') throw new Error('Read unavailable');
          return undefined;
        }
        return read(id, name);
      };
    const saved = structuredClone(restored.api.testing.saved);
    const memberships = structuredClone(restored.api.testing.tabValues);
    await assert.rejects(restored.send('snapshot'), /unavailable|duplicated window/);
    assert.deepEqual(restored.api.testing.saved, saved);
    assert.deepEqual(restored.api.testing.tabValues, memberships);
    restored.controller.dispose();
  });
}

test('a lost identity write reply reuses the saved identity on retry', async () => {
  const f = await fixture();
  const write = f.api.sessions.setWindowValue;
  let key;
  f.api.sessions.setWindowValue = async (id, name, value) => {
    await write(id, name, value);
    if (name === MOVE_WINDOW_KEY) {
      key = value;
      throw new Error('Reply lost');
    }
  };
  const source = moveSource(f.state, 'tab', 1);
  const destination = { kind: 'group', id: 'work' };
  const message = {
    operationId: 'retry-key',
    source,
    destination,
    expected: resolveMove(f.state, source, destination).expected,
  };
  await assert.rejects(f.send('moveItem', message), /Reply lost/);
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], undefined);
  f.api.sessions.setWindowValue = write;
  assert((await f.send('moveItem', message)).moveResult.committed);
  assert.equal(await f.api.sessions.getWindowValue(7, MOVE_WINDOW_KEY), key);
  f.controller.dispose();
});

test('unsupported saved identities and mismatched journal identities are not overwritten', async () => {
  const f = await fixture();
  await interrupt(f);
  const key = await f.api.sessions.getWindowValue(7, MOVE_WINDOW_KEY);
  await f.api.sessions.setWindowValue(7, MOVE_WINDOW_KEY, { future: key });
  let controller = createController(f.api);
  const saved = structuredClone(f.api.testing.saved);
  await assert.rejects(
    controller.request({ type: 'snapshot', windowId: 7 }),
    /identity is invalid/,
  );
  assert.deepEqual(f.api.testing.saved, saved);
  assert.deepEqual(await f.api.sessions.getWindowValue(7, MOVE_WINDOW_KEY), { future: key });
  controller.dispose();
  await f.api.sessions.setWindowValue(7, MOVE_WINDOW_KEY, key);
  f.api.testing.saved[PENDING_MOVE_KEY].effects.windowKey = 'another-window';
  controller = createController(f.api);
  const invalid = structuredClone(f.api.testing.saved);
  await assert.rejects(
    controller.request({ type: 'snapshot', windowId: 7 }),
    /pending move could not be read/,
  );
  assert.deepEqual(f.api.testing.saved, invalid);
  controller.dispose();
});

test('legacy version 2 journals and receipts still recover without adding window metadata', async () => {
  const f = await fixture();
  const message = await interrupt(f);
  const journal = f.api.testing.saved[PENDING_MOVE_KEY];
  delete journal.receipt.windowKey;
  delete journal.effects.windowKey;
  const read = f.api.sessions.getWindowValue;
  f.api.sessions.getWindowValue = (id, key) =>
    key === MOVE_WINDOW_KEY ? undefined : read(id, key);
  const write = f.api.sessions.setWindowValue;
  f.api.sessions.setWindowValue = async (...args) => {
    if (args[1] === MOVE_WINDOW_KEY) throw new Error('Unexpected identity migration');
    return write(...args);
  };
  const controller = createController(f.api);
  const state = await controller.request({ type: 'snapshot', windowId: 7 });
  assert.equal(state.tabs.find((tab) => tab.treeId === 'a').pinned, false);
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  assert.equal(
    (await controller.request({ type: 'moveStatus', windowId: 7 })).operationId,
    message.operationId,
  );
  controller.dispose();
});

test('completed receipts follow restored windows when another window saves a move', async () => {
  const f = await fixture();
  const source = moveSource(f.state, 'tab', 1);
  const destination = { kind: 'group', id: 'work' };
  const message = {
    operationId: 'completed-before-restart',
    source,
    destination,
    expected: resolveMove(f.state, source, destination).expected,
  };
  await f.send('moveItem', message);
  f.controller.dispose();
  const restored = await restore(f.api);
  const other = await restored.send('snapshot', { windowId: 7 });
  const otherSource = moveSource(other, 'tab', 103);
  await restored.send('moveItem', {
    windowId: 7,
    operationId: 'other-window',
    source: otherSource,
    destination,
    expected: resolveMove(other, otherSource, destination).expected,
  });
  assert.equal((await restored.send('moveStatus')).operationId, message.operationId);
  assert.equal((await restored.send('moveStatus', { windowId: 7 })).operationId, 'other-window');
  restored.controller.dispose();
});
