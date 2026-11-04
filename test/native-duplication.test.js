import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { TAB_KEY } from '../extension/src/model.js';

async function fixture(t) {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [
      { id: 1, windowId: 1, index: 0, url: 'https://parent.test/' },
      { id: 2, windowId: 1, index: 1, url: 'https://child.test/' },
      { id: 3, windowId: 2, index: 0, url: 'https://other.test/' },
    ],
    memberships: {
      1: { treeId: 'parent', groupId: 'work', ancestors: [], order: 0 },
      2: {
        treeId: 'child',
        groupId: 'work',
        ancestors: ['parent'],
        order: 0,
        openedAt: 1000,
        collapsed: true,
        extra: { retained: true },
      },
    },
  });
  let controller = createController(api);
  let creation;
  api.testing.setCreatedHandler((tab) => {
    creation = controller.created(tab);
  });
  const send = (type = 'snapshot', args = {}) => controller.request({ type, windowId: 1, ...args });
  await send();
  const original = await api.sessions.getTabValue(2, TAB_KEY);
  t.after(() => controller.dispose());
  return {
    api,
    send,
    original,
    created: () => creation,

    restart() {
      controller.dispose();
      controller = createController(api);
    },
  };
}

for (const failure of [null, 'read', 'write'])
  test(`late native duplication retains membership after ${failure ?? 'successful'} recovery`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const f = await fixture(t);
    const tab = await f.api.tabs.create({ windowId: 1, url: 'about:blank', active: false });
    await f.created();
    assert.equal((await f.send()).tabs.find((t) => t.id === tab.id).groupId, null);
    // Firefox fills session data after the native duplicate's blank creation.
    t.mock.timers.tick(2000);
    f.api.testing.tabValues.set(tab.id, structuredClone(f.original));
    await f.api.tabs.update(tab.id, { url: 'https://child.test/', status: 'loading' });
    const method = failure === 'read' ? 'getTabValue' : 'setTabValue';
    const native = f.api.sessions[method];
    if (failure) {
      f.api.sessions[method] = async (...args) => {
        if (args[0] === tab.id) throw new Error('Injected session failure');
        return native(...args);
      };
      await assert.rejects(f.send(), /Injected session failure/);
      assert.deepEqual(f.api.testing.tabValues.get(tab.id), f.original);
      f.api.sessions[method] = native;
    }
    const state = await f.send();
    const copy = state.tabs.find((t) => t.id === tab.id);
    assert.equal(copy.groupId, 'work');
    assert.equal(copy.parentTabId, 1);
    assert.notEqual(copy.treeId, 'child');
    assert.equal(copy.collapsed, false);
    assert.equal(copy.openedAt, 10_000);
    assert.equal(state.tabs.find((t) => t.id === 2).treeId, 'child');
    assert.deepEqual((await f.api.sessions.getTabValue(tab.id, TAB_KEY)).extra, { retained: true });
    f.restart();
    const reloaded = (await f.send()).tabs.find((t) => t.id === tab.id);
    assert.equal(reloaded.groupId, copy.groupId);
    assert.equal(reloaded.parentTabId, copy.parentTabId);
    assert.equal(reloaded.treeId, copy.treeId);
    await f.api.testing.attach(tab.id, 2);
    const moved = await f.send('snapshot', { windowId: 2 });
    assert.equal(moved.tabs.find((t) => t.id === tab.id).groupId, 'work');
  });

test('native session copy during a creation read keeps its saved placement', async (t) => {
  const f = await fixture(t);
  const get = f.api.tabs.get;
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.api.tabs.get = async (id) => {
    const value = await get(id);
    if (id > 3) {
      entered();
      await held;
    }
    return value;
  };
  const tab = await f.api.tabs.create({ windowId: 1, url: 'about:blank', active: false });
  await ready;
  f.api.testing.tabValues.set(tab.id, structuredClone(f.original));
  await f.api.tabs.update(tab.id, { url: 'https://child.test/', status: 'loading' });
  release();
  await f.created();
  const copy = (await f.send()).tabs.find((t) => t.id === tab.id);
  assert.equal(copy.groupId, 'work');
  assert.equal(copy.parentTabId, 1);
  assert.notEqual(copy.treeId, 'child');
});

test('a native session copy before a save reply cannot repopulate stale membership', async (t) => {
  const f = await fixture(t);
  const save = f.api.sessions.setTabValue;
  let copied = false;
  f.api.sessions.setTabValue = async (id, ...args) => {
    const result = await save(id, ...args);
    if (id > 3 && !copied) {
      copied = true;
      f.api.testing.tabValues.set(id, structuredClone(f.original));
      await f.api.tabs.update(id, { url: 'https://child.test/', status: 'loading' });
    }
    return result;
  };
  const tab = await f.api.tabs.create({ windowId: 1, url: 'about:blank', active: false });
  await f.created();
  const copy = (await f.send()).tabs.find((item) => item.id === tab.id);
  assert(copied);
  assert.equal(copy.groupId, 'work');
  assert.equal(copy.parentTabId, 1);
  assert.notEqual(copy.treeId, 'child');
});

test('pending blank-tab records follow windows and are released on close or disposal', async () => {
  const api = memoryBrowser({ events: true });
  const cache = createBrowserCache(api);
  const first = await api.tabs.create({ windowId: 1, url: 'about:blank' });
  const second = await api.tabs.create({ windowId: 1, url: 'about:blank' });
  assert.equal(cache.stats().pendingMemberships, 2);
  await api.testing.attach(first.id, 2);
  api.windows.onRemoved.emit(1);
  assert.equal(cache.stats().pendingMemberships, 1);
  assert.equal(cache.creationTime(second.id), undefined);
  await api.tabs.remove(first.id);
  assert.equal(cache.stats().pendingMemberships, 0);
  await api.tabs.create({ windowId: 2, url: 'about:blank' });
  cache.dispose();
  assert(Object.values(cache.stats()).every((value) => value === 0));
});
