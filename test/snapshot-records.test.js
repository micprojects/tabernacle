import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { performanceFixture, performanceBrowser } from '../preview/performance-fixture.js';
import {
  createPresentationCache,
  immutableCopy,
  isPlainPresentation,
} from '../extension/src/presentation-cache.js';

function fixture(t, prepare = () => {}) {
  const setup = performanceFixture({ tabs: 100, windows: 2 });
  setup.tabs[0].futureNativeField = {
    nested: [{ value: 'preserved' }],
    longUrl: 'https://example.test/' + 'path/'.repeat(1000),
  };
  setup.groups[0].futureGroupField = { nested: ['preserved'] };
  prepare(setup);
  const f = performanceBrowser(setup);
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  return {
    ...f,
    setup,
    controller,
    read: () => controller.requestForTransport({ type: 'snapshot', windowId: 1 }),
    publicRead: (args = {}) => controller.request({ type: 'snapshot', windowId: 1, ...args }),
  };
}

test('transport snapshots reuse every unchanged presentation row and array', async (t) => {
  const f = fixture(t);
  const first = await f.read();
  const second = await f.read();
  for (const key of [
    'tabs',
    'groups',
    'folderPins',
    'domainPins',
    'pins',
    'containers',
    'recentlyClosed',
  ])
    assert.equal(second[key], first[key], key);
  assert.equal(second.view, first.view);
  assert.equal(second.look, first.look);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.tabs));
  assert(Object.isFrozen(first.tabs[0]));
  assert(Object.isFrozen(first.tabs[0].futureNativeField));
  assert(Object.isFrozen(first.tabs[0].futureNativeField.nested[0]));
  assert.equal(Object.isFrozen(f.native.get(1).futureNativeField), false);
  assert.equal(Object.isFrozen(f.saved['tabernacle.model.v1'].groups[0]), false);
  assert.equal(isPlainPresentation(first), true);
  assert.throws(() => {
    first.tabs[0].futureNativeField.nested[0].value = 'changed';
  }, TypeError);
  assert.equal(
    first.tabs[0].futureNativeField.longUrl.length,
    f.native.get(1).futureNativeField.longUrl.length,
  );
});

test('one metadata change replaces one immutable row and preserves older snapshots', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  await f.api.tabs.update(1, { title: 'A new title' });
  const after = await f.read();
  assert.notEqual(after.tabs, before.tabs);
  assert.equal(after.tabs.filter((tab, i) => tab !== before.tabs[i]).length, 1);
  assert.notEqual(before.tabs[0].title, after.tabs[0].title);
  assert.deepEqual(after.tabs[0].futureNativeField, before.tabs[0].futureNativeField);
  assert.equal(after.groups, before.groups);
  assert.equal(after.view, before.view);
  assert(Object.isFrozen(after.tabs[0].futureNativeField.nested));
});

test('unchanged pin snapshots avoid rescanning tabs without caching session reads', async (t) => {
  const f = fixture(t);
  const first = await f.read();
  await f.read();
  let scans = 0;
  const filter = Array.prototype.filter;
  Array.prototype.filter = function (...args) {
    if (this === first.tabs) scans++;
    return filter.apply(this, args);
  };
  try {
    assert.equal((await f.read()).pins, first.pins);
    assert.equal(scans, 0, 'Unchanged pins do not scan every tab');
  } finally {
    Array.prototype.filter = filter;
  }
  const get = f.api.sessions.getWindowValue;
  f.api.sessions.getWindowValue = async () => {
    throw new Error('Window session unavailable');
  };
  await assert.rejects(f.read(), /Window session unavailable/);
  f.api.sessions.getWindowValue = get;
  assert.deepEqual((await f.read()).pins, first.pins);

  await f.api.tabs.update(1, { pinned: false });
  const after = await f.read();
  assert(!after.pins.some((pin) => pin.id === first.tabs[0].treeId));
  assert(first.pins.some((pin) => pin.id === first.tabs[0].treeId));
});

test('warm pin snapshots honour new session layouts and retry failed reconciliation writes', async (t) => {
  const f = fixture(t);
  const id = f.setup.groups[0].id;
  await f.controller.request({ type: 'setGroupPin', windowId: 1, id, action: 'open' });
  const before = await f.read();
  await f.read();
  const group = { kind: 'group', id };
  const waiting = { kind: 'tab', id: 'not-restored-yet' };
  await f.api.sessions.setWindowValue(1, 'tabernacle.view.v1', {
    ...before.view,
    pinLayout: [waiting, group],
  });
  const save = f.api.sessions.setWindowValue;
  f.api.sessions.setWindowValue = async () => {
    throw new Error('Pin layout save failed');
  };
  await assert.rejects(f.read(), /Pin layout save failed/);
  f.api.sessions.setWindowValue = save;
  const after = await f.read();
  assert.deepEqual(after.pins[0], group);
  assert.deepEqual(after.view.pinLayout.slice(0, 2), [waiting, group]);
  assert(!after.pins.some((pin) => pin.id === waiting.id));
  assert.deepEqual((await f.read()).pins, after.pins);
  const other = await f.controller.request({ type: 'snapshot', windowId: 2 });
  assert.notDeepEqual(other.pins, after.pins);
  assert.deepEqual((await f.read()).pins, after.pins);
});

test('transport clones no unchanged tab rows and only one changed metadata row', async (t) => {
  const f = fixture(t);
  await f.read();
  const clone = globalThis.structuredClone;
  const freeze = Object.freeze;
  let rowCopies = 0;
  let snapshotCopies = 0;
  Object.freeze = (value) => {
    if (value?.id !== undefined && value?.treeId) rowCopies++;
    return freeze(value);
  };
  globalThis.structuredClone = (value, options) => {
    if (value?.generation && value?.tabs) snapshotCopies++;
    return clone(value, options);
  };
  try {
    await f.read();
    assert.equal(rowCopies, 0);
    assert.equal(snapshotCopies, 0);
    await f.api.tabs.update(1, { title: 'Changed once' });
    await f.read();
    assert.equal(rowCopies, 1);
    assert.equal(snapshotCopies, 0);
    await f.publicRead();
    assert.equal(snapshotCopies, 1, 'the public API always makes an independent full copy');
  } finally {
    globalThis.structuredClone = clone;
    Object.freeze = freeze;
  }
});

test('public snapshots remain detached and writable, including unknown nested native fields', async (t) => {
  const f = fixture(t);
  const immutable = await f.read();
  const first = await f.publicRead();
  const second = await f.publicRead({
    transport: true,
    immutable: true,
    requestForTransport: true,
  });
  assert.notEqual(first.tabs, second.tabs);
  assert.notEqual(first.tabs[0], second.tabs[0]);
  assert.equal(Object.isFrozen(first), false);
  assert.equal(
    Object.isFrozen(second.tabs[0]),
    false,
    'message fields cannot select transport mode',
  );
  first.tabs[0].futureNativeField.nested[0].value = 'caller mutation';
  first.tabs[0].ancestors.push('caller ancestor');
  first.tabs[0].mutedInfo.muted = true;
  first.groups[0].futureGroupField.nested.length = 0;
  first.view.collapsed.push('caller folder');
  first.tabs.length = 0;
  assert.deepEqual(await f.publicRead(), second);
  assert.equal(immutable.tabs[0].futureNativeField.nested[0].value, 'preserved');
  assert.equal(f.native.get(1).futureNativeField.nested[0].value, 'preserved');
});

test('transport and public actions share queue ordering and preserve new-tab preferences', async (t) => {
  const f = fixture(t);
  await f.read();
  const first = f.controller.requestForTransport({ type: 'toggleTab', windowId: 1, id: 1 });
  const second = f.controller.request({ type: 'toggleTab', windowId: 1, id: 1 });
  assert.equal((await first).tabs[0].collapsed, false);
  assert.equal((await second).tabs[0].collapsed, true);
  const page = await f.controller.requestForTransport({ type: 'getNewTabState', windowId: 1 });
  assert(page.newTab);
  assert(Object.isFrozen(page.newTab));
  assert.equal(page.tabs, (await f.read()).tabs);
});

test('presentation records preserve complete native URLs and membership ancestry', async (t) => {
  const url = `https://example.test/${'long-path/'.repeat(2000)}?q=full#fragment`;
  const ancestors = Array.from({ length: 500 }, (_, i) => `restoring-ancestor-${i}`);
  const f = fixture(t, (setup) => {
    setup.tabs[0].url = url;
    setup.memberships.get(1).ancestors = ancestors;
  });
  const state = await f.read();
  assert.equal(state.tabs[0].url, url);
  assert.deepEqual(state.tabs[0].ancestors, ancestors);
  assert.equal((await f.publicRead()).tabs[0].url, url);
});

test('unexpected structured-clone types stay detached and never poison later transport replies', async (t) => {
  const f = fixture(t, (setup) => {
    setup.tabs[0].futureNativeField = {
      map: new Map([['saved', { value: 1 }]]),
      set: new Set(['saved']),
      date: new Date('2026-01-01T00:00:00Z'),
      bytes: new Uint8Array([3, 5, 7]),
      buffer: new Uint8Array([11, 13]).buffer,
    };
  });
  const first = await f.read();
  assert.equal(isPlainPresentation(first), false);
  const field = first.tabs[0].futureNativeField;
  field.map.get('saved').value = 99;
  field.set.add('caller');
  field.date.setFullYear(1999);
  field.bytes[0] = 99;
  new Uint8Array(field.buffer)[0] = 99;
  first.tabs.length = 0;
  const next = await f.read();
  assert.deepEqual(next.tabs[0].futureNativeField, f.native.get(1).futureNativeField);
  assert.notEqual(next.tabs[0].futureNativeField.bytes, f.native.get(1).futureNativeField.bytes);
  const ordinary = await f.publicRead();
  ordinary.tabs[0].futureNativeField.map.clear();
  assert.equal((await f.read()).tabs[0].futureNativeField.map.size, 1);
  await f.api.tabs.update(1, { futureNativeField: { bytes: new Uint8Array([17, 19]) } });
  assert.deepEqual((await f.read()).tabs[0].futureNativeField.bytes, new Uint8Array([17, 19]));
});

test('non-snapshot transport responses are immutable while public responses remain writable', async (t) => {
  const f = fixture(t);
  const message = { type: 'getContainers', windowId: 1 };
  const transport = await f.controller.requestForTransport(message);
  assert(Object.isFrozen(transport));
  assert(Object.isFrozen(transport.containers));
  assert(Object.isFrozen(transport.containers[0]));
  const mutable = await f.controller.request(message);
  mutable.containers[0].name = 'Caller changed';
  mutable.containers.length = 0;
  assert.deepEqual(await f.controller.requestForTransport(message), transport);
  assert.equal(Object.isFrozen(f.setup.containers[0]), false);
});

test('container changes replace affected rows and retain unrelated presentation rows', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  const identity = f.setup.containers[0];
  identity.name = 'Renamed identity';
  identity.colorCode = '#123456';
  f.api.contextualIdentities.onUpdated.emit({ contextualIdentity: structuredClone(identity) });
  const after = await f.read();
  for (const [index, tab] of after.tabs.entries()) {
    if (tab.cookieStoreId === identity.cookieStoreId) {
      assert.notEqual(tab, before.tabs[index]);
      assert.deepEqual(tab.container, { name: identity.name, colorCode: identity.colorCode });
    } else assert.equal(tab, before.tabs[index]);
  }
  assert.equal((await f.read()).tabs, after.tabs);
});

test('window removal and disposal drop retained derived presentation fields', async (t) => {
  const f = fixture(t);
  await f.read();
  await f.controller.requestForTransport({ type: 'snapshot', windowId: 2 });
  assert.equal(f.controller.cacheStats().presentationWindows, 2);
  const ids = [...f.native.values()].filter((tab) => tab.windowId === 2).map((tab) => tab.id);
  await f.api.tabs.remove(ids);
  f.closeWindow(2);
  assert.equal(f.controller.cacheStats().presentationWindows, 1);
  await f.controller.dispose();
  assert(Object.values(f.controller.cacheStats()).every((value) => value === 0));
});

test('plain presentation eligibility preserves cloneable primitives and rejects cycles or exotic values', () => {
  const shared = { scalar: 42n, missing: undefined, number: NaN, negativeZero: -0 };
  const source = { first: shared, second: shared };
  assert.equal(isPlainPresentation(source), true);
  const copy = immutableCopy(source);
  assert.equal(copy.first, copy.second);
  assert.deepEqual(copy, source);
  assert(Object.isFrozen(copy.first));
  assert.equal(isPlainPresentation(copy), true);
  source.first.future = new Date();
  assert.equal(isPlainPresentation(source), false, 'mutable inputs are never eligibility-memoised');
  for (const value of [new Map(), new Set(), new Date(), new Uint8Array(), /a/, Symbol(), () => {}])
    assert.equal(isPlainPresentation({ value }), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isPlainPresentation(cyclic), false);
  const immutableCycle = immutableCopy(cyclic);
  assert.equal(immutableCycle.self, immutableCycle);
  assert(Object.isFrozen(immutableCycle));
  assert.equal(isPlainPresentation(immutableCycle), false);
});

test('plain cyclic native fields retain safe immutable sharing and force full transfer eligibility', async (t) => {
  const f = fixture(t, (setup) => {
    setup.tabs[0].futureNativeField.self = setup.tabs[0].futureNativeField;
  });
  const first = await f.read();
  const second = await f.read();
  assert.equal(second.tabs, first.tabs);
  assert.equal(first.tabs[0].futureNativeField.self, first.tabs[0].futureNativeField);
  assert.equal(isPlainPresentation(first), false);
  const detached = await f.publicRead();
  detached.tabs[0].futureNativeField.nested[0].value = 'changed';
  assert.equal((await f.read()).tabs[0].futureNativeField.nested[0].value, 'preserved');
});

test('a disposed presentation cache releases its brands and retained window fields', () => {
  const cache = createPresentationCache();
  const source = { value: { nested: true } };
  const field = cache.field(1, 'view', source);
  const snapshot = cache.snapshot({ view: field });
  assert(cache.ownsSnapshot(snapshot));
  cache.dispose();
  assert.equal(cache.size(), 0);
  assert.equal(cache.ownsSnapshot(snapshot), false);
  assert.notEqual(cache.record(source), field);
  assert(Object.isFrozen(snapshot.view.value));
});

test('plain cloning matches structuredClone for sparse arrays, null prototypes and own special keys', () => {
  const shared = Object.assign(Object.create(null), { kept: [1n, undefined, NaN, -0] });
  const array = new Array(4);
  array[1] = shared;
  array.extra = shared;
  const source = { array, shared };
  source.self = source;
  Object.defineProperty(source, '__proto__', { value: shared, enumerable: true });
  source[Symbol('ignored')] = 'not transferred';
  Object.defineProperty(source, 'hidden', { value: 'not transferred', enumerable: false });
  const copy = immutableCopy(source);
  assert.deepEqual(copy, structuredClone(source));
  assert.equal(Object.getPrototypeOf(copy.shared), Object.prototype);
  assert(Object.hasOwn(copy, '__proto__'));
  assert.equal(copy.__proto__, copy.shared);
  assert.equal(0 in copy.array, false);
  assert.equal(copy.array.length, 4);
  assert.equal(copy.array.extra, copy.shared);
  assert.equal(copy.self, copy);
  assert.equal(Object.getOwnPropertySymbols(copy).length, 0);
  assert.equal(Object.hasOwn(copy, 'hidden'), false);
  assert(Object.isFrozen(copy.array));
  assert.equal(Object.isFrozen(source.array), false);
  assert.throws(() => immutableCopy({ unsupported: () => {} }), { name: 'DataCloneError' });
  assert.throws(() => immutableCopy({ unsupported: Symbol() }), { name: 'DataCloneError' });
});

test('derived fields distinguish aliased objects from equal but separate objects', () => {
  const cache = createPresentationCache();
  const shared = { value: true };
  const first = cache.field(1, 'view', { left: shared, right: shared });
  const source = { left: first.left, right: { value: true } };
  const second = cache.field(1, 'view', source);
  assert.notEqual(second, first);
  assert.notEqual(second.left, second.right);
  assert.equal(first.left, first.right);
  assert.deepEqual(second, structuredClone(source));
});

test('unchanged containerless rows need no graph-comparison maps on metadata refresh', () => {
  const cache = createPresentationCache();
  const source = Array.from({ length: 100 }, (_, id) => ({ id, title: `Tab ${id}` }));
  const before = cache.tabs(source, []);
  const NativeWeakMap = globalThis.WeakMap;
  let allocations = 0;
  globalThis.WeakMap = class extends NativeWeakMap {
    constructor(...args) {
      super(...args);
      allocations++;
    }
  };
  let unchanged;
  try {
    // A fresh list can contain the same adopted rows after a metadata refresh.
    unchanged = cache.tabs([...before], []);
  } finally {
    globalThis.WeakMap = NativeWeakMap;
  }
  assert.equal(allocations, 0);
  assert(unchanged.every((row, index) => row === before[index]));
  const after = cache.tabs([{ ...before[0], title: 'Changed' }, ...before.slice(1)], []);
  assert.equal(after[0].title, 'Changed');
  assert.equal(before[0].title, 'Tab 0');
  assert(after.slice(1).every((row, index) => row === before[index + 1]));
});

test('accessor fallback invokes each getter once and does not freeze borrowed returned values', () => {
  let calls = 0;
  const child = { kept: true };
  const source = {
    get counted() {
      calls++;
      return child;
    },

    exotic: new Map([['kept', child]]),
  };
  const copy = immutableCopy(source);
  assert.equal(calls, 1);
  assert.equal(copy.counted, copy.exotic.get('kept'));
  assert.notEqual(copy.counted, child);
  assert.equal(Object.isFrozen(child), false);
  copy.counted.kept = false;
  assert.equal(child.kept, true);
});

test('owned tab shells still inspect borrowed nested accessors before exotic fallback', () => {
  const cache = createPresentationCache();
  let calls = 0;
  const child = { kept: true };
  const future = {
    get counted() {
      calls++;
      return child;
    },

    exotic: new Map([['kept', child]]),
  };
  const source = [{ id: 1, treeId: 'tree-1', future }];
  Object.defineProperty(source[0], '__proto__', {
    value: { own: true },
    enumerable: true,
  });
  const first = cache.tabs(source, []);
  assert.equal(calls, 1);
  assert.equal(first[0].future.counted, first[0].future.exotic.get('kept'));
  assert.deepEqual(first[0].__proto__, { own: true });
  assert.equal(Object.getPrototypeOf(first[0]), Object.prototype);
  assert.equal(Object.isFrozen(future), false);
  assert.equal(Object.isFrozen(child), false);
  first[0].future.counted.kept = false;
  const second = cache.tabs(source, []);
  assert.equal(calls, 2);
  assert.equal(second[0].future.counted.kept, true);
  assert.notEqual(second[0], first[0]);
  assert.equal(child.kept, true);
});

test('owned presentation rows remain reusable after adoption and container changes', () => {
  const cache = createPresentationCache();
  const native = [
    { id: 1, treeId: 'one', cookieStoreId: 'work', ancestors: [], future: { kept: true } },
    { id: 2, treeId: 'two', cookieStoreId: 'firefox-default', ancestors: [] },
  ];
  const containers = [{ cookieStoreId: 'work', name: 'Work', colorCode: '#123456' }];
  const first = cache.tabs(native, containers);
  assert(cache.ownsTabs(first));
  assert.equal(cache.tabs(first, containers), first);
  assert.equal(Object.isFrozen(native[0]), false);
  assert.equal(Object.isFrozen(native[0].future), false);
  const changed = cache.tabs(first, [
    { cookieStoreId: 'work', name: 'Renamed', colorCode: '#654321' },
  ]);
  assert.notEqual(changed[0], first[0]);
  assert.equal(changed[1], first[1]);
  assert.equal(first[0].container.name, 'Work');
  assert.equal(changed[0].container.name, 'Renamed');
  assert.deepEqual(changed[0].future, { kept: true });
  const removed = cache.tabs(changed, []);
  assert.equal(removed[0].container, null);
  assert.equal(removed[1], first[1]);
  const restored = cache.tabs(removed, containers);
  assert.equal(restored[0].container.name, 'Work');
  assert.equal(restored[1], first[1]);
});

test('frozen outer arrays and exotic presentation fallbacks cannot be adopted', () => {
  const cache = createPresentationCache();
  const borrowed = Object.freeze([{ id: 1, future: new Map([['kept', true]]) }]);
  assert.equal(cache.ownsTabs(borrowed), false);
  const first = cache.tabs(borrowed, []);
  assert(Object.isFrozen(first));
  assert.equal(cache.ownsTabs(first), false);
  first[0].future.set('kept', false);
  const second = cache.tabs(borrowed, []);
  assert.equal(second[0].future.get('kept'), true);
  assert.equal(borrowed[0].future.get('kept'), true);
});

test('held adopted snapshots never retain later container versions through cache mappings', () => {
  const NativeWeakMap = globalThis.WeakMap;
  const writes = [];
  globalThis.WeakMap = class extends NativeWeakMap {
    set(key, value) {
      if (Object.isFrozen(key)) writes.push({ key, value });
      return super.set(key, value);
    }
  };
  try {
    const cache = createPresentationCache();
    let rows = cache.tabs(
      [{ id: 1, cookieStoreId: 'work' }],
      [{ cookieStoreId: 'work', name: 'Original', colorCode: '#123456' }],
    );
    const first = rows;
    const owned = new Set([rows, ...rows]);
    for (let version = 0; version < 8; version++) {
      const containers = [{ cookieStoreId: 'work', name: `Work ${version}`, colorCode: '#123456' }];
      rows = cache.tabs(rows, containers);
      owned.add(rows);
      for (const row of rows) owned.add(row);
      assert.equal(cache.tabs(rows, containers), rows);
    }
    assert.equal(first[0].container.name, 'Original');
    assert.equal(rows[0].container.name, 'Work 7');
    assert(writes.length > 0);
    for (const { key, value } of writes)
      if (owned.has(key))
        assert.equal(value.tabs ?? value, key, 'owned cache keys only retain themselves');
  } finally {
    globalThis.WeakMap = NativeWeakMap;
  }
});

test('adopted rows refresh container metadata through query failure and recovery', async (t) => {
  const f = fixture(t);
  const before = await f.read();
  const identity = f.setup.containers[0];
  const target = before.tabs.find((tab) => tab.cookieStoreId === identity.cookieStoreId);
  const untouched = before.tabs.find((tab) => tab.cookieStoreId === 'firefox-default');
  for (let version = 0; version < 4; version++) {
    identity.name = `Changed ${version}`;
    identity.colorCode = '#123456';
    f.api.contextualIdentities.onUpdated.emit({ contextualIdentity: structuredClone(identity) });
    await f.api.tabs.update(target.id, { title: `Metadata ${version}` });
    const next = await f.read();
    assert.equal(next.tabs.find((tab) => tab.id === target.id).container.name, identity.name);
    assert.equal(
      next.tabs.find((tab) => tab.id === untouched.id),
      untouched,
    );
  }
  assert.notEqual(target.container.name, identity.name, 'the held first snapshot stays unchanged');
  const query = f.api.contextualIdentities.query;
  f.api.contextualIdentities.query = async () => {
    throw new Error('Unavailable');
  };
  f.api.contextualIdentities.onRemoved.emit({ contextualIdentity: identity });
  const failed = await f.read();
  assert.equal(failed.tabs.find((tab) => tab.id === target.id).container, null);
  f.api.contextualIdentities.query = query;
  const recovered = await f.read();
  assert.equal(recovered.tabs.find((tab) => tab.id === target.id).container.name, identity.name);
  const publicState = await f.publicRead();
  publicState.tabs.find((tab) => tab.id === target.id).container.name = 'Caller change';
  assert.equal(
    (await f.read()).tabs.find((tab) => tab.id === target.id).container.name,
    identity.name,
  );
});

test('adoption cannot resurrect a structural cache invalidated during another snapshot read', async (t) => {
  const f = fixture(t);
  await f.read();
  const original = f.api.sessions.getWindowValue;
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  f.api.sessions.getWindowValue = async (...args) => {
    const value = await original(...args);
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return value;
  };
  const pending = f.read();
  await waiting;
  await new Promise(setImmediate);
  await f.api.tabs.update(1, { url: 'https://new-location.invalid/' });
  release();
  await pending;
  f.api.sessions.getWindowValue = original;
  f.resetStats();
  const next = await f.read();
  assert.equal(next.tabs.find((tab) => tab.id === 1).url, 'https://new-location.invalid/');
  assert.equal(
    f.stats().calls['tabs.query'],
    1,
    'a structural invalidation still requires a native read',
  );
});
