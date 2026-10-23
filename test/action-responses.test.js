import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { moveSource, resolveMove } from '../extension/src/move-plan.js';
import { createSnapshotEncoder, createSnapshotReader } from '../extension/src/snapshot-transfer.js';

const snapshot = () => ({
  generation: 'background',
  revision: 1,
  groups: [],
  view: { scopeId: null, collapsed: [] },
  opaque: { retained: ['value'] },
  tabs: Array.from({ length: 10 }, (_, id) => ({
    id,
    title: `Tab ${id}`,
    mutedInfo: { muted: false },
    opaque: { id },
  })),
});

function fixture() {
  let state = snapshot(),
    encoder = createSnapshotEncoder();
  const reads = [],
    actions = [],
    replies = [];
  const read = createSnapshotReader(async (token) => {
    reads.push(token);
    const wire = structuredClone(encoder.encode(1, state, token));
    replies.push(wire);
    return wire;
  });
  return {
    read,
    reads,
    actions,
    replies,
    state: () => state,
    retention: () => encoder.stats(),

    set: (value) => {
      state = value;
    },

    restart: () => {
      encoder = createSnapshotEncoder();
      state = { ...state, generation: 'restarted' };
    },

    action: async (token, extra = {}) => {
      actions.push(token);
      state = structuredClone(state);
      state.revision++;
      state.tabs[2].mutedInfo.muted = !state.tabs[2].mutedInfo.muted;
      return structuredClone(encoder.encode(1, { ...state, ...extra }, token, 2));
    },
  };
}

test('action deltas share the reader base and retain opaque fields, receipts and independent arrays', async () => {
  const f = fixture();
  const before = await f.read();
  let wire;
  const receipt = { operationId: 'operation', committed: true, revealError: 'Reveal unavailable' };
  const result = await f.read.perform(
    async (token) =>
      (wire = await f.action(token, { moveResult: receipt, futureResult: { id: 9 } })),
  );
  assert.equal(wire.snapshotProtocol, 2);
  assert(wire.baseToken);
  assert.deepEqual(
    wire.changes.map((c) => c.index),
    [2],
  );
  assert.deepEqual(result, { ...f.state(), moveResult: receipt, futureResult: { id: 9 } });
  assert.equal(before.tabs[2].mutedInfo.muted, false);
  assert.notEqual(before.tabs, result.tabs);
  assert.deepEqual(await f.read(), f.state());
});

test('invalid action delta recovers through a snapshot without repeating the mutation or losing its receipt', async () => {
  const f = fixture();
  await f.read();
  const receipt = { operationId: 'one', committed: true };
  const next = await f.read.perform(async (token) => ({
    ...(await f.action(token, { moveResult: receipt, extra: 42 })),
    baseToken: 'wrong',
  }));
  assert.equal(f.actions.length, 1);
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads.at(-1), undefined);
  assert.deepEqual(next, { ...f.state(), moveResult: receipt, extra: 42 });
  assert.deepEqual(await f.read(), f.state());
});

for (const invalid of ['duplicate', 'negative', 'outside', 'id', 'generation', 'missing', 'null']) {
  test(`malformed ${invalid} delta falls back without repeating an action`, async () => {
    const f = fixture();
    await f.read();
    await f.read.perform(async (token) => {
      const wire = await f.action(token);
      if (invalid === 'duplicate') wire.changes.push(wire.changes[0]);
      if (invalid === 'negative') wire.changes[0].index = -1;
      if (invalid === 'outside') wire.changes[0].index = 10;
      if (invalid === 'id') wire.changes[0].tab.id = 500;
      if (invalid === 'generation') wire.state.generation = 'other';
      if (invalid === 'missing') delete wire.changes;
      if (invalid === 'null') wire.changes = [null];
      return wire;
    });
    assert.equal(f.actions.length, 1);
    assert.equal(f.reads.length, 2);
    assert.deepEqual(await f.read(), f.state());
  });
}

test('a lost response throws and a recovery read sees the once-committed mutation', async () => {
  const f = fixture();
  await f.read();
  await assert.rejects(
    f.read.perform(async (token) => {
      await f.action(token);
      throw new Error('Response lost');
    }),
    /Response lost/,
  );
  assert.equal(f.actions.length, 1);
  assert.equal((await f.read()).tabs[2].mutedInfo.muted, true);
});

test('raw legacy action snapshots and non-snapshot results remain unchanged', async () => {
  const f = fixture();
  await f.read();
  for (const value of [
    null,
    { tabId: 100 },
    { committed: true, operationId: 'id' },
    { newTab: { links: [] } },
    { token: 'import-preview', fingerprint: 'hash', rows: [], containers: [] },
    { version: 2, token: 'opaque-result', state: { retained: true } },
  ])
    assert.deepEqual(await f.read.perform(async () => value), value);
  const legacy = {
    ...snapshot(),
    version: 2,
    baseToken: 'opaque',
    token: 'opaque-snapshot-field',
    moveResult: { committed: true },
  };
  assert.deepEqual(await f.read.perform(async () => structuredClone(legacy)), legacy);
  assert.deepEqual(await f.read(), f.state());
});

test('background restart returns a full action response, preserving its result fields', async () => {
  const f = fixture();
  await f.read();
  f.restart();
  let wire;
  const value = await f.read.perform(
    async (token) => (wire = await f.action(token, { createdGroupId: 'folder' })),
  );
  assert.equal(wire.baseToken, undefined);
  assert.equal(value.generation, 'restarted');
  assert.equal(value.createdGroupId, 'folder');
});

test('late action replies do not replace a newer base or repopulate after disposal', async () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    await f.read();
    let release;
    const pending = f.read.perform(async (token) => {
      const value = await f.action(token);
      await new Promise((resolve) => (release = resolve));
      return value;
    });
    while (!release) await Promise.resolve();
    if (dispose) f.read.clear();
    else await f.read();
    const latestToken = f.replies.at(-1).token;
    release();
    await pending;
    await f.read();
    if (dispose) assert.equal(f.reads.at(-1), undefined);
    else assert.equal(f.reads.at(-1), latestToken);
  }
});

test('failed full recovery does not replace a previous base or replay the action', async () => {
  let fail = false,
    actionCalls = 0;
  const tokens = [];
  const state = snapshot();
  const encoder = createSnapshotEncoder();
  const read = createSnapshotReader(async (token) => {
    tokens.push(token);
    if (fail) throw new Error('Read failed');
    return encoder.encode(1, state, token);
  });
  await read();
  fail = true;
  await assert.rejects(
    read.perform(async () => {
      actionCalls++;
      return { token: 'bad', snapshotProtocol: 2, baseToken: 'bad', state: {} };
    }),
    /Read failed/,
  );
  fail = false;
  await read();
  assert.equal(actionCalls, 1);
  assert.equal(typeof tokens.at(-1), 'string');
});

test('a lost move reply uses its durable receipt after restart without repeating organisation changes', async () => {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      windowId: 1,
      index: i,
      title: `Tab ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      active: i === 0,
    })),
    memberships: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        i + 1,
        {
          treeId: `tree-${i + 1}`,
          groupId: null,
          ancestors: [],
          order: i,
          opaque: { retained: true },
        },
      ]),
    ),
  });
  let controller = createController(api),
    encoder = createSnapshotEncoder();
  const read = createSnapshotReader(async (token) =>
    structuredClone(
      encoder.encode(
        1,
        await controller.requestForTransport({ type: 'snapshot', windowId: 1 }),
        token,
      ),
    ),
  );
  try {
    const before = await read();
    const source = moveSource(before, 'tab', 2),
      destination = { kind: 'group', id: 'work' };
    const message = {
      type: 'moveItem',
      windowId: 1,
      operationId: 'lost-wire-reply',
      source,
      destination,
      expected: resolveMove(before, source, destination).expected,
    };
    const sendAction = async (token) =>
      structuredClone(encoder.encode(1, await controller.requestForTransport(message), token, 2));
    await assert.rejects(
      read.perform(async (token) => {
        await sendAction(token);
        throw new Error('Reply lost');
      }),
      /Reply lost/,
    );
    const receipt = await controller.request({ type: 'moveStatus', windowId: 1 });
    assert.equal(receipt.operationId, message.operationId);
    await controller.request({ type: 'moveTab', windowId: 1, id: 2, groupId: null });
    await controller.dispose();
    controller = createController(api);
    encoder = createSnapshotEncoder();
    const recovered = await read.perform(sendAction);
    assert.equal(recovered.moveResult.operationId, message.operationId);
    assert.equal(recovered.moveResult.committed, true);
    assert.equal(recovered.tabs.find((tab) => tab.id === 2).groupId, null);
    assert.deepEqual(
      recovered.tabs.map((tab) => tab.treeId).sort(),
      before.tabs.map((tab) => tab.treeId).sort(),
    );
    assert.deepEqual((await read()).tabs, recovered.tabs);
  } finally {
    await controller.dispose();
  }
});

test('serial action replies replace the existing response base without retaining prior action snapshots', async () => {
  const f = fixture();
  await f.read();
  for (let i = 0; i < 100; i++) {
    const reply = await f.read.perform((token) =>
      f.action(token, { moveResult: { operationId: String(i), committed: true } }),
    );
    assert.equal(reply.moveResult.operationId, String(i));
    assert.deepEqual(f.retention(), { bases: 1, tabReferences: 10 });
  }
  assert.deepEqual(await f.read(), f.state());
  assert.deepEqual(f.retention(), { bases: 1, tabReferences: 10 });
});

test('real folder-import previews retain their token and complete non-snapshot result', async () => {
  const api = memoryBrowser({ groups: [{ id: 'work', name: 'Work', parentId: null }], tabs: [] });
  const controller = createController(api);
  try {
    const backup = await controller.request({ type: 'exportFolders', windowId: 1 });
    const preview = await controller.request({
      type: 'previewFolderImport',
      windowId: 1,
      backup,
      destination: {},
    });
    let reads = 0;
    const read = createSnapshotReader(async () => {
      reads++;
      return snapshot();
    });
    assert.equal(typeof preview.token, 'string');
    assert.deepEqual(await read.perform(async () => structuredClone(preview)), preview);
    assert.equal(reads, 0);
  } finally {
    await controller.dispose();
  }
});
