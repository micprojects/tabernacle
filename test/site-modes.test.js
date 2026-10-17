import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SITE_MODES,
  SITE_ORIGINS,
  siteModeForDomain,
  sitePage,
  siteOrigins,
  siteDetails,
} from '../extension/src/site-modes.js';
import { normaliseSiteData } from '../extension/src/site-reader.js';
import { createSiteService } from '../extension/src/site-service.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { siteFixtures } from '../scripts/fixtures/site-pages.js';

test('all eight modes recognise supported URLs and reject lookalikes and unsupported schemes', () => {
  assert.equal(new Set(siteFixtures.map((f) => f.mode)).size, 8);
  for (const f of siteFixtures) {
    assert.equal(sitePage(f.url).mode, f.mode, f.site);
    assert.equal(siteModeForDomain(f.domain, [{ url: f.url }]), f.mode);
    const bad = new URL(f.url);
    bad.hostname += '.evil.test';
    assert.equal(sitePage(bad.href), null);
    assert.equal(sitePage(f.url.replace('https:', 'file:')), null);
  }
  assert.equal(
    siteModeForDomain('google.com', [{ url: 'https://google.com/search?q=test' }]),
    null,
  );
  assert.equal(sitePage('https://accounts.google.com/maps/'), null);
});

test('related items retain their distinct comment, section, file view and product selection', () => {
  assert.equal(
    sitePage('https://old.reddit.com/r/firefox/comments/abc/title/def/').identity,
    'reddit:abc',
  );
  assert.equal(
    sitePage('https://old.reddit.com/r/firefox/comments/abc/title/def/').kind,
    'Comment',
  );
  assert.equal(
    sitePage('https://en.wikipedia.org/wiki/Alan_Turing#Education').location,
    'Education',
  );
  assert.equal(
    sitePage('https://docs.google.com/spreadsheets/d/id/edit#gid=0').identity,
    sitePage('https://docs.google.com/spreadsheets/d/id/edit#gid=2').identity,
  );
  assert.notEqual(
    sitePage('https://amazon.com/dp/B000000001').identity,
    sitePage('https://amazon.com/dp/B000000002').identity,
  );
  assert.equal(sitePage('https://www.google.com/maps/place/Cafe/').identity, '');
  assert.notEqual(
    sitePage('https://docs.google.com/spreadsheets/d/e/published-one/pubhtml').identity,
    sitePage('https://docs.google.com/spreadsheets/d/e/published-two/pubhtml').identity,
  );
  for (const url of [
    'https://reddit.com/',
    'https://amazon.com/s?k=mugs',
    'https://imdb.com/find/',
    'https://news.ycombinator.com/',
  ])
    assert.equal(sitePage(url).identity, '');
});

test('details omit unknown fields, zero comments remain useful, and no placeholder metrics appear', () => {
  for (const f of siteFixtures)
    assert(!siteDetails(sitePage(f.url)).some((s) => /unknown|N\/A|rating/i.test(s || '')));
  assert.deepEqual(siteDetails(sitePage(siteFixtures[0].url), { comments: '0 comments' }), [
    'r/firefox',
    '0 comments',
  ]);
  assert.equal(
    normaliseSiteData({ url: 'https://other.test/', title: 'Wrong' }, siteFixtures[0].url),
    null,
  );
  assert.equal(
    normaliseSiteData({ url: 'https://x.test', image: 'javascript:alert(1)' }, 'https://x.test'),
    null,
  );
  assert.equal(
    normaliseSiteData(
      { url: 'https://x.test', title: 'Good', image: 'http://tracker.test/x' },
      'https://x.test',
    ).image,
    undefined,
  );
});

test('permissions are optional, declared, and limited to the chosen site', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json'));
  for (const origin of SITE_ORIGINS) assert(manifest.optional_host_permissions.includes(origin));
  assert.deepEqual(siteOrigins('amazon.co.uk', 'shopping'), ['https://*.amazon.co.uk/*']);
  assert.deepEqual(siteOrigins('docs.google.com', 'docs'), ['https://docs.google.com/*']);
  assert.deepEqual(siteOrigins('github.com', 'github'), ['https://github.com/*']);
  assert(!manifest.permissions.includes('<all_urls>'));
});

function fixture() {
  const tab = {
    id: 1,
    treeId: 'tab-one',
    url: 'https://github.com/microsoft/vscode/issues/1',
    status: 'complete',
  };
  let time = 1000,
    granted = true,
    result = { url: tab.url, status: 'Open' },
    count = 0;
  const saved = new Map();
  const api = {
    permissions: { contains: async () => granted, request: async () => (granted = true) },
    tabs: { get: async () => tab },
    scripting: {
      executeScript: async () => {
        count++;
        return [{ result: typeof result === 'function' ? await result() : result }];
      },
    },
    sessions: {
      getTabValue: async (id) => saved.get(id),
      setTabValue: async (id, key, value) => saved.set(id, value),
    },
  };
  const service = createSiteService({
    api,
    now: () => time,

    fetcher: async () => {
      throw new Error('Unexpected network');
    },
  });
  service.configure('github.com', 'github', [tab]);
  return {
    tab,
    api,
    service,
    saved,
    count: () => count,

    advance: (ms) => {
      time += ms;
    },

    result: (v) => {
      result = v;
    },

    revoke: () => {
      granted = false;
    },
  };
}

test('retrieval respects permissions, retries failures with backoff and throttles successful reads', async () => {
  const f = fixture();
  await f.service.read(f.tab);
  assert.equal(f.count(), 0);
  await f.service.permission();
  f.result(null);
  await f.service.read(f.tab);
  assert.equal(f.count(), 1);
  await f.service.read(f.tab);
  assert.equal(f.count(), 1);
  f.advance(15000);
  f.result({ url: f.tab.url, status: 'Closed' });
  await f.service.read(f.tab);
  assert.equal(f.service.peek(f.tab).status, 'Closed');
  await f.service.read(f.tab);
  assert.equal(f.count(), 2);
  f.advance(30000);
  await f.service.read(f.tab);
  assert.equal(f.count(), 3);
  f.revoke();
  await f.service.permission();
  assert.equal(f.service.peek(f.tab), null);
  await f.service.read(f.tab);
  assert.equal(f.count(), 3);
});

test('sleeping tabs stay asleep and restore only their own observed metadata', async () => {
  const f = fixture();
  await f.service.permission();
  await f.service.read(f.tab);
  f.tab.discarded = true;
  const restored = createSiteService({ api: f.api });
  restored.configure('github.com', 'github', [f.tab]);
  await restored.permission();
  await restored.read(f.tab);
  assert.equal(restored.peek(f.tab).status, 'Open');
  assert.equal(f.count(), 1);
  const duplicate = { ...f.tab, treeId: 'new-duplicate' };
  const other = createSiteService({ api: f.api });
  other.configure('github.com', 'github', [duplicate]);
  await other.permission();
  await other.read(duplicate);
  assert.equal(other.peek(duplicate), null);
});

test('late responses cannot paint a navigated tab or a different domain mode', async () => {
  const f = fixture();
  await f.service.permission();
  const old = { ...f.tab };
  f.result(() => {
    f.tab.url = 'https://github.com/microsoft/vscode/issues/2';
    return { url: old.url, status: 'Closed' };
  });
  await f.service.read(old);
  assert.equal(f.service.peek(f.tab), null);
  f.tab.url = old.url;
  f.result(() => {
    f.service.configure(null, null, []);
    return { url: old.url, status: 'Closed' };
  });
  await f.service.read(old);
  assert.equal(f.service.peek(f.tab), null);
});

test('HN can enrich a sleeping discussion through its public API without credentials or waking the tab', async () => {
  const tab = { id: 7, url: 'https://news.ycombinator.com/item?id=8863', discarded: true };
  const calls = [];
  const api = {
    permissions: { contains: async () => true },
    tabs: { get: async () => tab },
    scripting: {
      executeScript: async () => {
        throw new Error('Must not wake sleeping tabs');
      },
    },
  };
  const service = createSiteService({
    api,

    fetcher: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          id: 8863,
          title: 'A story',
          descendants: 0,
          url: 'https://example.org/article',
        }),
      };
    },
  });
  service.configure('news.ycombinator.com', 'hn', [tab]);
  await service.permission();
  await service.read(tab);
  assert.equal(service.peek(tab).comments, '0 comments');
  assert.equal(service.peek(tab).source, 'example.org');
  assert.equal(calls[0].url, 'https://hacker-news.firebaseio.com/v0/item/8863.json');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  service.configure(null, null, []);
  assert(calls[0].options.signal.aborted);
});

test('site switches persist independently, notify other windows and validate input', async () => {
  const api = memoryBrowser({ tabs: [{ id: 1, windowId: 1, url: 'https://github.com/' }] });
  const notices = [];
  const controller = createController(api, (id) => notices.push(id));
  for (const mode of Object.keys(SITE_MODES))
    await controller.request({ type: 'setSiteMode', windowId: 1, mode, enabled: false });
  const reopened = createController(api);
  const state = await reopened.request({ type: 'snapshot', windowId: 1 });
  for (const mode of Object.keys(SITE_MODES)) assert.equal(state.siteModes[mode], false);
  assert.equal(state.youtubeMode, true);
  assert(notices.some((notice) => notice.windowId === undefined));
  await assert.rejects(
    reopened.request({ type: 'setSiteMode', windowId: 1, mode: '__proto__', enabled: false }),
  );
});
