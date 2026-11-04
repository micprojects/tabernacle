import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, VIEW_KEY } from '../extension/src/model.js';
import { normalizePinLayout, reconcilePins } from '../extension/src/pinned-items.js';
import { pinMoveMessage } from './helpers/pin-move.js';

test('folder-pin metadata survives unrelated writes, action changes, reorder recovery and restart', async (t) => {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'other', name: 'Other', parentId: null },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0 },
      { id: 2, windowId: 2, index: 0 },
    ],
  });
  const pins = [
    { id: 'work', action: 'reveal', opaque: { value: 'work' } },
    { id: 'other', action: 'open', opaque: { value: 'other' } },
  ];
  api.testing.saved[MODEL_KEY].folderPins = structuredClone(pins);
  const layout = pins.map((pin) => ({ kind: 'group', id: pin.id, opaque: { slot: pin.id } }));
  api.testing.windowValues.set(1, {
    scopeId: null,
    collapsed: [],
    pinLayout: structuredClone(layout),
  });
  let controller = createController(api);
  t.after(() => controller.dispose());
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  await send('renameGroup', { id: 'work', name: 'Renamed' });
  assert.deepEqual(api.testing.saved[MODEL_KEY].folderPins, pins);
  assert.deepEqual(api.testing.windowValues.get(1).pinLayout, layout);
  const setModel = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Write unavailable');
  };
  await assert.rejects(send('setGroupPin', { id: 'work', action: 'open' }), /Write unavailable/);
  assert.deepEqual(api.testing.saved[MODEL_KEY].folderPins, pins);
  api.storage.local.set = setModel;
  await send('setGroupPin', { id: 'work', action: 'open' }, 2);
  pins[0].action = 'open';
  assert.deepEqual(api.testing.saved[MODEL_KEY].folderPins, pins);
  const state = await send('snapshot');
  const message = pinMoveMessage(
    state,
    { kind: 'group', id: 'other' },
    { kind: 'group', id: 'work' },
  );
  const setView = api.sessions.setWindowValue;
  api.sessions.setWindowValue = async (...args) => {
    if (args[1] === VIEW_KEY) throw new Error('Layout unavailable');
    return setView(...args);
  };
  await assert.rejects(send('moveItem', message), /could not finish recovery/);
  api.sessions.setWindowValue = setView;
  await controller.dispose();
  controller = createController(api);
  await send('snapshot', {}, 2);
  await send('moveItem', message);
  assert.deepEqual(api.testing.saved[MODEL_KEY].folderPins, [pins[1], pins[0]]);
  assert.deepEqual(api.testing.windowValues.get(1).pinLayout, [layout[1], layout[0]]);
  await send('setGroupPin', { id: 'work', action: null });
  assert.deepEqual(api.testing.saved[MODEL_KEY].folderPins, [pins[1]]);
  assert.deepEqual(api.testing.windowValues.get(1).pinLayout, [layout[1]]);
});

test('mixed pin metadata follows its identity through reorder and delayed restoration', () => {
  const saved = [
    { kind: 'group', id: 'work', opaque: { value: 'work' } },
    { kind: 'tab', id: 'one', opaque: { value: 'one' } },
    { kind: 'group', id: 'other', opaque: { value: 'other' } },
    { kind: 'tab', id: 'two', opaque: { value: 'two' } },
  ];
  assert.deepEqual(normalizePinLayout(saved), saved);
  const folders = [{ id: 'other' }, { id: 'work' }];
  const tabs = [
    { treeId: 'two', pinned: true, index: 0 },
    { treeId: 'one', pinned: true, index: 1 },
  ];
  assert.deepEqual(reconcilePins(saved, folders, tabs).layout, [
    saved[2],
    saved[3],
    saved[0],
    saved[1],
  ]);
  assert.deepEqual(reconcilePins(saved, folders, [tabs[0]]).layout, [
    saved[2],
    saved[1],
    saved[0],
    saved[3],
  ]);
  assert.deepEqual(reconcilePins(saved, folders, [tabs[0]], new Set(['one'])).layout, [
    saved[2],
    saved[0],
    saved[3],
  ]);
});
