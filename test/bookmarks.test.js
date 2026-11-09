import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookmarkRows,
  bookmarkUrl,
  bookmarkHighlights,
  bookmarkRoots,
} from '../extension/src/bookmarks.js';
import { demoBookmarks } from '../preview/bookmarks.js';

test('bookmark locations default to Menu and keep unfamiliar Firefox roots accessible', () => {
  const tree = structuredClone(demoBookmarks);
  tree[0].children.push({ id: 'custom', type: 'folder', title: 'Imported', children: [] });
  assert.deepEqual(
    bookmarkRoots(tree).map(({ id, label }) => [id, label]),
    [
      ['menu________', 'Bookmarks'],
      ['toolbar_____', 'Toolbar'],
      ['unfiled_____', 'Other'],
      ['custom', 'Imported'],
    ],
  );
  tree[0].children = tree[0].children.filter((node) => node.id !== 'menu________');
  assert.equal(bookmarkRoots(tree)[0].id, 'toolbar_____');
});

test('Mobile bookmarks appear when populated without exposing the empty Sync root', () => {
  const tree = structuredClone(demoBookmarks);
  const mobile = { id: 'mobile______', type: 'folder', title: 'Mobile Bookmarks', children: [] };
  tree[0].children.push(mobile);
  assert.equal(bookmarkRoots(tree).length, 3);
  mobile.children.push({
    id: 'phone',
    type: 'bookmark',
    title: 'Saved on phone',
    url: 'https://example.test/',
  });
  assert.equal(bookmarkRoots(tree).at(-1).label, 'Mobile');
  assert.equal(bookmarkRows(tree, new Set(), '', new Set(), mobile.id)[0].id, 'phone');
});

test('location projection removes only the native root row and scopes search without changing bookmarks', () => {
  const original = structuredClone(demoBookmarks);
  const rows = bookmarkRows(
    demoBookmarks,
    new Set(['design-bookmarks']),
    '',
    new Set(),
    'toolbar_____',
  );
  assert.deepEqual(
    rows.map(({ id, depth, parentId }) => [id, depth, parentId]),
    [
      ['design-bookmarks', 1, undefined],
      ['mdn-bookmark', 2, 'design-bookmarks'],
      ['fonts-bookmark', 2, 'design-bookmarks'],
      ['news-bookmark', 1, undefined],
    ],
  );
  assert.deepEqual(bookmarkRows(demoBookmarks, new Set(), 'MDN', new Set(), 'menu________'), []);
  assert.deepEqual(
    bookmarkRows(demoBookmarks, new Set(), 'MDN', new Set(), 'toolbar_____').map(({ id }) => id),
    ['design-bookmarks', 'mdn-bookmark'],
  );
  assert.deepEqual(bookmarkRows(demoBookmarks, new Set(), '', new Set(), 'missing'), []);
  assert.deepEqual(demoBookmarks, original);
});

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

test('bookmark search combines words across the title and address in any order', () => {
  const rows = bookmarkRows(demoBookmarks, new Set(), 'mozilla MDN');
  assert.deepEqual(
    rows.map((row) => row.id),
    ['toolbar_____', 'design-bookmarks', 'mdn-bookmark'],
  );
  assert.equal(rows.filter((row) => row.match).length, 1);
  assert.equal(rows.at(-1).match, true);
  assert.deepEqual(bookmarkRows(demoBookmarks, new Set(), 'MDN fonts'), []);
});

test('bookmark highlights merge overlaps and preserve literal titles', () => {
  const title = '<MDN> Web Docs & MDN';
  const parts = bookmarkHighlights(title, 'mdn web docs web');
  assert.equal(parts.map((part) => part.text).join(''), title);
  assert.deepEqual(
    parts.filter((part) => part.match).map((part) => part.text),
    ['MDN', 'Web', 'Docs', 'MDN'],
  );
  assert.deepEqual(bookmarkHighlights('Bookmarks', 'book bookmarks'), [
    { text: 'Bookmarks', match: true },
  ]);
  assert.deepEqual(bookmarkHighlights('İstanbul guide', 'guide'), [
    { text: 'İstanbul ', match: false },
    { text: 'guide', match: true },
  ]);
});
