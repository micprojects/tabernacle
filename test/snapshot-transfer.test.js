import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotEncoder, createSnapshotReader } from '../extension/src/snapshot-transfer.js';

const fixture = (count = 1000) => ({
  generation: 'background',
  revision: 1,
  groups: [{ id: 'folder', name: 'Folder', parentId: null }],
  view: { scopeId: 'folder', collapsed: [] },
  tabs: Array.from({ length: count }, (_, id) => ({
    id,
    treeId: `tree-${id}`,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    ancestors: id ? [`tree-${id - 1}`] : [],
    parentTabId: id ? id - 1 : null,
    groupId: 'folder',
    order: id,
    pinned: false,
    mutedInfo: { muted: false },
    container: { name: 'Work', colorCode: '#0000ff' },
  })),
});

function connection(initial = fixture()) {
  let state = initial;
  const encoder = createSnapshotEncoder();
  const messages = [];
  const read = createSnapshotReader(async (token) => {
    const message = encoder.encode(1, structuredClone(state), token);
    messages.push(message);
    return structuredClone(message);
  });
  return {
    read,
    messages,
    encoder,

    set: (next) => {
      state = next;
    },
  };
}

test('live metadata transfers only changed tabs and reconstructs the exact snapshot', async () => {
  const f = connection();
  const before = await f.read();
  const next = structuredClone(before);
  next.revision++;
  next.tabs[15].title = 'Live page';
  next.tabs[19].favIconUrl = 'data:image/svg+xml,test';
  next.tabs[25].discarded = true;
  next.tabs[99].mutedInfo = { muted: true, reason: 'user' };
  next.tabs[120].container.name = 'Renamed container';
  next.view.collapsed = ['folder'];
  f.set(next);
  assert.deepEqual(await f.read(), next);
  const message = f.messages.at(-1);
  assert.deepEqual(
    message.changes.map(({ index }) => index),
    [15, 19, 25, 99, 120],
  );
  assert(!Object.hasOwn(message.state, 'tabs'));
  assert(JSON.stringify(message).length < JSON.stringify(next).length / 20);
  assert.equal(before.tabs[15].title, 'Tab 15');
  assert.deepEqual(before.tabs[99].mutedInfo, { muted: false });
});

test('unchanged reads and removed or nested fields survive incremental transfer', async () => {
  const f = connection();
  const before = await f.read();
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(f.messages.at(-1).changes, []);
  const next = structuredClone(before);
  delete next.tabs[5].title;
  next.tabs[10].ancestors = [];
  next.tabs[10].parentTabId = null;
  next.tabs[20].sharingState = { camera: true, screen: 'Screen' };
  f.set(next);
  assert.deepEqual(await f.read(), next);
  const newer = structuredClone(next);
  newer.tabs[20].sharingState.camera = false;
  newer.tabs[10].ancestors = ['tree-3'];
  f.set(newer);
  assert.deepEqual(await f.read(), newer);
});

for (const change of ['add', 'remove', 'reorder', 'replace', 'generation', 'most-tabs']) {
  test(`${change} falls back to a complete snapshot`, async () => {
    const f = connection(fixture(10));
    const next = structuredClone(await f.read());
    if (change === 'add') next.tabs.push({ ...next.tabs[0], id: 99 });
    if (change === 'remove') next.tabs.pop();
    if (change === 'reorder') next.tabs.reverse();
    if (change === 'replace') next.tabs[0].id = 99;
    if (change === 'generation') next.generation = 'restarted';
    if (change === 'most-tabs')
      next.tabs.forEach((tab) => {
        tab.title = 'Changed';
      });
    f.set(next);
    assert.deepEqual(await f.read(), next);
    assert.equal(f.messages.at(-1).baseToken, undefined);
  });
}

test('response tokens distinguish equal revisions and multiple views of a window', () => {
  const encoder = createSnapshotEncoder();
  const original = fixture(10);
  const first = encoder.encode(1, original);
  const second = encoder.encode(1, original);
  const changed = structuredClone(original);
  changed.tabs[0].status = 'loading';
  const stale = encoder.encode(1, changed, first.token);
  assert.notEqual(first.token, second.token);
  assert.equal(stale.baseToken, first.token);
  const otherView = encoder.encode(1, changed, second.token);
  assert.equal(otherView.baseToken, second.token);
  const fresh = encoder.encode(1, original, stale.token);
  assert.deepEqual(fresh.changes, [{ index: 0, tab: original.tabs[0] }]);
  assert.equal(encoder.encode(2, original, fresh.token).baseToken, undefined);
});

test('closed windows, bounded cache eviction and background restarts fall back safely', () => {
  let encoder = createSnapshotEncoder(2);
  const state = fixture(10);
  const first = encoder.encode(1, state);
  encoder.encode(2, state);
  encoder.encode(3, state);
  const evicted = encoder.encode(1, state, first.token);
  assert.equal(evicted.baseToken, undefined);
  encoder.forget(1);
  const forgotten = encoder.encode(1, state, evicted.token);
  assert.equal(forgotten.baseToken, undefined);
  encoder = createSnapshotEncoder(2);
  assert.equal(encoder.encode(1, state, forgotten.token).baseToken, undefined);
});

test('overlapping replies use their captured base and errors leave it usable', async () => {
  const encoder = createSnapshotEncoder();
  let next = fixture(10);
  let hold = false;
  let release;
  let fail = false;
  const read = createSnapshotReader(async (token) => {
    if (fail) throw new Error('Transport unavailable');
    const result = structuredClone(encoder.encode(1, next, token));
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
  next = structuredClone(next);
  next.tabs[2].title = 'First change';
  const pending = read();
  next = structuredClone(next);
  next.tabs[3].title = 'Second change';
  assert.deepEqual(await read(), next);
  release();
  const older = await pending;
  assert.equal(older.tabs[2].title, 'First change');
  assert.equal(older.tabs[3].title, 'Tab 3');
  fail = true;
  await assert.rejects(read(), /Transport unavailable/);
  fail = false;
  assert.deepEqual(await read(), next);
});

test('an unexpected base retries with a full read; old backgrounds remain compatible', async () => {
  const state = fixture(10);
  const tokens = [];
  const read = createSnapshotReader(async (token) => {
    tokens.push(token);
    return tokens.length === 1
      ? { token: 'new', baseToken: 'wrong', state: {}, changes: [] }
      : { token: 'full', state };
  });
  assert.deepEqual(await read(), state);
  assert.deepEqual(tokens, [undefined, undefined]);
  const legacy = createSnapshotReader(async () => state);
  assert.deepEqual(await legacy(), state);
  const invalid = createSnapshotReader(async () => ({ token: 'bad', baseToken: 'wrong' }));
  await assert.rejects(invalid(), /could not refresh/);
});
