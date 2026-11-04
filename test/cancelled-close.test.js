import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { captureTarget } from '../extension/src/tab-collection.js';
import { TAB_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture(t) {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [1, 2, 3, 4, 5].map((id, index) => ({
      id,
      index,
      windowId: id === 5 ? 2 : 1,
      url: 'https://example.test/same',
      title: `Tab ${id}`,
      active: id === 1 || id === 5,
    })),
    memberships: Object.fromEntries(
      [1, 2, 3, 4, 5].map((id) => [
        id,
        {
          treeId: `tree-${id}`,
          groupId: 'work',
          ancestors: id === 2 || id === 3 ? ['tree-1'] : [],
          order: id * 1024,
          future: { retained: id },
        },
      ]),
    ),
  });
  let controller = createController(api);
  t.after(() => controller.dispose());
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  const remove = api.tabs.remove;
  const refused = new Set([1]);
  api.tabs.remove = async (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) if (!refused.has(id)) await remove(id);
  };
  return {
    api,
    send,
    refused,

    async restart() {
      await controller.dispose();
      controller = createController(api);
    },
  };
}

for (const promoteFirstChild of [false, true]) {
  test(`cancelled single close preserves placement and retries after restart (promote ${promoteFirstChild})`, async (t) => {
    const f = fixture(t);
    await f.send('snapshot');
    const before = await Promise.all(
      [1, 2, 3, 5].map((id) => f.api.sessions.getTabValue(id, TAB_KEY)),
    );
    await assert.rejects(f.send('closeTab', { id: 1, promoteFirstChild }), /still open/);
    assert.deepEqual(
      await Promise.all([1, 2, 3, 5].map((id) => f.api.sessions.getTabValue(id, TAB_KEY))),
      before,
    );
    await f.restart();
    const state = await f.send('snapshot');
    assert.equal(state.tabs.find((tab) => tab.id === 1).active, true);
    assert.equal(state.tabs.find((tab) => tab.id === 3).parentTabId, 1);
    f.refused.clear();
    const after = await f.send('closeTab', { id: 1, promoteFirstChild });
    assert(!after.tabs.some((tab) => tab.id === 1));
    assert.equal(after.tabs.find((tab) => tab.id === 3).parentTabId, promoteFirstChild ? 2 : null);
  });
}

for (const type of ['closeTabSet', 'closeDuplicateTabs']) {
  for (const active of [false, true]) {
    test(`${type} counts cancelled ${active ? 'active' : 'background'} tabs as failed and preserves partial success`, async (t) => {
      const f = fixture(t);
      if (!active) await f.api.tabs.update(4, { active: true });
      const before = await f.send('snapshot');
      const args = {
        scope: { kind: 'window' },
        targets: before.tabs.filter((tab) => [1, 3].includes(tab.id)).map(captureTarget),
        keepers: [captureTarget(before.tabs.find((tab) => tab.id === 4))],
      };
      const result = await f.send(type, args);
      assert.deepEqual(result.batchResult.completed, [3]);
      assert.deepEqual(result.batchResult.skipped, []);
      assert.deepEqual(
        result.batchResult.failed.map(({ id }) => id),
        [1],
      );
      assert.match(result.batchResult.failed[0].error, /still open/);
      assert(result.tabs.some((tab) => tab.id === 1));
      assert(!result.tabs.some((tab) => tab.id === 3));
      assert(await f.api.tabs.get(5));
      f.refused.clear();
      const retry = await f.send(type, args);
      assert.deepEqual(retry.batchResult.completed, [1]);
      assert.deepEqual(retry.batchResult.skipped, [3]);
      assert.deepEqual(retry.batchResult.failed, []);
    });
  }
}

for (const type of ['closeTabTree', 'closeGroupTabs']) {
  test(`${type} reports an incomplete native close and permits retry without touching another window`, async (t) => {
    const f = fixture(t);
    const args = { id: type === 'closeTabTree' ? 1 : 'work', tabIds: [1, 2, 3] };
    await assert.rejects(f.send(type, args), /still open/);
    assert.deepEqual(
      (await f.send('snapshot')).tabs.map((tab) => tab.id),
      [1, 4],
    );
    assert(await f.api.tabs.get(5));
    await f.restart();
    f.refused.clear();
    const result = await f.send(type, args);
    assert.deepEqual(
      result.tabs.map((tab) => tab.id),
      [4],
    );
    assert(await f.api.tabs.get(5));
  });
}

test('close confirmation falls back to native reads when removal events are unavailable', async (t) => {
  const f = fixture(t);
  delete f.api.tabs.onRemoved;
  await f.send('snapshot');
  await assert.rejects(f.send('closeTab', { id: 1 }), /still open/);
  f.refused.clear();
  assert(!(await f.send('closeTab', { id: 1 })).tabs.some((tab) => tab.id === 1));
});

test('failed native close confirmation is surfaced and its temporary listener is always released', async (t) => {
  const f = fixture(t);
  await f.send('snapshot');
  const listeners = new Set();
  const event = f.api.tabs.onRemoved;
  const add = event.addListener;
  const remove = event.removeListener;
  event.addListener = (listener) => {
    listeners.add(listener);
    return add(listener);
  };
  event.removeListener = (listener) => {
    listeners.delete(listener);
    return remove(listener);
  };
  const get = f.api.tabs.get;
  const query = f.api.tabs.query;
  let attempted = false;
  f.api.tabs.remove = async () => {
    attempted = true;
  };
  f.api.tabs.get = async (id) => {
    if (attempted) throw new Error('Native confirmation unavailable');
    return get(id);
  };
  f.api.tabs.query = async (...args) => {
    if (attempted) throw new Error('Native query unavailable');
    return query(...args);
  };
  await assert.rejects(f.send('closeTab', { id: 1 }), /unavailable/);
  assert.equal(listeners.size, 0);
  f.api.tabs.get = get;
  f.api.tabs.query = query;
  assert.equal((await f.send('snapshot')).tabs.length, 4);
  f.api.tabs.remove = async () => {
    throw new Error('Close failed');
  };
  await assert.rejects(f.send('closeTab', { id: 1 }), /Close failed/);
  assert.equal(listeners.size, 0);
  f.api.tabs.remove = async () => {};
  await assert.rejects(f.send('closeTab', { id: 1 }), /still open/);
  assert.equal(listeners.size, 0);
});
