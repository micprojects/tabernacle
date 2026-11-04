import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { VIEW_KEY } from '../extension/src/model.js';

const cases = [
  ['scalar window view', 'future-view-format'],
  ['array window view', [{ future: 'retained' }]],
  ['scope format', { scopeId: { id: 'work', future: true } }],
  ['collapsed format', { collapsed: { ids: ['work'], future: true } }],
  ['collapsed record', { collapsed: [{ id: 'work', future: true }] }],
  ['visits format', { recentFolders: { entries: ['work'], future: true } }],
  ['visit record', { recentFolders: [{ id: 'work', enteredAt: { time: 1000 }, future: true }] }],
  ['expansions format', { recentExpandedFolders: { entries: ['work'], future: true } }],
  [
    'expansion record',
    { recentExpandedFolders: [{ id: 'work', expandedAt: 'future-time', future: true }] },
  ],
  ['layout format', { pinLayout: { entries: ['work'], future: true } }],
  ['layout record', { pinLayout: [{ kind: 'future-pin', id: 'retained', future: true }] }],
];
for (const [name, value] of cases)
  test(`unsupported ${name} cannot be discarded by ordinary navigation`, async (t) => {
    const api = memoryBrowser({
      groups: [{ id: 'work', name: 'Work', parentId: null }],
      tabs: [
        { id: 1, windowId: 1, index: 0 },
        { id: 2, windowId: 2, index: 0 },
      ],
    });
    const raw =
      value && typeof value === 'object' && !Array.isArray(value)
        ? { scopeId: null, collapsed: [], opaque: { retained: true }, ...value }
        : value;
    await api.sessions.setWindowValue(1, VIEW_KEY, raw);
    let controller = createController(api);
    t.after(() => controller.dispose());
    const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
    await assert.rejects(send('enterGroup', { id: 'work' }), /saved|unsupported|invalid/i);
    assert.deepEqual(await api.sessions.getWindowValue(1, VIEW_KEY), raw);
    await send('toggleGroup', { id: 'work' }, 2);
    assert.deepEqual(await api.sessions.getWindowValue(1, VIEW_KEY), raw);
    await controller.dispose();
    controller = createController(api);
    await assert.rejects(send('collapseAll', { collapsed: true }), /saved|unsupported|invalid/i);
    assert.deepEqual(await api.sessions.getWindowValue(1, VIEW_KEY), raw);
    await api.sessions.setWindowValue(1, VIEW_KEY, {
      scopeId: null,
      collapsed: [],
      opaque: 'retained',
    });
    await send('toggleGroup', { id: 'work' });
    assert.deepEqual(await api.sessions.getWindowValue(1, VIEW_KEY), {
      scopeId: null,
      collapsed: ['work'],
      opaque: 'retained',
    });
  });

test('legacy empty views and stale valid folder references remain readable and writable', async (t) => {
  const api = memoryBrowser({
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    tabs: [{ id: 1, windowId: 1, index: 0 }],
  });
  const controller = createController(api);
  t.after(() => controller.dispose());
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  for (const value of [
    undefined,
    null,
    {},
    {
      scopeId: 'deleted',
      collapsed: ['deleted'],
      recentFolders: [{ id: 'deleted', enteredAt: 1000 }],
      recentExpandedFolders: [{ id: 'deleted', expandedAt: 1000 }],
      pinLayout: [{ kind: 'tab', id: 'not-yet-restored', opaque: true }],
    },
  ]) {
    await api.sessions.setWindowValue(1, VIEW_KEY, value);
    assert.equal((await send('snapshot')).view.scopeId, null);
    assert.deepEqual(await api.sessions.getWindowValue(1, VIEW_KEY), value);
    await send('toggleGroup', { id: 'work' });
    const saved = await api.sessions.getWindowValue(1, VIEW_KEY);
    assert.deepEqual(saved.collapsed, ['work']);
    if (value?.pinLayout) assert.deepEqual(saved.pinLayout, value.pinLayout);
  }
});
