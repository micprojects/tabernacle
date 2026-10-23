import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotEncoder, createSnapshotReader } from '../extension/src/snapshot-transfer.js';

const state = () => ({ generation: 'test', tabs: Array.from({ length: 8 }, (_, id) => ({ id })) });

for (const [name, value] of [
  ['Date', () => new Date(1700000000000)],
  ['Map', () => new Map([['key', { kept: true }]])],
  ['Set', () => new Set(['keep'])],
  ['ArrayBuffer', () => new Uint8Array([1, 2, 3]).buffer],
  ['typed array', () => new Uint16Array([3, 2, 1])],
  [
    'cycle',
    () => {
      const result = {};
      result.self = result;
      return result;
    },
  ],
])
  test(`${name} unknown fields use detached full transfer without retaining a base`, async () => {
    const encoder = createSnapshotEncoder();
    const source = state();
    source.tabs[2].future = value();
    let message;
    const read = createSnapshotReader(async (token) => {
      message = encoder.encode(1, source, token);
      return structuredClone(message);
    });
    assert.deepEqual(await read(), source);
    assert.deepEqual(await read(), source);
    assert.equal(message.baseToken, undefined);
    assert.deepEqual(encoder.stats(), { bases: 0, tabReferences: 0 });
  });

test('plain unknown cloneable primitives, sparse arrays and shared references diff exactly', async () => {
  const encoder = createSnapshotEncoder();
  let source = state();
  source.tabs[0].future = { bigint: 1n, nan: NaN, zero: -0, absent: undefined, holes: Array(2) };
  const shared = { value: true };
  source.tabs[1].future = { left: shared, right: shared };
  source.tabs[4].future = { left: shared, right: shared };
  let message;
  const read = createSnapshotReader(async (token) => {
    message = encoder.encode(1, source, token);
    return structuredClone(message);
  });
  await read();
  await read();
  assert.deepEqual(message.changes, []);
  source = structuredClone(source);
  source.tabs[0].future.zero = 0;
  source.tabs[0].future.holes.length = 3;
  source.tabs[1].future.right = { value: true };
  source.tabs[4].future = { left: shared, right: { value: true } };
  assert.deepEqual(await read(), source);
  assert.deepEqual(
    message.changes.map(({ index }) => index),
    [0, 1, 4],
  );
});

test('deep unknown plain fields compare iteratively without losing a changed leaf', () => {
  const nested = (value) => {
    const root = {};
    let cursor = root;
    for (let depth = 0; depth < 20000; depth++) {
      cursor.child = {};
      cursor = cursor.child;
    }
    cursor.value = value;
    return root;
  };

  const encoder = createSnapshotEncoder();
  const before = state();
  before.tabs[2].future = nested('before');
  const first = encoder.encode(1, before);
  const next = state();
  next.tabs[2].future = nested('after');
  const message = encoder.encode(1, next, first.token);
  assert.equal(message.baseToken, first.token);
  assert.deepEqual(
    message.changes.map(({ index }) => index),
    [2],
  );
  assert.equal(message.changes[0].tab, next.tabs[2]);
});
