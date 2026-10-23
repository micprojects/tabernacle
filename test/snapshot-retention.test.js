import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotEncoder, createSnapshotReader } from '../extension/src/snapshot-transfer.js';

const snapshot = (count = 4) => ({
  generation: 'background',
  revision: 1,
  groups: [],
  view: { scopeId: null, collapsed: [] },
  futureSnapshotField: { untouched: true },
  tabs: Array.from({ length: count }, (_, id) => ({
    id,
    title: `Tab ${id}`,
    futureTabField: { nested: [id, { retained: true }] },
  })),
});

test('60,000 tabs across 28 windows retain all 56 reader bases', () => {
  const encoder = createSnapshotEncoder();
  const tabs = snapshot(60000).tabs;
  const states = Array.from({ length: 28 }, (_, windowId) => ({
    ...snapshot(0),
    tabs: tabs.filter((tab) => tab.id % 28 === windowId),
  }));
  const readers = states.flatMap((state, windowId) =>
    Array.from({ length: 2 }, () => ({ windowId, state, token: undefined })),
  );
  for (const reader of readers) reader.token = encoder.encode(reader.windowId, reader.state).token;
  assert.deepEqual(encoder.stats(), { bases: 56, tabReferences: 120000 });
  for (const reader of readers) {
    const result = encoder.encode(reader.windowId, reader.state, reader.token);
    assert.equal(result.baseToken, reader.token);
    assert.deepEqual(result.changes, []);
    reader.token = result.token;
  }
  assert.deepEqual(encoder.stats(), { bases: 56, tabReferences: 120000 });
  encoder.forget(0);
  assert.deepEqual(encoder.stats(), {
    bases: 54,
    tabReferences: 120000 - states[0].tabs.length * 2,
  });
});

test('base count and reference budget evict oldest accesses without evicting unrelated bases', () => {
  const encoder = createSnapshotEncoder({ maxBases: 3, maxTabReferences: 10 });
  const state = snapshot();
  const first = encoder.encode(1, state);
  const second = encoder.encode(2, state);
  const third = encoder.encode(3, state);
  assert.deepEqual(encoder.stats(), { bases: 2, tabReferences: 8 });
  const refreshed = encoder.encode(2, state, second.token);
  assert.equal(refreshed.baseToken, second.token);
  assert.deepEqual(encoder.stats(), { bases: 2, tabReferences: 8 });
  assert.equal(encoder.encode(1, state, first.token).baseToken, undefined);
  assert.equal(encoder.encode(3, state, third.token).baseToken, undefined);

  const bounded = createSnapshotEncoder(2);
  const oldest = bounded.encode(1, state);
  bounded.encode(2, state);
  bounded.encode(3, state);
  assert.equal(bounded.encode(1, state, oldest.token).baseToken, undefined);
  assert.deepEqual(bounded.stats(), { bases: 2, tabReferences: 8 });
});

test('over-budget and zero-retention snapshots remain full without retaining their tabs', () => {
  const encoder = createSnapshotEncoder({ maxTabReferences: 10 });
  const state = snapshot();
  const small = encoder.encode(1, state);
  const large = encoder.encode(2, snapshot(11));
  assert.equal(large.baseToken, undefined);
  assert.deepEqual(encoder.stats(), { bases: 1, tabReferences: 4 });
  assert.equal(encoder.encode(2, snapshot(11), large.token).baseToken, undefined);
  assert.equal(encoder.encode(1, state, small.token).baseToken, small.token);
  const disabled = createSnapshotEncoder(0);
  const first = disabled.encode(1, state);
  assert.equal(disabled.encode(1, state, first.token).baseToken, undefined);
  assert.deepEqual(disabled.stats(), { bases: 0, tabReferences: 0 });
});

test('idle bases expire lazily while refreshed bases retain their full timeout', () => {
  let time = 0;
  const encoder = createSnapshotEncoder({ idleMs: 30, now: () => time });
  const state = snapshot();
  const first = encoder.encode(1, state);
  const second = encoder.encode(2, state);
  time = 29;
  const fresh = encoder.encode(1, state, first.token);
  assert.equal(fresh.baseToken, first.token);
  time = 30;
  assert.equal(encoder.encode(2, state, second.token).baseToken, undefined);
  assert.equal(encoder.encode(1, state, fresh.token).baseToken, fresh.token);
  time = 60;
  encoder.forget(99);
  assert.deepEqual(encoder.stats(), { bases: 0, tabReferences: 0 });
});

test('retention validates limits and preserves generation/window fallback behavior', () => {
  for (const options of [-1, { maxBases: 1.5 }, { maxTabReferences: NaN }, { idleMs: -1 }])
    assert.throws(() => createSnapshotEncoder(options), RangeError);
  const encoder = createSnapshotEncoder();
  const state = snapshot();
  const first = encoder.encode(1, state);
  assert.equal(encoder.encode(2, state, first.token).baseToken, undefined);
  assert.equal(encoder.encode(1, state, first.token).baseToken, first.token);
  const other = encoder.encode(3, state);
  assert.equal(
    encoder.encode(3, { ...state, generation: 'new-background' }, other.token).baseToken,
    undefined,
  );
  assert.equal(createSnapshotEncoder().encode(3, state, other.token).baseToken, undefined);
});

test('reader clear prevents pending replies from retaining hidden-view bases', async () => {
  const encoder = createSnapshotEncoder();
  const state = snapshot();
  const tokens = [];
  let release;
  let hold = false;
  const read = createSnapshotReader(async (token) => {
    tokens.push(token);
    const response = encoder.encode(1, state, token);
    if (hold) {
      hold = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return structuredClone(response);
  });
  await read();
  hold = true;
  const pending = read();
  read.clear();
  release();
  assert.deepEqual(await pending, state);
  assert.deepEqual(await read(), state);
  assert.equal(tokens.at(-1), undefined);
});

test('late replies return their own snapshot without replacing the latest completed base', async () => {
  const encoder = createSnapshotEncoder();
  let state = snapshot();
  let release;
  let hold = false;
  const messages = [];
  const tokens = [];
  const read = createSnapshotReader(async (token) => {
    tokens.push(token);
    const result = structuredClone(encoder.encode(1, state, token));
    messages.push(result);
    if (hold) {
      hold = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return result;
  });
  await read();
  hold = true;
  state = structuredClone(state);
  state.tabs[0].title = 'Older';
  const older = read();
  state = structuredClone(state);
  state.tabs[0].title = 'Newer';
  const latest = await read();
  const latestToken = messages.at(-1).token;
  release();
  assert.equal((await older).tabs[0].title, 'Older');
  assert.equal(latest.tabs[0].title, 'Newer');
  assert.deepEqual(await read(), state);
  assert.equal(tokens.at(-1), latestToken);
  assert.equal(messages.at(-1).baseToken, latestToken);
});

test('unknown nested fields and old backgrounds survive fallback and incremental reads', async () => {
  const encoder = createSnapshotEncoder();
  let state = snapshot(8);
  let message;
  const read = createSnapshotReader(async (token) => {
    message = encoder.encode(1, state, token);
    return structuredClone(message);
  });
  const first = await read();
  state = structuredClone(state);
  state.futureSnapshotField.untouched = false;
  state.tabs[2].futureTabField.nested[1].retained = false;
  delete state.tabs[3].title;
  assert.deepEqual(await read(), state);
  assert(message.baseToken);
  assert.equal(first.tabs[2].futureTabField.nested[1].retained, true);
  let calls = 0;
  const legacy = createSnapshotReader(async () =>
    ++calls === 1 ? { token: 'stale', baseToken: 'wrong' } : state,
  );
  assert.deepEqual(await legacy(), state);
  assert.equal(calls, 2);
});
