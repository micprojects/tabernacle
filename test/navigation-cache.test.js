import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

function fixture(t) {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const cache = createBrowserCache(f.api);
  t.after(() => cache.dispose());
  return { ...f, cache };
}

test('native article-reset, title and URL event order keeps complete bounded refresh', async (t) => {
  const f = fixture(t);
  f.native.get(3).isArticle = true;
  const before = await f.cache.tabsState(1);
  const saved = structuredClone(before.tabs);
  const url = new URL('/next?view=all', f.native.get(3).url).href;
  f.resetStats();
  await f.api.tabs.update(3, { status: 'loading' });
  await f.api.tabs.update(3, { isArticle: false });
  await f.api.tabs.update(3, { title: 'Loading' });
  await f.api.tabs.update(3, { status: 'loading', url });
  await f.api.tabs.update(3, { title: 'Next page' });
  await f.api.tabs.update(3, { status: 'complete' });
  const after = await f.cache.tabsState(1);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.deepEqual(before.tabs, saved);
});

test('article eligibility alone reads authoritative native values', async (t) => {
  const f = fixture(t);
  f.native.get(3).isArticle = false;
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(3, { isArticle: true });
  f.native.get(3).title = 'Complete native title';
  const after = await f.cache.tabsState(1);
  assert.equal(after.structureToken, before.structureToken);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

for (const change of ['unannounced-url', 'unknown']) {
  test(`article refresh retains full-query fallback for ${change}`, async (t) => {
    const f = fixture(t);
    f.native.get(3).isArticle = true;
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { isArticle: false });
    const tab = f.native.get(3);
    if (change === 'unannounced-url') tab.url = new URL('/unannounced', tab.url).href;
    if (change === 'unknown') tab.futureField = 'native';
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('an article event during a pending native read cannot revive stale rows', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(3, { isArticle: false });
  const get = f.api.tabs.get;
  let started, release;
  const waiting = new Promise((resolve) => (started = resolve));
  const held = new Promise((resolve) => (release = resolve));
  f.api.tabs.get = async (id) => {
    const result = await get(id);
    started();
    await held;
    return result;
  };
  const reading = f.cache.tabsState(1);
  await waiting;
  await f.api.tabs.update(3, { isArticle: true });
  release();
  const after = await reading;
  assert.notEqual(after.structureToken, before.structureToken);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});

test('announced same-origin document changes preserve topology after complete native reads', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const other = await f.cache.tabsState(2);
  const saved = structuredClone(before.tabs);
  const url = new URL('/next?view=all', f.native.get(3).url).href;
  f.resetStats();
  await f.api.tabs.update(3, { url, title: 'Next page', status: 'loading' });
  await f.api.tabs.update(3, { status: 'complete' });
  const after = await f.cache.tabsState(1);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.deepEqual(before.tabs, saved);
  assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
});

for (const target of ['http://[', 'about:blank']) {
  test(`navigation to ${target} retains full-query fallback`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    f.resetStats();
    await f.api.tabs.update(3, { url: target });
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.get'] || 0, 0);
    assert.equal(f.stats().calls['tabs.query'], 1);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

for (const change of ['unannounced-url', 'unknown', 'pinned']) {
  test(`document refresh falls back on ${change}`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { url: new URL('/next', f.native.get(3).url).href });
    const tab = f.native.get(3);
    if (change === 'unannounced-url') tab.url += '?unannounced';
    if (change === 'unknown') tab.futureField = { retained: ['native'] };
    if (change === 'pinned') tab.pinned = !tab.pinned;
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

for (const last of ['fragment', 'document']) {
  test(`a ${last} notice replaces an earlier navigation marker`, async (t) => {
    const f = fixture(t);
    const original = f.native.get(3).url;
    const fragment = original + '#section';
    const document = new URL('/next', original).href;
    const before = await f.cache.tabsState(1);
    const [first, second] = last === 'fragment' ? [document, fragment] : [fragment, document];
    await f.api.tabs.update(3, { url: first });
    await f.api.tabs.update(3, { url: second });
    // The complete read disagrees with the latest notice. An old marker must
    // not make this unannounced return to the previous address eligible.
    f.native.get(3).url = first;
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('coalesced document navigation accepts only the latest announced address', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const base = f.native.get(3).url;
  for (let i = 0; i < 20; i++)
    await f.api.tabs.update(3, { url: new URL(`/next?step=${i}`, base).href });
  f.resetStats();
  const after = await f.cache.tabsState(1);
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(after.tabs.find((tab) => tab.id === 3).url, new URL('/next?step=19', base).href);
  assert.equal(f.stats().calls['tabs.get'], 2);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
});

for (const change of ['metadata', 'document', 'remove', 'move']) {
  test(`${change} during a document refresh retries current native state`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    const url = new URL('/next', f.native.get(3).url).href;
    await f.api.tabs.update(3, { url });
    const get = f.api.tabs.get;
    let started, release;
    const waiting = new Promise((resolve) => (started = resolve));
    const held = new Promise((resolve) => (release = resolve));
    f.api.tabs.get = async (id) => {
      const result = await get(id);
      started();
      await held;
      return result;
    };
    const reading = f.cache.tabsState(1);
    await waiting;
    if (change === 'metadata') await f.api.tabs.update(3, { title: 'Latest' });
    if (change === 'document') await f.api.tabs.update(3, { url: url + '?later' });
    if (change === 'remove') await f.api.tabs.remove(3);
    if (change === 'move') {
      f.native.get(3).index = 25;
      f.api.tabs.onMoved.emit(3, { windowId: 1 });
    }
    release();
    const after = await reading;
    if (change === 'metadata') assert.equal(after.structureToken, before.structureToken);
    else assert.notEqual(after.structureToken, before.structureToken);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('failed document get/query reads remain retryable', async (t) => {
  const f = fixture(t);
  await f.cache.tabsState(1);
  await f.api.tabs.update(3, { url: new URL('/next', f.native.get(3).url).href });
  const get = f.api.tabs.get;
  const query = f.api.tabs.query;
  f.api.tabs.get = async () => {
    throw new Error('Get failed');
  };
  f.api.tabs.query = async () => {
    throw new Error('Query failed');
  };
  await assert.rejects(f.cache.tabsState(1), /Query failed/);
  f.api.tabs.get = get;
  f.api.tabs.query = query;
  assert.deepEqual(await f.cache.tabs(1), await query({ windowId: 1 }));
});

for (const kind of ['document', 'article']) {
  test(`bulk ${kind} changes release pending refreshes before another read`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    const other = await f.cache.tabsState(2);
    for (const tab of before.tabs)
      await f.api.tabs.update(
        tab.id,
        kind === 'document' ? { url: new URL('/next', tab.url).href } : { isArticle: false },
      );
    assert.equal(f.cache.stats().nativeLists, 1);
    assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
    f.resetStats();
    const after = await f.cache.tabsState(1);
    assert.equal(f.stats().calls['tabs.get'] || 0, 0);
    assert.equal(f.stats().calls['tabs.query'], 1);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('controller document refresh preserves organisation across restart', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const before = await controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  const url = new URL('/next?section=all', f.native.get(3).url).href;
  await f.api.tabs.update(3, { url });
  const after = await controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  assert.equal(after.tabs.find((tab) => tab.id === 3).url, url);
  assert.notEqual(before.tabs.find((tab) => tab.id === 3).url, url);
  assert.equal(
    after.tabs.find((tab) => tab.id === 5),
    before.tabs.find((tab) => tab.id === 5),
  );
  controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).tabs, after.tabs);
  assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
});

test('HTTP preview internal-page transitions preserve filtering and durable identity', async (t) => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  f.api.runtime.getURL = (path) => `https://preview.invalid/${path}`;
  f.native.get(3).url = 'https://preview.invalid/ordinary';
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const read = () => controller.request({ type: 'snapshot', windowId: 1 });
  const before = await read();
  const old = before.tabs.find((tab) => tab.id === 3);
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  await f.api.tabs.update(3, { url: f.api.runtime.getURL('settings.html') });
  assert(!(await read()).tabs.some((tab) => tab.id === 3));
  await f.api.tabs.update(3, { url: 'https://preview.invalid/returned' });
  const after = (await read()).tabs.find((tab) => tab.id === 3);
  for (const key of ['treeId', 'groupId', 'order', 'ancestors', 'collapsed'])
    assert.deepEqual(after[key], old[key]);
  assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
});

for (const kind of ['fragment', 'document', 'article', 'selection']) {
  test(`${kind} refresh removes absent native metadata from adopted presentation rows`, async (t) => {
    const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
    const native = f.native.get(3);
    native.favIconUrl = 'https://example.com/old-icon.png';
    native.isArticle = true;
    native.lastAccessed = 123;
    native.groupId = 37;
    native.order = -1000;
    native.ancestors = ['opaque-native-ancestry'];
    native.futureNativeField = { opaque: ['preserved', { value: 7 }] };
    const controller = createController(f.api);
    t.after(() => controller.dispose());
    const read = () => controller.requestForTransport({ type: 'snapshot', windowId: 1 });
    const before = await read();
    const old = before.tabs.find((tab) => tab.id === 3);
    const unchanged = before.tabs.find((tab) => tab.id === 5);
    const savedSnapshot = structuredClone(before);
    const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
    const properties =
      kind === 'article'
        ? { isArticle: false }
        : kind === 'selection'
          ? { lastAccessed: 456 }
          : { url: kind === 'fragment' ? native.url + '#next' : new URL('/next', native.url).href };
    f.resetStats();
    await f.api.tabs.update(3, properties);
    const removed = ['favIconUrl', 'title', 'lastAccessed'];
    if (kind === 'article') removed.push('isArticle');
    for (const key of removed) delete native[key];
    const after = await read();
    const next = after.tabs.find((tab) => tab.id === 3);
    assert.equal(f.stats().calls['tabs.get'], 2);
    assert.equal(f.stats().calls['tabs.query'] || 0, 0);
    for (const key of removed) assert.equal(Object.hasOwn(next, key), false, key);
    assert.deepEqual(next.futureNativeField, native.futureNativeField);
    for (const key of [
      'treeId',
      'groupId',
      'nativeGroupId',
      'order',
      'openedAt',
      'ancestors',
      'collapsed',
      'parentTabId',
      'container',
    ]) {
      assert.deepEqual(next[key], old[key], key);
      assert.equal(Object.hasOwn(next, key), Object.hasOwn(old, key), key);
    }
    assert.equal(
      after.tabs.find((tab) => tab.id === 5),
      unchanged,
    );
    assert.deepEqual(before, savedSnapshot);
    assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
    controller.dispose();
    const restarted = createController(f.api);
    t.after(() => restarted.dispose());
    const reloaded = await restarted.requestForTransport({ type: 'snapshot', windowId: 1 });
    assert.deepEqual(reloaded.tabs, after.tabs);
  });
}

test('removed unknown native fields still invalidate topology', async (t) => {
  const f = fixture(t);
  f.native.get(3).futureNativeField = { opaque: true };
  const before = await f.cache.tabsState(1);
  await f.api.tabs.update(3, { url: new URL('/next', f.native.get(3).url).href });
  delete f.native.get(3).futureNativeField;
  const after = await f.cache.tabsState(1);
  assert.notEqual(after.structureToken, before.structureToken);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
});
