import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import { createNewTabRouting } from '../extension/src/new-tab/routing.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(t, enabled = true) {
  const api = memoryBrowser({
    events: true,
    tabs: [
      { id: 1, windowId: 1, index: 0, url: 'about:blank' },
      { id: 2, windowId: 2, index: 0, url: 'about:blank' },
    ],
  });
  api.testing.saved[MODEL_KEY].newTab = { enabled };
  const get = api.storage.local.get;
  let reads = 0;
  let read = (key) => get(key);
  api.storage.local.get = async (key) => {
    if (key === MODEL_KEY && ++reads === 1) throw new Error('Initial read failed');
    return read(key);
  };
  const router = createNewTabRouting(api);
  t.after(() => router.dispose());
  return {
    api,
    router,
    get,
    reads: () => reads,

    read: (value) => {
      read = value;
    },
  };
}

test('a failed routing load shares one recovery read across concurrent new tabs', async (t) => {
  const f = fixture(t);
  await tick();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.read(async (key) => {
    await held;
    return f.get(key);
  });
  const original = structuredClone(f.api.testing.saved);
  const tabs = await Promise.all(
    [1, 2, 1].map((windowId) => f.api.tabs.create({ windowId, url: 'about:newtab' })),
  );
  await tick();
  assert.equal(f.reads(), 2);
  release();
  await tick();
  for (const tab of tabs)
    assert.equal((await f.api.tabs.get(tab.id)).url, f.api.runtime.getURL('new-tab.html?start=1'));
  assert.deepEqual(f.api.testing.saved, original);
});
test('repeated routing read failures preserve Home and preferences until a later retry succeeds', async (t) => {
  const f = fixture(t);
  await tick();
  f.read(async () => {
    throw new Error('Read unavailable');
  });
  const original = structuredClone(f.api.testing.saved);
  for (let i = 0; i < 2; i++) {
    const tab = await f.api.tabs.create({ url: 'about:newtab' });
    await tick();
    assert.equal((await f.api.tabs.get(tab.id)).url, 'about:newtab');
    assert.deepEqual(f.api.testing.saved, original);
  }
  f.read(f.get);
  const tab = await f.api.tabs.create({ url: 'about:newtab' });
  await tick();
  assert.equal((await f.api.tabs.get(tab.id)).url, f.api.runtime.getURL('new-tab.html?start=1'));
  assert.deepEqual(f.api.testing.saved, original);
});
test('a newer opt-out wins over a slow routing recovery read', async (t) => {
  const f = fixture(t);
  await tick();
  const old = await f.get(MODEL_KEY);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.read(async () => {
    await held;
    return old;
  });
  const tab = await f.api.tabs.create({ url: 'about:newtab' });
  await tick();
  assert.equal(f.reads(), 2);
  await f.api.storage.local.set({ [MODEL_KEY]: { ...old[MODEL_KEY], newTab: { enabled: false } } });
  release();
  await tick();
  assert.equal((await f.api.tabs.get(tab.id)).url, 'about:newtab');
  const later = await f.api.tabs.create({ url: 'about:newtab' });
  await tick();
  assert.equal((await f.api.tabs.get(later.id)).url, 'about:newtab');
  assert.equal(f.reads(), 2);
  assert.equal(f.api.testing.saved[MODEL_KEY].newTab.enabled, false);
});
test('routing recovery keeps copied Home membership while routing a later fresh tab', async (t) => {
  const f = fixture(t);
  await tick();
  const tab = await f.api.tabs.create({ url: 'about:blank' });
  const membership = { treeId: 'restored', groupId: 'saved', ancestors: [], openedAt: Date.now() };
  await f.api.sessions.setTabValue(tab.id, TAB_KEY, membership);
  await f.api.tabs.update(tab.id, { url: 'about:newtab' });
  await tick();
  assert.equal((await f.api.tabs.get(tab.id)).url, 'about:newtab');
  assert.deepEqual(await f.api.sessions.getTabValue(tab.id, TAB_KEY), membership);
  const fresh = await f.api.tabs.create({ url: 'about:newtab' });
  await tick();
  assert.equal((await f.api.tabs.get(fresh.id)).url, f.api.runtime.getURL('new-tab.html?start=1'));
});

test('a recovered opt-out is cached without redirecting later native Home tabs', async (t) => {
  const f = fixture(t, false);
  await tick();
  const original = structuredClone(f.api.testing.saved);
  for (const windowId of [1, 2, 1]) {
    const tab = await f.api.tabs.create({ windowId, url: 'about:newtab' });
    await tick();
    assert.equal((await f.api.tabs.get(tab.id)).url, 'about:newtab');
  }
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.api.testing.saved, original);
});

test('routing recovers after the controller loads enabled preferences and assigns fresh memberships', async (t) => {
  const f = fixture(t);
  await tick();
  const original = structuredClone(f.api.testing.saved);
  const controller = createController(f.api, () => {}, {
    onFreshMembership: f.router.recordFreshMembership,
  });
  t.after(() => controller.dispose());
  const creations = [];
  f.api.testing.setCreatedHandler((tab) => creations.push(controller.created(tab)));
  assert.equal(
    (await controller.request({ type: 'getSettings', windowId: 1 })).newTab.enabled,
    true,
  );
  for (const windowId of [1, 2]) {
    const tab = await f.api.tabs.create({ windowId, url: 'about:newtab' });
    await Promise.all(creations.splice(0));
    await tick();
    assert.equal((await f.api.tabs.get(tab.id)).url, f.api.runtime.getURL('new-tab.html?start=1'));
    assert((await f.api.sessions.getTabValue(tab.id, TAB_KEY)).treeId);
  }
  assert.deepEqual(f.api.testing.saved, original);
});
