import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCache } from '../extension/src/browser-cache.js';
import { createController } from '../extension/src/controller.js';
import { performanceBrowser, performanceFixture } from '../preview/performance-fixture.js';

const article = 'https://reader-fixture.invalid/article?one=two#section';
const reader = `about:reader?url=${encodeURIComponent(article)}`;

function fixture(t, url = article) {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 2 }));
  f.native.get(3).url = url;
  f.native.get(3).isInReaderMode = url.startsWith('about:reader?');
  f.native.get(3).isArticle = true;
  const cache = createBrowserCache(f.api);
  t.after(() => cache.dispose());
  return { ...f, cache };
}

for (const [from, to] of [
  [article, reader],
  [reader, article],
  [reader, 'https://different.invalid/story'],
  [reader, `about:reader?url=${encodeURIComponent('http://another.invalid/story')}`],
]) {
  test(`Reader navigation ${from} to ${to} keeps complete native data`, async (t) => {
    const f = fixture(t, from);
    const before = await f.cache.tabsState(1);
    const other = await f.cache.tabsState(2);
    const saved = structuredClone(before.tabs);
    f.resetStats();
    await f.api.tabs.update(3, { status: 'loading' });
    await f.api.tabs.update(3, { isArticle: false });
    f.native.get(3).isInReaderMode = to.startsWith('about:reader?');
    await f.api.tabs.update(3, { url: to, status: 'loading', title: 'Article' });
    delete f.native.get(3).favIconUrl;
    await f.api.tabs.update(3, { status: 'complete' });
    const after = await f.cache.tabsState(1);
    assert.equal(after.structureToken, before.structureToken);
    assert.equal(after.positions, before.positions);
    assert.equal(f.stats().calls['tabs.get'], 2);
    assert.equal(f.stats().calls['tabs.query'] || 0, 0);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
    assert.deepEqual(before.tabs, saved);
    assert.equal(after.tabs[2], before.tabs[2]);
    assert.equal((await f.cache.tabsState(2)).tabs, other.tabs);
    assert.equal(
      Object.hasOwn(
        after.tabs.find((tab) => tab.id === 3),
        'favIconUrl',
      ),
      false,
    );
  });
}

for (const url of [
  'about:reader',
  'about:reader?url=invalid',
  'about:reader?url=file%3A%2F%2F%2Ftmp%2Fstory',
  'about:reader?url=javascript%3Aalert(1)',
  'about:reader?url=https%3A%2F%2Fuser%3Apassword%40example.invalid',
  'about:blank',
  'moz-extension://fixture/settings.html',
]) {
  test(`unsupported reader-related address ${url} still queries`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    f.resetStats();
    await f.api.tabs.update(3, { url });
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.get'] || 0, 0);
    assert.equal(f.stats().calls['tabs.query'], 1);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

for (const field of [
  'isInReaderMode',
  'missing-mode',
  'unknown',
  'cookieStoreId',
  'groupId',
  'index',
  'openerTabId',
  'url',
]) {
  test(`Reader navigation retains full-query fallback for ${field}`, async (t) => {
    const f = fixture(t);
    const before = await f.cache.tabsState(1);
    await f.api.tabs.update(3, { url: reader });
    const tab = f.native.get(3);
    tab.isInReaderMode = true;
    if (field === 'missing-mode') delete tab.isInReaderMode;
    else if (field === 'isInReaderMode') tab.isInReaderMode = false;
    else tab[field] = field === 'url' ? reader + '&unannounced=1' : 'changed';
    f.resetStats();
    const after = await f.cache.tabsState(1);
    assert.notEqual(after.structureToken, before.structureToken);
    assert.equal(f.stats().calls['tabs.query'], 1);
    assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  });
}

test('pending Reader refresh retries complete native metadata and keeps old rows immutable', async (t) => {
  const f = fixture(t);
  const before = await f.cache.tabsState(1);
  const saved = structuredClone(before.tabs);
  f.native.get(3).isInReaderMode = true;
  await f.api.tabs.update(3, { url: reader });
  const get = f.api.tabs.get;
  let start, release;
  const started = new Promise((resolve) => (start = resolve));
  const held = new Promise((resolve) => (release = resolve));
  f.api.tabs.get = async (id) => {
    const result = await get(id);
    start();
    await held;
    return result;
  };
  f.resetStats();
  const reading = f.cache.tabsState(1);
  await started;
  delete f.native.get(3).favIconUrl;
  await f.api.tabs.update(3, { title: 'Final reader title', status: 'complete' });
  release();
  const after = await reading;
  assert.equal(after.structureToken, before.structureToken);
  assert.equal(f.stats().calls['tabs.get'], 4);
  assert.equal(f.stats().calls['tabs.query'] || 0, 0);
  assert.deepEqual(after.tabs, await f.api.tabs.query({ windowId: 1 }));
  assert.deepEqual(before.tabs, saved);
});

test('Reader navigation preserves durable organisation and restart snapshots', async (t) => {
  const f = fixture(t);
  const controller = createController(f.api);
  t.after(() => controller.dispose());
  const before = await controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const saved = structuredClone({ memberships: f.memberships, views: f.views, saved: f.saved });
  f.native.get(3).isInReaderMode = true;
  await f.api.tabs.update(3, { url: reader });
  const after = await controller.requestForTransport({ type: 'snapshot', windowId: 1 });
  const organisation = (rows) =>
    rows.map(({ id, groupId, order, treeId, ancestors, collapsed, parentTabId }) => ({
      id,
      groupId,
      order,
      treeId,
      ancestors,
      collapsed,
      parentTabId,
    }));
  assert.deepEqual(organisation(after.tabs), organisation(before.tabs));
  assert.equal(after.tabs.find((tab) => tab.id === 3).isInReaderMode, true);
  assert.equal(
    after.tabs.find((tab) => tab.id === 5),
    before.tabs.find((tab) => tab.id === 5),
  );
  await controller.dispose();
  const restarted = createController(f.api);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).tabs, after.tabs);
  assert.deepEqual({ memberships: f.memberships, views: f.views, saved: f.saved }, saved);
});
