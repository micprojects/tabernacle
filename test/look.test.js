import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

async function fixture(settings = {}) {
  const groups = [{ id: 'work', name: 'Work', parentId: null }];
  const api = memoryBrowser({
    groups,
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'First window' },
      { id: 2, windowId: 2, index: 0, title: 'Second window' },
    ],
  });
  // Seed storage directly so the normal serializer cannot hide migration errors.
  await api.storage.local.set({
    [MODEL_KEY]: { version: 1, groups, compact: true, ...settings },
  });
  const changes = [];
  const controller = createController(api, (change) => changes.push(change));
  return {
    api,
    changes,
    controller,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),
  };
}

test('retired appearance and density selections preserve Look preferences and are removed on the next save', async () => {
  const look = { connectingLines: true, domains: false };
  for (const appearance of ['whitespace', 'colourful', 'outline', 'combined', 'unknown']) {
    const { api, send, controller } = await fixture({
      appearance,
      combinedLook: look,
      compact: false,
    });
    const before = await api.storage.local.get(MODEL_KEY);
    const state = await send('snapshot');
    assert.deepEqual(state.look, { ...look, colorScheme: 'default' });
    assert.equal(Object.hasOwn(state, 'appearance'), false);
    assert.equal(Object.hasOwn(state, 'combinedLook'), false);
    assert.equal(Object.hasOwn(state, 'compact'), false);
    assert.deepEqual(await api.storage.local.get(MODEL_KEY), before);
    await send('setLook', { value: state.look });
    const saved = api.testing.saved[MODEL_KEY];
    assert.deepEqual(saved.look, { ...look, colorScheme: 'default' });
    assert.deepEqual(saved.groups, before[MODEL_KEY].groups);
    assert.equal(Object.hasOwn(saved, 'appearance'), false);
    assert.equal(Object.hasOwn(saved, 'combinedLook'), false);
    assert.equal(Object.hasOwn(saved, 'compact'), false);
    controller.dispose();
    const restarted = createController(api);
    assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).look, {
      ...look,
      colorScheme: 'default',
    });
    restarted.dispose();
  }
});

test('Look defaults missing or malformed preferences independently, with current settings taking precedence', async () => {
  for (const [settings, expected] of [
    [{}, { connectingLines: true, domains: false }],
    [{ look: null }, { connectingLines: true, domains: false }],
    [{ look: { colorScheme: 'invalid' } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: 'true' } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: true } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: false } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: 'true' } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: true } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: false } }, { connectingLines: true, domains: false }],
    [
      { look: { colorScheme: 'dark' } },
      { connectingLines: true, domains: false, colorScheme: 'dark' },
    ],
    [
      { look: { connectingLines: true, domains: 'true' } },
      { connectingLines: true, domains: false },
    ],
    [
      { combinedLook: { connectingLines: 1, domains: true } },
      { connectingLines: true, domains: true },
    ],
    [
      {
        look: { connectingLines: false, domains: false },
        combinedLook: { connectingLines: true, domains: true },
      },
      { connectingLines: false, domains: false },
    ],
  ]) {
    const { api, send, controller } = await fixture(settings);
    const before = await api.storage.local.get(MODEL_KEY);
    const look = (await send('snapshot')).look;
    assert.deepEqual(look, {
      colorScheme: 'default',
      ...expected,
    });
    assert.deepEqual(await api.storage.local.get(MODEL_KEY), before);
    const saved = await send('setLook', {
      value: { ...settings.look, ...look },
    });
    assert.deepEqual(saved.look, look);
    assert.deepEqual(api.testing.saved[MODEL_KEY].look, look);
    controller.dispose();
  }
});

test('Look preferences persist across windows and restarts without changing groups or tabs', async () => {
  const { api, send, changes, controller } = await fixture();
  await send('enterGroup', { id: 'work' });
  const before = await send('snapshot');
  for (const value of [
    { connectingLines: true, domains: false, colorScheme: 'light' },
    { connectingLines: false, domains: true, colorScheme: 'dark' },
    { connectingLines: true, domains: true, colorScheme: 'default' },
    { connectingLines: false, domains: false, colorScheme: 'dark' },
  ]) {
    const saved = await send('setLook', { value });
    assert.deepEqual(saved.look, value);
    assert.deepEqual(api.testing.saved[MODEL_KEY].look, value);
    assert.equal(changes.at(-1).windowId, undefined);
    assert.deepEqual((await send('snapshot', {}, 2)).look, value);
    assert.deepEqual(saved.groups, before.groups);
    assert.deepEqual(saved.tabs, before.tabs);
    assert.deepEqual(saved.view, before.view);
  }
  const value = {
    connectingLines: true,
    domains: false,
    colorScheme: 'dark',
  };
  await send('setLook', { value });
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).look, value);
  restarted.dispose();
});

test('invalid and failed Look saves leave preferences intact and retired appearance actions are unavailable', async () => {
  const { api, send, changes, controller } = await fixture();
  const before = await api.storage.local.get(MODEL_KEY);
  await assert.rejects(send('setAppearance', { value: 'outline' }), /Unknown Tabernacle action/);
  await assert.rejects(send('setCompact', { value: false }), /Unknown Tabernacle action/);
  for (const value of [undefined, null, {}, true, { connectingLines: true, domains: 'false' }])
    await assert.rejects(send('setLook', { value }), /Choose whether/);
  for (const colorScheme of [null, true, 'system', 'invalid'])
    await assert.rejects(
      send('setLook', { value: { connectingLines: true, domains: true, colorScheme } }),
      /Choose Default/,
    );
  api.storage.local.set = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(
    send('setLook', { value: { connectingLines: true, domains: true } }),
    /Storage unavailable/,
  );
  assert.deepEqual(await api.storage.local.get(MODEL_KEY), before);
  assert.deepEqual((await send('snapshot')).look, {
    connectingLines: true,
    domains: false,
    colorScheme: 'default',
  });
  assert.equal(changes.length, 0);
  controller.dispose();
});
