import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { moveSource, resolveMove } from '../extension/src/move-plan.js';
import { MOVE_WINDOW_KEY } from '../extension/src/move-windows.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';

const key = 'tabernacle.move-receipts.v1';

async function fixture(t) {
  const api = memoryBrowser({
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, index: 0 },
      { id: 2, windowId: 2, index: 0 },
    ],
  });
  const controller = createController(api);
  t.after(() => controller.dispose());
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  const state = await send('snapshot');
  const source = moveSource(state, 'tab', 1);
  const destination = { kind: 'group', id: 'work' };
  const message = {
    operationId: 'next',
    source,
    destination,
    expected: resolveMove(state, source, destination).expected,
  };
  const receipt = {
    windowId: 1,
    operationId: 'previous',
    source,
    label: 'Moved',
    opaque: { keep: true },
  };
  return { api, send, message, receipt };
}

const invalid = [
  ['null', () => null],
  ['array', () => []],
  ['primitive', () => false],
  ['future envelope', () => ({ futureRecords: { version: 99, token: 'retain' } })],
  ['wrong window', (receipt) => ({ 2: receipt })],
  ['invalid identity', (receipt) => ({ 1: { ...receipt, windowKey: null } })],
  [
    'unsupported source',
    (receipt) => ({ 1: { ...receipt, source: { kind: 'future', id: 'keep' } } }),
  ],
  ['invalid operation', (receipt) => ({ 1: { ...receipt, operationId: '' } })],
];
for (const [name, value] of invalid) {
  test(`unsupported ${name} receipts block moves without overwriting data and allow repair/retry`, async (t) => {
    const f = await fixture(t);
    f.api.testing.saved[key] = value(f.receipt);
    const saved = structuredClone(f.api.testing.saved);
    const memberships = structuredClone(f.api.testing.tabValues);
    await assert.rejects(f.send('moveStatus'), /saved move confirmations.*kept/);
    await assert.rejects(f.send('moveItem', f.message), /saved move confirmations.*kept/);
    assert.deepEqual(f.api.testing.saved, saved);
    assert.deepEqual(f.api.testing.tabValues, memberships);
    assert.equal(await f.api.sessions.getWindowValue(1, MOVE_WINDOW_KEY), undefined);
    f.api.testing.saved[key] = {};
    assert((await f.send('moveItem', f.message)).moveResult.committed);
    assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  });
}
test('valid legacy receipts retain opaque fields when another window saves a move', async (t) => {
  const f = await fixture(t);
  const other = { ...f.receipt, windowId: 2, operationId: 'other' };
  f.api.testing.saved[key] = { 2: other };
  await f.send('moveItem', f.message);
  assert.deepEqual(f.api.testing.saved[key][2], other);
  assert.deepEqual(await f.send('moveStatus', { windowId: 2 }), other);
  assert.equal((await f.send('moveStatus')).operationId, 'next');
});
test('failed receipt reads preserve records and prevent a move until retry', async (t) => {
  const f = await fixture(t);
  f.api.testing.saved[key] = { 1: f.receipt };
  const before = structuredClone(f.api.testing.saved);
  const memberships = structuredClone(f.api.testing.tabValues);
  const get = f.api.storage.local.get;
  f.api.storage.local.get = async (name) => {
    if (name === key) throw new Error('Read unavailable');
    return get(name);
  };
  await assert.rejects(f.send('moveItem', f.message), /Read unavailable/);
  assert.deepEqual(f.api.testing.saved, before);
  assert.deepEqual(f.api.testing.tabValues, memberships);
  f.api.storage.local.get = get;
  assert((await f.send('moveItem', f.message)).moveResult.committed);
});
test('failed receipt writes retain the journal and unsupported records cannot erase it during recovery', async (t) => {
  const f = await fixture(t);
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (Object.hasOwn(value, key)) throw new Error('Receipt write unavailable');
    return set(value);
  };
  await assert.rejects(f.send('moveItem', f.message), /Receipt write unavailable/);
  const pending = structuredClone(f.api.testing.saved[PENDING_MOVE_KEY]);
  assert(pending);
  f.api.storage.local.set = set;
  const unsupported = { futureRecords: { version: 99, token: 'retain' } };
  f.api.testing.saved[key] = structuredClone(unsupported);
  await assert.rejects(f.send('snapshot'), /saved move confirmations.*kept/);
  assert.deepEqual(f.api.testing.saved[key], unsupported);
  assert.deepEqual(f.api.testing.saved[PENDING_MOVE_KEY], pending);
  f.api.testing.saved[key] = {};
  const state = await f.send('moveItem', f.message);
  assert(state.moveResult.committed);
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  assert.equal(state.tabs.find((tab) => tab.id === 1).groupId, 'work');
});
