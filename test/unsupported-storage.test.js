import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY } from '../extension/src/model.js';

const cases = [
  ['null model', null],
  ['non-object model', 'unsupported saved state'],
  ['folder pin format', { folderPins: { version: 99, records: ['keep'] } }],
  ['folder pin action', { folderPins: [{ id: 'work', action: 'future-action', opaque: 'keep' }] }],
  ['orphan folder pin', { folderPins: [{ id: 'future-folder', action: 'open', opaque: 'keep' }] }],
  [
    'duplicate folder pins',
    {
      folderPins: [
        { id: 'work', action: 'open' },
        { id: 'work', action: 'reveal', opaque: 'keep' },
      ],
    },
  ],
  ['domain pin format', { domainPins: { version: 99, records: ['keep'] } }],
  [
    'domain pin record',
    { domainPins: ['example.test', { domain: 'future.test', opaque: 'keep' }] },
  ],
  ['duplicate domain pins', { domainPins: ['example.test', 'example.test'] }],
];

for (const [name, value] of cases)
  test(`unsupported ${name} cannot be overwritten by a model edit and remains retryable`, async (t) => {
    const api = memoryBrowser({
      groups: [{ id: 'work', name: 'Work', parentId: null }],
      tabs: [
        { id: 1, windowId: 1, index: 0 },
        { id: 2, windowId: 2, index: 0 },
      ],
    });
    const valid = structuredClone(api.testing.saved[MODEL_KEY]);
    const stored =
      value && typeof value === 'object'
        ? { ...valid, ...value, opaque: { retained: true } }
        : value;
    api.testing.saved[MODEL_KEY] = structuredClone(stored);
    const before = structuredClone(api.testing.saved);
    const native = await api.tabs.query({});
    const memberships = structuredClone(api.testing.tabValues);
    let controller = createController(api);
    t.after(() => controller.dispose());
    const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
    await assert.rejects(
      send('createGroup', { name: 'Must not save' }),
      /saved|unsupported|newer|invalid/i,
    );
    assert.deepEqual(api.testing.saved, before);
    await assert.rejects(send('snapshot', {}, 2), /saved|unsupported|newer|invalid/i);
    await assert.rejects(send('closeTab', { id: 1 }), /saved|unsupported|newer|invalid/i);
    assert.deepEqual(api.testing.saved, before);
    assert.deepEqual(await api.tabs.query({}), native);
    assert.deepEqual(api.testing.tabValues, memberships);
    await controller.dispose();
    controller = createController(api);
    await assert.rejects(
      send('renameGroup', { id: 'work', name: 'Must not save' }),
      /saved|unsupported|newer|invalid/i,
    );
    assert.deepEqual(api.testing.saved, before);
    // Model a later successful recovery by its owner. A failed load must not
    // poison the controller or require resetting unrelated stored state.
    api.testing.saved[MODEL_KEY] = valid;
    await send('renameGroup', { id: 'work', name: 'Recovered' }, 2);
    assert.equal(api.testing.saved[MODEL_KEY].groups[0].name, 'Recovered');
  });
