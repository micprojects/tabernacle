import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

const slot = (id) => ({ kind: 'tab', id });

async function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'folder', name: 'Folder', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, index: 0, pinned: true },
      { id: 2, windowId: 1, index: 1, pinned: true },
      { id: 3, windowId: 1, index: 2, active: true },
      { id: 4, windowId: 2, index: 0, pinned: true, active: true },
    ],
    memberships: Object.fromEntries(
      [1, 2, 3, 4].map((id) => [id, { treeId: `t${id}`, groupId: null }]),
    ),
  });
  api.testing.saved[MODEL_KEY].folderPins = [{ id: 'folder', action: 'open' }];
  await api.sessions.setWindowValue(1, VIEW_KEY, {
    scopeId: null,
    collapsed: [],
    pinLayout: [slot('t1'), { kind: 'group', id: 'folder' }, slot('t2'), slot('restoring')],
  });
  const controller = createController(api);
  const send = (type = 'snapshot', args = {}) => controller.request({ type, windowId: 1, ...args });
  await send();
  await send('snapshot', { windowId: 2 });
  return { api, controller, send };
}

test('ordinary tab churn retains no closed identities while saved pin cleanup stays pending', async () => {
  const { api, controller, send } = await fixture();
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const created = [];
      for (let i = 0; i < 100; i++)
        created.push(await api.tabs.create({ windowId: 1, active: false }));
      await Promise.all(created.map((tab) => controller.created(tab)));
      await api.tabs.remove(created.map((tab) => tab.id));
      assert.equal(controller.cacheStats().forgottenPinKeys, 0);
    }
    // An unpin without a snapshot still owns its old saved slot until reconciled.
    await api.tabs.update(1, { pinned: false });
    await api.tabs.remove(1);
    await api.testing.attach(2, 2);
    assert.equal(controller.cacheStats().forgottenPinKeys, 2);
    const state = await send();
    assert.deepEqual(state.view.pinLayout, [{ kind: 'group', id: 'folder' }, slot('restoring')]);
    assert.equal(controller.cacheStats().forgottenPinKeys, 0);
    const other = await send('snapshot', { windowId: 2 });
    assert(other.pins.some((item) => item.id === 't2'));
    assert(other.pins.some((item) => item.id === 't4'));
  } finally {
    await controller.dispose();
  }
});

test('failed view reads retain uncertain closures until a successful read can filter them', async () => {
  const { api, controller, send } = await fixture();
  const read = api.sessions.getWindowValue;
  const before = structuredClone(api.testing.windowValues.get(1));
  api.sessions.getWindowValue = async () => {
    throw new Error('Read unavailable');
  };
  try {
    await assert.rejects(send(), /Read unavailable/);
    await api.tabs.remove([1, 3]);
    assert.equal(controller.cacheStats().forgottenPinKeys, 2);
    assert.deepEqual(api.testing.windowValues.get(1), before);
    api.sessions.getWindowValue = read;
    const state = await send();
    assert(!state.view.pinLayout.some((item) => item.id === 't1'));
    assert(state.view.pinLayout.some((item) => item.id === 'restoring'));
    assert.equal(controller.cacheStats().forgottenPinKeys, 0);
  } finally {
    await controller.dispose();
  }
});

test('failed view writes retain cleanup records and preserve saved slots for retry', async () => {
  const { api, controller, send } = await fixture();
  const write = api.sessions.setWindowValue;
  const before = structuredClone(api.testing.windowValues.get(1));
  await api.tabs.remove(1);
  api.sessions.setWindowValue = async () => {
    throw new Error('Write unavailable');
  };
  try {
    await assert.rejects(send(), /Write unavailable/);
    assert.equal(controller.cacheStats().forgottenPinKeys, 1);
    await api.tabs.remove(3);
    assert.equal(controller.cacheStats().forgottenPinKeys, 2);
    assert.deepEqual(api.testing.windowValues.get(1), before);
    api.sessions.setWindowValue = write;
    const state = await send();
    assert(!state.view.pinLayout.some((item) => item.id === 't1'));
    assert(state.view.pinLayout.some((item) => item.id === 'restoring'));
    assert.equal(controller.cacheStats().forgottenPinKeys, 0);
  } finally {
    await controller.dispose();
  }
});

test('a close during a pending layout write survives for the next reconciliation', async () => {
  const { api, controller, send } = await fixture();
  const write = api.sessions.setWindowValue;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  await api.tabs.remove(1);
  api.sessions.setWindowValue = async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  };
  try {
    const pending = send();
    await entered.promise;
    await api.tabs.remove(2);
    assert.equal(controller.cacheStats().forgottenPinKeys, 2);
    release.resolve();
    await pending;
    assert.equal(controller.cacheStats().forgottenPinKeys, 1);
    api.sessions.setWindowValue = write;
    const state = await send();
    assert.deepEqual(state.view.pinLayout, [{ kind: 'group', id: 'folder' }, slot('restoring')]);
    assert.equal(controller.cacheStats().forgottenPinKeys, 0);
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('late view reads cannot recreate pin-layout tracking after a window closes', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 20, windows: 2 }));
  const controller = createController(f.api);
  const read = f.api.sessions.getWindowValue;
  await controller.request({ type: 'snapshot', windowId: 1 });
  await controller.request({ type: 'snapshot', windowId: 2 });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.api.sessions.getWindowValue = async (...args) => {
    const result = await read(...args);
    entered.resolve();
    await release.promise;
    return result;
  };
  try {
    const pending = controller.request({ type: 'snapshot', windowId: 2 });
    await entered.promise;
    await f.api.tabs.remove(
      [...f.native.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id),
    );
    f.closeWindow(2);
    release.resolve();
    await pending;
    assert.equal(controller.cacheStats().pinLayoutWindows, 1);
    assert.equal(controller.cacheStats().forgottenWindows, 0);
    await controller.dispose();
    assert(Object.values(controller.cacheStats()).every((value) => value === 0));
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('a lost write response can be retried without restoring a removed pin slot', async () => {
  const { api, controller, send } = await fixture();
  const write = api.sessions.setWindowValue;
  await api.tabs.remove(1);
  api.sessions.setWindowValue = async (...args) => {
    await write(...args);
    throw new Error('Response lost');
  };
  try {
    await assert.rejects(send(), /Response lost/);
    assert.equal(controller.cacheStats().forgottenPinKeys, 1);
    assert(!api.testing.windowValues.get(1).pinLayout.some((item) => item.id === 't1'));
    api.sessions.setWindowValue = write;
    const state = await send();
    assert(!state.view.pinLayout.some((item) => item.id === 't1'));
    assert(state.view.pinLayout.some((item) => item.id === 'restoring'));
    assert.equal(controller.cacheStats().forgottenPinKeys, 0);
  } finally {
    await controller.dispose();
  }
});

test('a rejected write after window closure cannot retain layout tracking', async () => {
  const { api, controller, send } = await fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  await api.tabs.remove(1);
  api.sessions.setWindowValue = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('Window closed');
  };
  try {
    const pending = send();
    await entered.promise;
    await api.tabs.remove([2, 3]);
    api.testing.windows.delete(1);
    api.windows.onRemoved.emit(1);
    release.resolve();
    await assert.rejects(pending, /Window closed/);
    assert.equal(controller.cacheStats().pinLayoutWindows, 1);
    assert.equal(controller.cacheStats().forgottenWindows, 0);
  } finally {
    release.resolve();
    await controller.dispose();
  }
});
