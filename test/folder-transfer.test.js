import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotEncoder, createSnapshotReader } from '../extension/src/snapshot-transfer.js';
import { immutableCopy } from '../extension/src/presentation-cache.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY } from '../extension/src/model.js';

const fixture = (tabs = 8) => ({
  generation: 'background',
  revision: 1,
  groups: immutableCopy([{ id: 'folder', name: 'Folder', parentId: null, opaque: { keep: true } }]),
  view: { scopeId: null, collapsed: [] },
  tabs: Array.from({ length: tabs }, (_, id) => ({ id, title: `Tab ${id}` })),
});

for (const count of [0, 8]) {
  test(`folder versions reuse unchanged records with ${count} tabs and preserve older states`, async () => {
    const encoder = createSnapshotEncoder();
    let state = fixture(count),
      wire;
    const read = createSnapshotReader(async (token) => {
      wire = structuredClone(encoder.encode(1, state, token, 3));
      return wire;
    });
    const first = await read();
    const token = read.details(first).groupsToken;
    assert.equal(typeof token, 'string');
    const next = await read();
    assert.equal(next.groups, first.groups);
    assert.equal(Object.hasOwn(wire.state, 'groups'), false);
    assert.deepEqual(next, state);
    state = { ...state, groups: immutableCopy([{ ...state.groups[0], name: 'Renamed' }]) };
    const renamed = await read();
    assert.notEqual(read.details(renamed).groupsToken, token);
    assert.notEqual(renamed.groups, first.groups);
    assert.equal(first.groups[0].name, 'Folder');
    assert.deepEqual(renamed.groups[0].opaque, { keep: true });
    read.clear();
    assert.deepEqual(await read(), state);
    assert(Array.isArray(wire.state.groups));
  });
}

test('borrowed or shallow-frozen folders never receive identity versions', async () => {
  const encoder = createSnapshotEncoder();
  for (const frozen of [false, true]) {
    const state = fixture();
    state.groups = structuredClone(state.groups);
    if (frozen) Object.freeze(state.groups);
    const first = encoder.encode(1, state, undefined, 3);
    assert.equal(first.groupsToken, undefined);
    state.groups[0].name = 'Mutable child';
    const next = encoder.encode(1, state, first.token, 3);
    assert.equal(next.groupsToken, undefined);
    assert.equal(next.state.groups[0].name, 'Mutable child');
  }
});

test('legacy protocols keep complete folders when switching from version 3', () => {
  const encoder = createSnapshotEncoder();
  const state = fixture();
  for (const version of [1, 2]) {
    const first = encoder.encode(1, state, undefined, 3);
    const legacy = encoder.encode(1, state, first.token, version);
    assert.deepEqual(legacy.state.groups, state.groups);
    assert.equal(legacy.groupsToken, undefined);
    const modern = encoder.encode(1, state, legacy.token, 3);
    assert.deepEqual(modern.state.groups, state.groups);
  }
});

for (const damage of [
  'missing-token',
  'wrong-token',
  'missing-base',
  'wrong-generation',
  'invalid-groups',
]) {
  test(`invalid folder reference (${damage}) recovers without replaying its action`, async () => {
    const encoder = createSnapshotEncoder();
    const state = fixture();
    let reads = 0,
      actions = 0;
    const read = createSnapshotReader(async (token) => {
      reads++;
      return structuredClone(encoder.encode(1, state, token, 3));
    });
    await read();
    const result = await read.perform(async (token) => {
      actions++;
      const wire = structuredClone(
        encoder.encode(1, { ...state, moveResult: { committed: true } }, token, 3),
      );
      if (damage === 'missing-token') delete wire.groupsToken;
      if (damage === 'wrong-token') wire.groupsToken = 'wrong';
      if (damage === 'missing-base') delete wire.baseToken;
      if (damage === 'wrong-generation') wire.state.generation = 'wrong';
      if (damage === 'invalid-groups') wire.state.groups = null;
      return wire;
    });
    assert.equal(reads, 2);
    assert.equal(actions, 1);
    assert.deepEqual(result, { ...state, moveResult: { committed: true } });
  });
}

test('late folder replies retain their own version and cannot replace a newer reader base', async () => {
  const encoder = createSnapshotEncoder();
  let state = fixture(),
    release,
    held = false;
  const read = createSnapshotReader(async (token) => {
    const wire = structuredClone(encoder.encode(1, state, token, 3));
    if (held) {
      held = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return wire;
  });
  const first = await read();
  held = true;
  const pending = read();
  state = { ...state, groups: immutableCopy([{ ...state.groups[0], name: 'Latest' }]) };
  const latest = await read();
  release();
  assert.equal((await pending).groups, first.groups);
  assert.equal((await read()).groups, latest.groups);
});

test('folder versions follow committed edits across windows, failed writes and background restart', async () => {
  const api = memoryBrowser({
    groups: fixture().groups,
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'One' },
      { id: 2, windowId: 2, index: 0, title: 'Two' },
    ],
  });
  let controller = createController(api),
    encoder = createSnapshotEncoder();
  const readers = [1, 2].map((windowId) =>
    createSnapshotReader(async (token) =>
      structuredClone(
        encoder.encode(
          windowId,
          await controller.requestForTransport({ type: 'snapshot', windowId }),
          token,
          3,
        ),
      ),
    ),
  );
  try {
    const first = await Promise.all(readers.map((read) => read()));
    assert.equal(
      readers[0].details(first[0]).groupsToken,
      readers[1].details(first[1]).groupsToken,
    );
    const save = api.storage.local.set;
    api.storage.local.set = async (value) => {
      if (Object.hasOwn(value, MODEL_KEY)) throw new Error('Write failed');
      return save(value);
    };
    await assert.rejects(
      controller.request({ type: 'renameGroup', windowId: 1, id: 'folder', name: 'Rejected' }),
      /Write failed/,
    );
    assert.equal((await readers[0]()).groups, first[0].groups);
    api.storage.local.set = save;
    await controller.request({ type: 'renameGroup', windowId: 1, id: 'folder', name: 'Committed' });
    const changed = await Promise.all(readers.map((read) => read()));
    for (const result of changed) {
      assert.equal(result.groups[0].name, 'Committed');
      assert.deepEqual(result.groups[0].opaque, { keep: true });
    }
    assert.equal(first[0].groups[0].name, 'Folder');
    await controller.dispose();
    controller = createController(api);
    encoder = createSnapshotEncoder();
    assert.deepEqual((await readers[1]()).groups, changed[1].groups);
  } finally {
    await controller.dispose();
  }
});
