import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

function fixture(t) {
  const f = performanceBrowser(performanceFixture({ tabs: 120, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = (windowId = 1) => controller.requestForTransport({ type: 'snapshot', windowId });
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  return { ...f, controller, read, send };
}

async function assertFresh(f, state, windowId = 1) {
  const fresh = createController(f.api);
  try {
    const expected = await fresh.request({ type: 'snapshot', windowId });
    for (const field of ['tabs', 'groups', 'view', 'pins', 'folderPins', 'look'])
      assert.deepEqual(state[field], expected[field], field);
  } finally {
    await fresh.dispose();
  }
}

test('tab folds preserve fresh-resolution results, saved fields and retained snapshots', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  const copy = structuredClone(before);
  const other = await f.read(2);
  const saved = structuredClone(f.memberships.get(5));
  for (let i = 0; i < 4; i++) {
    const result = await f.send('toggleTab', { id: 5 });
    assert.equal(result.tabs.find((tab) => tab.id === 5).collapsed, i % 2 === 0);
    await assertFresh(f, result);
    result.tabs[0].title = 'Caller mutation';
    assert.notEqual((await f.read()).tabs[0].title, 'Caller mutation');
    assert.deepEqual(before, copy);
    assert.deepEqual((await f.read(2)).tabs, other.tabs);
  }
  assert.deepEqual(f.memberships.get(5), saved);
});

test('a single fold replaces only its owned presentation row', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  await f.send('toggleTab', { id: 5 });
  const after = await f.read();
  assert.notEqual(after.tabs, before.tabs);
  assert.equal(after.tabs.length, before.tabs.length);
  for (let index = 0; index < before.tabs.length; index++) {
    if (before.tabs[index].id === 5) assert.notEqual(after.tabs[index], before.tabs[index]);
    else assert.equal(after.tabs[index], before.tabs[index]);
  }
  await assertFresh(f, after);
});

test('failed and partially completed folds retain only successful writes', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  const save = f.api.sessions.setTabValue;
  f.api.sessions.setTabValue = async (id, ...args) => {
    if (id === 5) throw new Error('Fold save refused');
    return save(id, ...args);
  };
  await assert.rejects(f.send('toggleTab', { id: 5 }), /Fold save refused/);
  assert.deepEqual((await f.read()).tabs, before.tabs);
  await assert.rejects(f.send('collapseTree', { collapsed: true }), /Fold save refused/);
  const partial = await f.read();
  assert(partial.tabs.some((tab, i) => tab.collapsed !== before.tabs[i].collapsed));
  await assertFresh(f, partial);
  f.api.sessions.setTabValue = save;
  const retried = await f.send('collapseTree', { collapsed: true });
  await assertFresh(f, retried);
  await assertFresh(f, await f.send('collapseTree', { collapsed: false }));
});

for (const change of ['metadata', 'structure', 'opaque']) {
  test(`a ${change} event during a fold save merges with the committed fold`, async (t) => {
    const f = fixture(t);
    const retained = await f.read();
    const original = structuredClone(retained);
    const save = f.api.sessions.setTabValue;
    let release, started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    f.api.sessions.setTabValue = async (...args) => {
      f.api.sessions.setTabValue = save;
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return save(...args);
    };
    const pending = f.send('toggleTab', { id: 5 });
    await waiting;
    if (change === 'metadata') await f.api.tabs.update(5, { title: 'Changed while saving' });
    else if (change === 'opaque')
      await f.api.tabs.update(5, { futureNative: { changedWhileSaving: true } });
    else await f.api.tabs.update(5, { pinned: true, url: 'https://changed.invalid/' });
    release();
    const next = await pending;
    assert.equal(next.tabs.find((tab) => tab.id === 5).collapsed, true);
    await assertFresh(f, next);
    assert.deepEqual(retained, original);
  });
}

test('a failed reply read preserves a committed fold and retrying the read does not repeat it', async (t) => {
  const f = fixture(t);
  f.memberships.get(5).future = { preserved: ['value', 17] };
  f.native.get(5).futureNative = { nested: { kept: true } };
  const before = await f.read();
  const original = structuredClone(before);
  const saved = structuredClone(f.memberships.get(5));
  const model = structuredClone(f.saved);
  const save = f.api.sessions.setTabValue;
  const readWindow = f.api.sessions.getWindowValue;
  let writes = 0;
  f.api.sessions.setTabValue = async (...args) => {
    await save(...args);
    writes++;
    f.api.sessions.getWindowValue = async () => {
      f.api.sessions.getWindowValue = readWindow;
      throw new Error('Reply view read failed');
    };
  };
  await assert.rejects(f.send('toggleTab', { id: 5 }), /Reply view read failed/);
  const recovered = await f.read();
  assert.equal(writes, 1);
  assert.deepEqual(f.memberships.get(5), { ...saved, collapsed: true });
  assert.deepEqual(f.saved, model);
  assert.deepEqual(before, original);
  assert.deepEqual(recovered.tabs.find((tab) => tab.id === 5).futureNative, {
    nested: { kept: true },
  });
  await assertFresh(f, recovered);
  assert.equal(writes, 1);
});

test('committed folds survive a background restart without changing the other window', async (t) => {
  const f = fixture(t);
  const other = await f.read(2);
  await f.send('toggleTab', { id: 5 });
  const beforeRestart = await f.read();
  f.controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  const afterRestart = await restarted.requestForTransport({ type: 'snapshot', windowId: 1 });
  assert.deepEqual(afterRestart.tabs, beforeRestart.tabs);
  assert.equal(afterRestart.tabs.find((tab) => tab.id === 5).collapsed, true);
  assert.deepEqual(
    (await restarted.requestForTransport({ type: 'snapshot', windowId: 2 })).tabs,
    other.tabs,
  );
  await assertFresh(f, afterRestart);
});
