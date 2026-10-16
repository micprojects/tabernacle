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
  const look = {
    connectingLines: true,
    domains: false,
    folderCounts: false,
    tintFavicons: false,
    animations: true,
  };
  for (const appearance of ['whitespace', 'colourful', 'outline', 'combined', 'unknown']) {
    const { api, send, controller } = await fixture({
      appearance,
      combinedLook: look,
      compact: false,
    });
    const before = await api.storage.local.get(MODEL_KEY);
    const state = await send('snapshot');
    assert.deepEqual(state.look, { ...look, themeSource: 'tabernacle', colorScheme: 'default' });
    assert.equal(Object.hasOwn(state, 'appearance'), false);
    assert.equal(Object.hasOwn(state, 'combinedLook'), false);
    assert.equal(Object.hasOwn(state, 'compact'), false);
    assert.deepEqual(await api.storage.local.get(MODEL_KEY), before);
    await send('setLook', { value: state.look });
    const saved = api.testing.saved[MODEL_KEY];
    assert.deepEqual(saved.look, { ...look, themeSource: 'tabernacle', colorScheme: 'default' });
    assert.deepEqual(saved.groups, before[MODEL_KEY].groups);
    assert.equal(Object.hasOwn(saved, 'appearance'), false);
    assert.equal(Object.hasOwn(saved, 'combinedLook'), false);
    assert.equal(Object.hasOwn(saved, 'compact'), false);
    controller.dispose();
    const restarted = createController(api);
    assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).look, {
      ...look,
      themeSource: 'tabernacle',
      colorScheme: 'default',
    });
    restarted.dispose();
  }
});

test('Look defaults missing or malformed preferences independently, with current settings taking precedence', async () => {
  for (const [settings, expected] of [
    [{}, { connectingLines: true, domains: false }],
    [{ look: null }, { connectingLines: true, domains: false }],
    [{ look: { colorLabels: 'true' } }, { connectingLines: true, domains: false }],
    [{ look: { colorLabels: true } }, { connectingLines: true, domains: false }],
    [{ look: { colorLabels: false } }, { connectingLines: true, domains: false }],
    [{ look: { tintFavicons: 'true' } }, { connectingLines: true, domains: false }],
    [
      { look: { tintFavicons: true } },
      { connectingLines: true, domains: false, tintFavicons: true },
    ],
    [{ look: { animations: false } }, { connectingLines: true, domains: false, animations: false }],
    [{ look: { animations: 'false' } }, { connectingLines: true, domains: false }],
    [{ look: { folderCounts: 'true' } }, { connectingLines: true, domains: false }],
    [
      { look: { folderCounts: true } },
      { connectingLines: true, domains: false, folderCounts: true },
    ],
    [{ look: { colorScheme: 'invalid' } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: 'true' } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: true } }, { connectingLines: true, domains: false }],
    [{ look: { centerNewTab: false } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: 'true' } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: true } }, { connectingLines: true, domains: false }],
    [{ look: { leftAlignNewTab: false } }, { connectingLines: true, domains: false }],
    [
      { look: { themeSource: 'firefox', colorScheme: 'dark' } },
      { connectingLines: true, domains: false, themeSource: 'firefox', colorScheme: 'dark' },
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
      animations: true,
      folderCounts: false,
      tintFavicons: false,
      themeSource: 'tabernacle',
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
    { connectingLines: true, domains: false, themeSource: 'firefox', colorScheme: 'light' },
    { connectingLines: false, domains: true, themeSource: 'firefox', colorScheme: 'dark' },
    { connectingLines: true, domains: true, themeSource: 'firefox', colorScheme: 'default' },
    { connectingLines: false, domains: false, themeSource: 'firefox', colorScheme: 'dark' },
  ].map((value) => ({
    animations: true,
    folderCounts: false,
    tintFavicons: false,
    ...value,
  }))) {
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
    animations: true,
    folderCounts: false,
    tintFavicons: false,
    connectingLines: true,
    domains: false,
    themeSource: 'firefox',
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
      /Choose Automatic/,
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
    animations: true,
    folderCounts: false,
    tintFavicons: false,
    connectingLines: true,
    domains: false,
    themeSource: 'tabernacle',
    colorScheme: 'default',
  });
  assert.equal(changes.length, 0);
  controller.dispose();
});

test('theme source saves across windows and restarts, with failed saves retaining the prior source', async () => {
  const { api, send, controller } = await fixture({
    look: { themeSource: 'tabernacle', colorScheme: 'dark' },
  });
  const original = (await send('snapshot')).look;
  assert.equal(original.themeSource, 'tabernacle');
  const value = { ...original, themeSource: 'firefox' };
  await send('setLook', { value });
  assert.deepEqual((await send('snapshot', {}, 2)).look, value);
  assert.equal(api.testing.saved[MODEL_KEY].look.themeSource, 'firefox');
  const set = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(send('setLook', { value: original }), /Storage unavailable/);
  assert.deepEqual((await send('snapshot', {}, 2)).look, value);
  api.storage.local.set = set;
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).look, value);
  restarted.dispose();
});

test('settings updates merge only edited fields across windows and reject invalid partial changes', async () => {
  const { send, controller, changes } = await fixture();
  const before = (await send('getSettings')).look;
  assert.deepEqual(Object.keys(await send('getSettings')), ['look']);
  await send('setLook', { partial: true, value: { domains: true } }, 2);
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  const saved = { ...before, domains: true, colorScheme: 'dark' };
  assert.deepEqual((await send('getSettings')).look, saved);
  assert.equal(changes.at(-1).windowId, undefined);
  await assert.rejects(
    send('setLook', { partial: true, value: { domains: 'true' } }),
    /Choose whether/,
  );
  assert.deepEqual((await send('getSettings', {}, 2)).look, saved);
  controller.dispose();
});

test('folder tab counts default off and persist independently across windows and restarts', async () => {
  const { api, send, controller } = await fixture();
  const before = (await send('getSettings')).look;
  assert.equal(before.folderCounts, false);
  await send('setLook', { partial: true, value: { folderCounts: true } });
  const expected = { ...before, folderCounts: true };
  assert.deepEqual((await send('getSettings', {}, 2)).look, expected);
  assert.deepEqual(api.testing.saved[MODEL_KEY].look, expected);
  for (const folderCounts of [null, 'true', 1]) {
    await assert.rejects(
      send('setLook', { partial: true, value: { folderCounts } }),
      /Choose whether to show folder tab counts/,
    );
    assert.deepEqual((await send('getSettings')).look, expected);
  }
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual((await restarted.request({ type: 'getSettings', windowId: 1 })).look, expected);
  await restarted.request({
    type: 'setLook',
    windowId: 1,
    partial: true,
    value: { folderCounts: false },
  });
  assert.deepEqual((await restarted.request({ type: 'getSettings', windowId: 2 })).look, before);
  restarted.dispose();
});

test('animation preference persists across windows and restarts and rejects invalid values', async () => {
  const { api, send, controller } = await fixture();
  const before = (await send('getSettings')).look;
  assert.equal(before.animations, true);
  await send('setLook', { partial: true, value: { animations: false } });
  const expected = { ...before, animations: false };
  assert.deepEqual((await send('getSettings', {}, 2)).look, expected);
  assert.deepEqual(api.testing.saved[MODEL_KEY].look, expected);
  for (const animations of [null, 'false', 0])
    await assert.rejects(
      send('setLook', { partial: true, value: { animations } }),
      /Choose whether to show animations/,
    );
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual((await restarted.request({ type: 'getSettings', windowId: 1 })).look, expected);
  restarted.dispose();
});

test('favicon tint defaults off and persists across windows and restarts', async () => {
  const { api, send, controller } = await fixture();
  const before = (await send('getSettings')).look;
  assert.equal(before.tintFavicons, false);
  await send('setLook', { partial: true, value: { tintFavicons: true } });
  const expected = { ...before, tintFavicons: true };
  assert.deepEqual((await send('getSettings', {}, 2)).look, expected);
  assert.deepEqual(api.testing.saved[MODEL_KEY].look, expected);
  for (const tintFavicons of [null, 'true', 1])
    await assert.rejects(
      send('setLook', { partial: true, value: { tintFavicons } }),
      /Choose whether to tint website icons/,
    );
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual((await restarted.request({ type: 'getSettings', windowId: 1 })).look, expected);
  await restarted.request({
    type: 'setLook',
    windowId: 1,
    partial: true,
    value: { tintFavicons: false },
  });
  assert.deepEqual((await restarted.request({ type: 'getSettings', windowId: 2 })).look, before);
  restarted.dispose();
});
