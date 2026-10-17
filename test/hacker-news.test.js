import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { hackerNewsArticle, hackerNewsStory, siteTabPage } from '../extension/src/hacker-news.js';
import { normaliseSiteData } from '../extension/src/site-reader.js';
import { createSiteService } from '../extension/src/site-service.js';
import { domainForTab, matchesDomain } from '../extension/src/domain-filter.js';
import { listDomains } from '../extension/src/domains.js';
import { memoryBrowser } from '../preview/browser.js';
import { TAB_KEY } from '../extension/src/model.js';

const story = {
  commentsUrl: 'https://news.ycombinator.com/item?id=8863#comments',
  articleUrl: 'https://example.org/story',
  title: 'A story',
  comments: '200 comments',
};

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'reading', name: 'Reading', parentId: null }],
    tabs: [
      {
        id: 1,
        windowId: 1,
        url: story.commentsUrl,
        title: 'A story | Hacker News',
        cookieStoreId: 'firefox-container-1',
        status: 'complete',
      },
    ],
    memberships: { 1: { treeId: 'story-one', groupId: 'reading', order: 3, openedAt: 1000 } },
  });
  const controller = createController(api);
  const send = (args = {}) =>
    controller.request({
      type: 'setHackerNewsView',
      windowId: 1,
      id: 1,
      url: story.commentsUrl,
      view: 'article',
      story,
      ...args,
    });
  const snapshot = () => controller.request({ type: 'snapshot', windowId: 1 });
  return { api, controller, send, snapshot };
}

test('HN destinations reject executable, credentialed and internal links; metadata retains safe external URLs', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///tmp/x',
    'https://a:b@example.org/',
    'https://news.ycombinator.com/item?id=1',
    'https://www.news.ycombinator.com/',
  ]) {
    assert.equal(hackerNewsArticle(url), null);
    assert.equal(
      normaliseSiteData({ url: story.commentsUrl, articleUrl: url }, story.commentsUrl),
      null,
    );
  }
  assert.equal(hackerNewsArticle('http://example.org/article'), 'http://example.org/article');
  assert.equal(
    normaliseSiteData({ url: story.commentsUrl, articleUrl: story.articleUrl }, story.commentsUrl)
      .articleUrl,
    story.articleUrl,
  );
  assert.equal(
    normaliseSiteData({ url: story.articleUrl, articleUrl: story.articleUrl }, story.articleUrl),
    null,
  );
});

test('switching reuses the tab, preserves organisation/container, and survives controller restart', async () => {
  const { api, controller, send } = fixture();
  const next = await send();
  const tab = next.tabs[0];
  assert.equal(next.tabs.length, 1);
  assert.equal(tab.id, 1);
  assert.equal(tab.url, story.articleUrl);
  assert.equal(tab.groupId, 'reading');
  assert.equal(tab.order, 3);
  assert.equal(tab.openedAt, 1000);
  assert.equal(tab.cookieStoreId, 'firefox-container-1');
  assert.equal(hackerNewsStory(tab).view, 'article');
  assert.equal(siteTabPage(tab).identity, 'hn:8863');
  assert(matchesDomain(tab, 'news.ycombinator.com'));
  assert(!matchesDomain(tab, 'example.org'));
  const entries = listDomains([tab, { id: 2, url: 'https://news.ycombinator.com/' }]);
  assert.equal(entries[0].count, 2);
  controller.dispose();
  const restarted = createController(api);
  const snapshot = await restarted.request({ type: 'snapshot', windowId: 1 });
  assert.equal(hackerNewsStory(snapshot.tabs[0]).view, 'article');
  const back = await restarted.request({
    type: 'setHackerNewsView',
    windowId: 1,
    id: 1,
    url: tab.url,
    story: tab.hnStory,
    view: 'comments',
  });
  assert.equal(back.tabs[0].url, story.commentsUrl);
  assert.equal(hackerNewsStory(back.tabs[0]).view, 'comments');
});

test('article redirects are remembered, unrelated navigation is not grouped, and Back restores the association', async () => {
  const { api, send, snapshot } = fixture();
  const update = api.tabs.update;
  api.tabs.update = (id, changes) =>
    update(id, { ...changes, ...(changes.url ? { status: 'loading' } : {}) });
  await send();
  const finalUrl = 'https://www.example.org/canonical-story';
  await update(1, { url: finalUrl, status: 'complete' });
  let tab = (await snapshot()).tabs[0];
  assert.equal(tab.hnStory.articleUrl, finalUrl);
  assert.equal(tab.hnStory.linkUrl, story.articleUrl);
  assert.equal(tab.hnStory.pendingArticle, undefined);
  await update(1, { url: finalUrl + '#section' });
  assert.equal(domainForTab((await snapshot()).tabs[0]), 'news.ycombinator.com');
  await update(1, { url: 'https://elsewhere.test/unrelated' });
  tab = (await snapshot()).tabs[0];
  assert.equal(tab.hnStory, undefined);
  assert.equal(domainForTab(tab), 'elsewhere.test');
  await update(1, { url: finalUrl });
  assert.equal(hackerNewsStory((await snapshot()).tabs[0]).view, 'article');
});

test('stale, cross-window, forged article associations and failed writes do not navigate', async () => {
  const { api, send, snapshot } = fixture();
  await assert.rejects(send({ url: 'https://stale.test/' }), /changed/);
  await assert.rejects(
    send({ story: { ...story, articleUrl: 'javascript:alert(1)' } }),
    /no longer available/,
  );
  await api.tabs.update(1, { url: story.articleUrl });
  await assert.rejects(send({ url: story.articleUrl, view: 'comments' }), /no longer available/);
  await api.tabs.update(1, { url: story.commentsUrl });
  const write = api.sessions.setTabValue;
  api.sessions.setTabValue = async () => {
    throw new Error('Session write failed');
  };
  await assert.rejects(send(), /Session write failed/);
  assert.equal((await api.tabs.get(1)).url, story.commentsUrl);
  api.sessions.setTabValue = write;
  const update = api.tabs.update;
  api.tabs.update = async () => {
    throw new Error('Navigation failed');
  };
  await assert.rejects(send(), /Navigation failed/);
  assert.equal((await api.sessions.getTabValue(1, TAB_KEY)).hnStory, undefined);
  api.tabs.update = update;
  assert.equal((await snapshot()).tabs[0].url, story.commentsUrl);
  await api.tabs.update(1, { windowId: 2 });
  await assert.rejects(send(), /another window/);
});

test('active destination does not reload, and another discussion cannot replace the saved return route', async () => {
  const { api, send } = fixture();
  const state = await send();
  const updates = [];
  const update = api.tabs.update;
  api.tabs.update = (id, changes) => {
    updates.push(changes);
    return update(id, changes);
  };
  await send({ url: story.articleUrl, story: state.tabs[0].hnStory });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].url, undefined);
  await assert.rejects(
    send({
      url: story.articleUrl,
      view: 'comments',
      story: { ...state.tabs[0].hnStory, commentsUrl: 'https://news.ycombinator.com/item?id=2' },
    }),
    /changed/,
  );
});

test('article mode uses saved details without requesting access to or reading the article', async () => {
  const tab = { id: 1, url: story.articleUrl, hnStory: story };
  let allowed = true;
  const service = createSiteService({
    api: { permissions: { contains: async () => allowed } },

    fetcher: () => {
      throw new Error('Unexpected fetch');
    },
  });
  service.configure('news.ycombinator.com', 'hn', [tab]);
  await service.permission();
  await service.read(tab);
  assert.equal(service.peek(tab).title, story.title);
  assert.equal(service.peek(tab).source, 'example.org');
  allowed = false;
  await service.permission();
  assert.equal(service.peek(tab), null);
});
