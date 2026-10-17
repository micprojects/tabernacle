import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { articleUrl, articleOrigin, normaliseArticle } from '../extension/src/article.js';
import {
  ARTICLE_ORIGINS,
  ARTICLE_SESSION_KEY,
  createArticleService,
} from '../extension/src/article-service.js';
import { laterCategory, laterResults } from '../extension/src/later.js';
import { closeFallback } from '../extension/src/close-selection.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';

const url = 'https://news.example.test/story?id=3#section';
const readerUrl = `about:reader?url=${encodeURIComponent(url)}`;

test('source URLs survive Reader View and permission requests stay on the exact web host', () => {
  assert.equal(articleUrl(readerUrl), url);
  assert.equal(articleOrigin(readerUrl), 'https://news.example.test/*');
  assert.equal(articleOrigin('http://localhost:8080/blog/a'), 'http://localhost/*');
  for (const value of [
    'about:blank',
    'file:///article.html',
    'javascript:alert(1)',
    'https://user:secret@example.com/',
    'about:reader?url=about%3Aconfig',
    null,
  ])
    assert.equal(articleUrl(value), null);
});

test('previews retain only bounded text fields and a clearly estimated reading duration', () => {
  const data = normaliseArticle(
    {
      url,
      title: ' An article\n',
      byline: 'Author',
      words: 441,
      excerpt: 'x'.repeat(2000),
      content: '<script>secret</script>',
      published: '2026-10-17',
    },
    url,
  );
  assert.equal(data.title, 'An article');
  assert.equal(data.minutes, 3);
  assert.equal(data.excerpt.length, 280);
  assert.equal(data.published, '2026-10-17');
  assert(!('content' in data));
  assert.equal(normaliseArticle({ url, title: 'Short', words: 3 }, url), null);
  assert.equal(
    normaliseArticle({ url: 'https://other.test/', title: 'Wrong', words: 500 }, url),
    null,
  );
});

function fixture() {
  const tab = { id: 1, treeId: 'one', url, status: 'complete', savedForLaterAt: 100 };
  let native = { ...tab },
    grants = new Set(),
    time = 1000,
    result = {
      url,
      title: 'Extracted title',
      words: 440,
      byline: 'An author',
      excerpt: 'A short description.',
    };
  const calls = [],
    requests = [],
    saved = new Map();
  const api = {
    permissions: {
      contains: async ({ origins }) =>
        origins.every(
          (origin) => grants.has(origin) || grants.has(`${origin.split(':')[0]}://*/*`),
        ),

      request: async (value) => {
        requests.push(value);
        for (const origin of value.origins) grants.add(origin);
        return true;
      },

      remove: async ({ origins }) => {
        for (const origin of origins) grants.delete(origin);
        return true;
      },
    },
    tabs: { get: async () => ({ ...native }) },
    sessions: {
      getTabValue: async (id, key) => saved.get(`${id}:${key}`),
      setTabValue: async (id, key, value) => saved.set(`${id}:${key}`, value),
    },
    scripting: {
      executeScript: async (options) => {
        calls.push(options);
        return options.files
          ? []
          : [{ result: typeof result === 'function' ? await result() : result }];
      },
    },
  };
  const service = createArticleService({ api, now: () => time });
  service.configure([tab], true);
  return {
    tab,
    service,
    api,
    calls,
    requests,
    saved,

    advance: (ms) => {
      time += ms;
    },

    result: (value) => {
      result = value;
    },

    native: (value) => {
      native = { ...native, ...value };
    },

    revoke: () => {
      grants.clear();
      service.refreshPermissions();
    },
  };
}

test('no injection before permission; one all-sites grant enables bounded, cached local previews', async () => {
  const f = fixture();
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.peek(f.tab), null);
  await f.service.allowAll();
  assert.deepEqual(f.requests, [{ origins: ARTICLE_ORIGINS }]);
  assert.equal(await f.service.hasAllAccess(), true);
  await Promise.all([f.service.read(f.tab), f.service.read(f.tab)]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].files, [
    'vendor/readability/Readability.js',
    'vendor/readability/Readability-readerable.js',
  ]);
  assert.equal(f.service.peek(f.tab).minutes, 2);
  const saved = f.saved.get(`1:${ARTICLE_SESSION_KEY}`);
  assert.equal(saved.treeId, 'one');
  assert(!('textContent' in saved));
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 2);
  f.advance(300000);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 4);
  f.revoke();
  assert.equal(f.service.peek(f.tab), null);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 4);
});

test('all-site access survives service recreation and removal preserves separate site grants', async () => {
  const f = fixture();
  assert.equal(await f.service.hasAllAccess(), false);
  await f.service.allowAll();
  const second = createArticleService({ api: f.api });
  assert.equal(await second.hasAllAccess(), true);
  assert.equal(await f.api.permissions.contains({ origins: ['http://future.test/*'] }), true);
  assert.equal(await f.api.permissions.contains({ origins: ['https://future.test/*'] }), true);
  await f.api.permissions.request({ origins: ['https://news.example.test/*'] });
  await f.service.removeAllAccess();
  assert.equal(await f.service.hasAllAccess(), false);
  assert.equal(await second.hasAllAccess(), false);
  assert.equal(await f.api.permissions.contains({ origins: ['https://future.test/*'] }), false);
  await f.service.read(f.tab);
  assert.equal(f.service.peek(f.tab).title, 'Extracted title');
});

test('declining all-site access does not inject or repeat the permission request', async () => {
  const f = fixture();
  let requests = 0;
  f.api.permissions.request = async () => {
    requests++;
    return false;
  };
  assert.equal(await f.service.allowAll(), false);
  for (let i = 0; i < 3; i++) await f.service.read(f.tab);
  assert.equal(await f.service.hasAllAccess(), false);
  assert.equal(f.calls.length, 0);
  assert.equal(requests, 1);
});

test('discarded and Reader View tabs hydrate their own preview without injecting or waking', async () => {
  const f = fixture();
  await f.service.allowAll();
  await f.service.read(f.tab);
  for (const extra of [
    { discarded: true },
    { discarded: false, isInReaderMode: true, url: readerUrl },
  ]) {
    const tab = { ...f.tab, ...extra };
    f.native(tab);
    const service = createArticleService({ api: f.api });
    service.configure([tab], true);
    await service.read(tab);
    assert.equal(service.peek(tab).title, 'Extracted title');
    assert.equal(f.calls.length, 2);
    const duplicate = { ...tab, treeId: 'duplicate' };
    service.configure([duplicate], true);
    await service.read(duplicate);
    assert.equal(service.peek(duplicate), null);
  }
});

test('late extraction is rejected on navigation, queue removal, close and revoked access', async () => {
  for (const change of ['navigate', 'remove', 'close', 'revoke']) {
    const f = fixture();
    await f.service.allowAll();
    f.result(() => {
      if (change === 'navigate') f.native({ url: 'https://other.test/' });
      if (change === 'remove') f.service.configure([], true);
      if (change === 'close') f.service.configure([f.tab], false);
      if (change === 'revoke') f.revoke();
      return { url, title: 'Stale', words: 500 };
    });
    await f.service.read(f.tab);
    assert.equal(f.service.peek(f.tab), null, change);
    assert.equal(f.saved.size, 0, change);
  }
});

test('failed reads back off and no reads happen while Saved for Later is closed', async () => {
  const f = fixture();
  await f.service.allowAll();
  f.result(null);
  await f.service.read(f.tab);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 2);
  f.advance(30000);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 4);
  f.advance(30000);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 4);
  f.service.configure([f.tab], false);
  f.advance(60000);
  await f.service.read(f.tab);
  assert.equal(f.calls.length, 4);
});

test('native detection and preview titles work in Articles; closes follow the enriched projection', () => {
  const tabs = [
    {
      id: 1,
      url,
      title: 'Website',
      savedForLaterAt: 300,
      articlePreview: { title: 'Gardens', byline: 'Alice' },
    },
    { id: 2, url: readerUrl, savedForLaterAt: 200, isInReaderMode: true },
    { id: 3, url: 'https://example.test/123', savedForLaterAt: 100, isArticle: true },
    { id: 4, url: 'https://example.test/', active: true },
  ];
  assert.equal(laterCategory(tabs[0]), 'articles');
  assert.equal(laterCategory(tabs[1]), 'articles');
  assert.equal(laterCategory(tabs[2]), 'articles');
  assert.equal(laterResults(tabs, { category: 'articles' }).length, 3);
  assert.deepEqual(
    laterResults(tabs, { query: 'alice' }).map((tab) => tab.id),
    [1],
  );
  const before = {
    tabs: tabs.map(({ articlePreview, ...tab }) => tab),
    view: { scopeId: null, collapsed: [] },
  };
  const after = { ...before, tabs: before.tabs.filter((tab) => tab.id !== 2) };
  assert.equal(
    closeFallback(before, after, 2, { later: true, category: 'articles', tabIds: [1, 3] }),
    1,
  );
});

test('native Reader View is idempotent, window-scoped, and retains saved placement and container', async () => {
  const api = memoryBrowser({
    events: true,
    tabs: [
      { id: 1, windowId: 1, url, isArticle: true, cookieStoreId: 'firefox-container-1' },
      { id: 2, windowId: 2, url, isArticle: true },
    ],
    memberships: { 1: { treeId: 'one', order: 50, savedForLaterAt: 100 } },
  });
  let calls = 0;
  api.tabs.toggleReaderMode = async (id) => {
    calls++;
    const tab = await api.tabs.get(id);
    await api.tabs.update(id, {
      url: tab.isInReaderMode ? url : readerUrl,
      isInReaderMode: !tab.isInReaderMode,
    });
  };
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  const request = (enabled, args = {}) =>
    controller.request({ type: 'setReaderMode', windowId: 1, id: 1, url, enabled, ...args });
  const state = await request(true);
  assert.equal(state.tabs[0].isInReaderMode, true);
  assert.equal(state.tabs[0].savedForLaterAt, 100);
  assert.equal(state.tabs[0].order, 50);
  assert.equal(state.tabs[0].cookieStoreId, 'firefox-container-1');
  await request(true);
  assert.equal(calls, 1);
  await request(false);
  assert.equal(calls, 2);
  await assert.rejects(request(true, { id: 2 }), /another window/);
  await assert.rejects(request(true, { url: 'https://other.test/' }), /changed/);
  await api.tabs.update(1, { isArticle: false });
  await assert.rejects(request(true), /not available/);
  assert.equal(calls, 2);
  assert(notices.length > 0);
});

test('reader availability updates and status completion refresh native Reader View state', async () => {
  const api = memoryBrowser({ events: true, tabs: [{ id: 1, windowId: 1, url }] });
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  await controller.request({ type: 'snapshot', windowId: 1 });
  notices.length = 0;
  await api.tabs.update(1, { isArticle: true });
  assert(notices.length);
  api.tabs.onUpdated.emit(
    1,
    { status: 'complete' },
    { windowId: 1, isInReaderMode: true, isArticle: true },
  );
  const state = await controller.request({ type: 'snapshot', windowId: 1 });
  assert.equal(state.tabs[0].isInReaderMode, true);
});

test('vendored sources match the pinned upstream files; web access remains optional', async () => {
  const source = JSON.parse(await readFile('extension/vendor/readability/SOURCE.json'));
  assert.equal(source.version, '0.6.0');
  for (const [name, checksum] of Object.entries(source.sha256))
    assert.equal(
      createHash('sha256')
        .update(await readFile(`extension/vendor/readability/${name}`))
        .digest('hex'),
      checksum,
    );
  const manifest = JSON.parse(await readFile('extension/manifest.json'));
  for (const origin of ['http://*/*', 'https://*/*']) {
    assert(manifest.optional_host_permissions.includes(origin));
    assert(!manifest.permissions.includes(origin));
  }
});
