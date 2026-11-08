import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkRows, bookmarkUrl } from '../extension/src/bookmarks.js';
import { demoBookmarks } from '../preview/bookmarks.js';

test('bookmark projection keeps Firefox order, hierarchy, empty folders and local folds', () => {
  const original = structuredClone(demoBookmarks);
  const expanded = new Set(['toolbar_____']);
  const rows = bookmarkRows(demoBookmarks, expanded);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['toolbar_____', 'design-bookmarks', 'news-bookmark', 'menu________', 'unfiled_____'],
  );
  assert.equal(rows[1].depth, 2);
  assert.equal(rows[1].expanded, false);
  assert.deepEqual(demoBookmarks, original);
});

test('quick search matches titles, URLs and folders across collapsed branches with ancestors', () => {
  for (const query of ['  MDN  ', 'developer.mozilla.org']) {
    const rows = bookmarkRows(demoBookmarks, new Set(), query);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['toolbar_____', 'design-bookmarks', 'mdn-bookmark'],
    );
    assert(rows.filter((row) => row.folder).every((row) => row.expanded));
  }
  assert.deepEqual(
    bookmarkRows(demoBookmarks, new Set(), 'Design').map((row) => row.id),
    ['toolbar_____', 'design-bookmarks', 'mdn-bookmark', 'fonts-bookmark'],
  );
  assert.deepEqual(bookmarkRows(demoBookmarks, new Set(), 'missing'), []);
  assert.deepEqual(
    bookmarkRows(demoBookmarks, new Set(), 'MDN', new Set(['design-bookmarks'])).map(
      (row) => row.id,
    ),
    ['toolbar_____', 'design-bookmarks'],
  );
});

test('separators are omitted and untitled bookmarks retain their address', () => {
  const tree = [
    {
      children: [
        { id: 'sep', type: 'separator' },
        { id: 'link', type: 'bookmark', title: '', url: 'https://example.org/' },
      ],
    },
  ];
  assert.equal(bookmarkRows(tree, new Set())[0].title, 'https://example.org/');
  assert.equal(bookmarkRows(tree, new Set()).length, 1);
});

test('bookmark addresses cannot execute script or privilege-bearing URLs', () => {
  assert.equal(bookmarkUrl('https://example.org/a?b=1#c'), 'https://example.org/a?b=1#c');
  assert.equal(bookmarkUrl('file:///tmp/reference.html'), 'file:///tmp/reference.html');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    'place:folder=1',
    'about:config',
    'moz-extension://other/page',
    'https://',
  ])
    assert.throws(() => bookmarkUrl(url), /bookmark/);
});
