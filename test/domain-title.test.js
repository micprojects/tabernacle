import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDomainTitle } from '../extension/src/domain-title.js';

const domain = 'news.ycombinator.com';
const tab = (path, title, extra = {}) => ({ url: `https://${domain}${path}`, title, ...extra });
const resolve = (tabs) => resolveDomainTitle(domain, tabs);

test('site title comes from an exact-host homepage, including www and index pages', () => {
  assert.equal(resolve([tab('/', 'Hacker News')]), 'Hacker News');
  assert.equal(resolve([tab('/index.html', ' (12) Hacker   News ')]), 'Hacker News');
  assert.equal(
    resolveDomainTitle('youtube.com', [{ url: 'https://www.youtube.com/', title: 'YouTube' }]),
    'YouTube',
  );
  assert.equal(
    resolve([tab('/', 'Hacker News'), tab('/item?id=1', 'Story | Other title')]),
    'Hacker News',
  );
});

test('two different pages can identify a shared site-name suffix', () => {
  for (const separator of [' | ', ' - ', ' – ', ' — ', ' · ', ' • ', ' :: ']) {
    const tabs = [
      tab('/item?id=1', `First story${separator}Hacker News`),
      tab('/item?id=2', `Another story${separator}Hacker News`),
    ];
    assert.equal(resolve(tabs), 'Hacker News');
    assert.equal(resolve([...tabs].reverse()), 'Hacker News');
  }
  assert.equal(
    resolve([
      tab('/item?id=1', `${'A long article title '.repeat(20)}| Hacker News`),
      tab('/item?id=2', 'Another story | Hacker News'),
    ]),
    'Hacker News',
  );
});

test('single article titles, repeated tabs and ambiguous suffixes do not become site names', () => {
  for (const tabs of [
    [],
    [tab('/item?id=1', 'First story | Hacker News')],
    [tab('/item?id=1', 'First story'), tab('/item?id=2', 'Another story')],
    [tab('/item?id=1', 'First | Hacker News'), tab('/item?id=1#comment', 'Other | Hacker News')],
    [tab('/item?id=1', 'Same | Hacker News'), tab('/item?id=2', 'Same | Hacker News')],
    [
      tab('/1', 'A | First name'),
      tab('/2', 'B | First name'),
      tab('/3', 'C | Second name'),
      tab('/4', 'D | Second name'),
    ],
  ])
    assert.equal(resolve(tabs), null);
});

test('unrelated hosts, filtered homepages and incomplete or generic titles fall back', () => {
  for (const candidate of [
    tab('/', 'Hacker News', { status: 'loading' }),
    tab('/?q=search', 'Search result'),
    tab('/#article', 'Article'),
    { url: 'https://other.news.ycombinator.com/', title: 'Other product' },
    { url: 'https://example.com/', title: 'Example' },
    { url: 'about:blank', title: 'New tab' },
    ...[
      '',
      'Home',
      'Homepage',
      'Loading…',
      'Just a moment...',
      'Access denied',
      '404 Not Found',
      domain,
      `https://${domain}/`,
      undefined,
      'Long '.repeat(100),
    ].map((title) => tab('/', title)),
  ])
    assert.equal(resolve([candidate]), null);
});
