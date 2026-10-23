import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseDomain,
  domainFromUrl,
  matchesDomain,
  domainResults,
} from '../extension/src/domain-filter.js';
import { createTreeIndex } from '../extension/src/tree/index.js';

test('domains normalise hosts and reject URLs, ports and incomplete syntax', () => {
  assert.equal(normaliseDomain('WWW.YouTube.COM.'), 'youtube.com');
  assert.equal(normaliseDomain('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normaliseDomain('[::1]'), '[::1]');
  for (const value of [
    '',
    'youtube..com',
    '-youtube.com',
    'youtube.com-',
    'https://youtube.com',
    'youtube.com:443',
    'youtube.com/',
    'youtube.com?x',
    'youtube.com#x',
    'youtube.com@evil.test',
    'you tube.com',
  ]) {
    assert.equal(normaliseDomain(value), null, value);
  }
});

test('matches host boundaries and subdomains, with optional title or URL text', () => {
  for (const url of [
    'https://youtube.com/watch?v=1',
    'http://WWW.YOUTUBE.COM:8080/watch',
    'https://music.youtube.com/',
    'https://youtube.com./',
  ]) {
    assert.equal(matchesDomain({ url, title: 'Woodworking' }, 'youtube.com', 'WOOD'), true, url);
  }
  for (const url of [
    'https://notyoutube.com/',
    'https://youtube.com.evil.test/',
    'https://example.com/youtube.com',
    'https://example.com/?q=youtube.com',
    'https://youtube.com@evil.test',
    'about:blank',
    'file:///youtube.com',
    'not a URL',
    undefined,
  ]) {
    assert.equal(matchesDomain({ url, title: 'youtube.com' }, 'youtube.com'), false, String(url));
  }
  assert.equal(
    matchesDomain({ url: 'https://youtube.com/watch', title: 'Other' }, 'youtube.com', 'wood'),
    false,
  );
  assert.equal(matchesDomain({ url: 'https://youtube.com/watch' }, 'youtube.com', 'watch'), true);
  assert.equal(domainFromUrl('moz-extension://abc/index.html'), null);
  assert.equal(domainFromUrl('about:blank'), null);
});

test('flat results include pins and collapsed descendants across folders in tree order', () => {
  const groups = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'design', name: 'Design', parentId: 'work' },
    { id: 'later', name: 'Later', parentId: null },
  ];
  const tabs = [
    { id: 1, groupId: 'work', index: 0, url: 'https://youtube.com/1' },
    { id: 2, groupId: 'design', index: 1, url: 'https://example.com', collapsed: true },
    { id: 3, groupId: 'design', index: 2, parentTabId: 2, url: 'https://youtube.com/3' },
    { id: 4, groupId: 'later', index: 3, url: 'https://music.youtube.com/4' },
    { id: 5, groupId: null, index: 4, url: 'https://youtube.com/5' },
    { id: 6, groupId: 'later', index: 5, pinned: true, url: 'https://youtube.com/6' },
    { id: 7, groupId: 'later', index: 6, parentTabId: 6, url: 'https://youtube.com/7' },
  ].map((tab) => ({ parentTabId: null, ...tab }));
  const before = structuredClone(tabs);
  const index = createTreeIndex({ groups, tabs });
  assert.deepEqual(
    domainResults(index, 'youtube.com').map((tab) => tab.id),
    [6, 3, 1, 4, 7, 5],
  );
  assert.deepEqual(tabs, before);
});

test('results sort by creation, viewing, natural title or tree order without moving real tabs', () => {
  const tabs = [
    { id: 1, title: 'Video 10', openedAt: 300, lastAccessed: 200 },
    { id: 2, title: 'video 2', openedAt: 100, lastAccessed: 400, pinned: true },
    { id: 3, title: 'Another', openedAt: 200, lastAccessed: 300 },
    { id: 4, title: 'Unknown', openedAt: NaN, lastAccessed: 0 },
    { id: 5, title: 'video 2', openedAt: 300, lastAccessed: 200 },
  ].map((tab, index) => ({
    ...tab,
    index,
    groupId: null,
    parentTabId: null,
    url: `https://youtube.com/${tab.id}`,
  }));
  const before = structuredClone(tabs);
  const index = createTreeIndex({ groups: [], tabs });
  const ids = (sort, query = '') =>
    domainResults(index, 'youtube.com', query, sort).map((tab) => tab.id);
  assert.deepEqual(ids(), [1, 5, 3, 2, 4]);
  assert.deepEqual(ids('newest'), ids());
  assert.deepEqual(ids('invalid'), ids());
  assert.deepEqual(ids('oldest'), [2, 3, 1, 5, 4]);
  assert.deepEqual(ids('viewed'), [2, 3, 1, 5, 4]);
  assert.deepEqual(ids('title'), [3, 4, 2, 5, 1]);
  assert.deepEqual(ids('tree'), [2, 1, 3, 4, 5]);
  assert.deepEqual(ids('newest', 'video'), [1, 5, 2]);
  assert.deepEqual(tabs, before);
});
