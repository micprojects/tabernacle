import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityItems,
  filterActivity,
  activityDay,
  activityTime,
} from '../extension/src/activity-data.js';
import { normalizeView, VIEW_KEY } from '../extension/src/model.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { recentItems } from '../extension/src/recent-history.js';

const groups = [
  { id: 'work', name: 'Work', parentId: null },
  { id: 'design', name: 'Design', parentId: 'work' },
];

test('expansions are window-local, persisted, deduplicated, and included in the popup', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const api = memoryBrowser({
    groups,
    tabs: [
      { id: 1, windowId: 1 },
      { id: 2, windowId: 2 },
    ],
  });
  const controller = createController(api);
  const send = (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args });
  await send('toggleGroup', { id: 'work' }); // Collapsing is not activity.
  assert.equal(activityItems(await send('snapshot')).length, 0);
  await send('toggleGroup', { id: 'work' });
  let snapshot = await send('snapshot');
  assert.equal(activityItems(snapshot)[0].event, 'Expanded');
  assert.deepEqual(
    recentItems(snapshot, 'folder').map(({ id, event, timestamp }) => ({ id, event, timestamp })),
    [{ id: 'work', event: 'Expanded', timestamp: 10000 }],
  );
  assert.equal(activityItems(await send('snapshot', {}, 2)).length, 0);
  t.mock.timers.tick(1000);
  await send('enterGroup', { id: 'work' });
  snapshot = await send('snapshot');
  const combined = activityItems(snapshot);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].event, 'Opened');
  assert.equal(combined[0].expandedAt, 10000);
  assert.equal(activityItems(snapshot, { folderEvent: 'expanded' })[0].timestamp, 10000);
  assert.deepEqual(api.testing.windowValues.get(1).recentExpandedFolders, [
    { id: 'work', expandedAt: 10000 },
  ]);
  controller.dispose();
  const restarted = createController(api);
  assert.equal(
    activityItems(await restarted.request({ type: 'snapshot', windowId: 1 }))[0].expandedAt,
    10000,
  );
  restarted.dispose();
});

test('explicit expand-all records only collapsed folders; failed writes do not record activity', async () => {
  const api = memoryBrowser({ groups, tabs: [{ id: 1, windowId: 1 }] });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  await send('toggleGroup', { id: 'design' });
  let snapshot = await send('collapseTree', { scopeId: 'work', collapsed: false });
  assert.deepEqual(
    snapshot.view.recentExpandedFolders.map(({ id }) => id),
    ['design'],
  );
  await send('collapseAll', { collapsed: true });
  snapshot = await send('collapseAll', { collapsed: false });
  assert.equal(snapshot.view.recentExpandedFolders.length, 2);
  await api.sessions.setWindowValue(1, VIEW_KEY, { collapsed: ['work'] });
  api.sessions.setWindowValue = async () => {
    throw new Error('Cannot save');
  };
  await assert.rejects(send('toggleGroup', { id: 'work' }), /Cannot save/);
  assert.equal((await send('snapshot')).view.recentExpandedFolders, undefined);
  controller.dispose();
});

test('both screens follow interleaved tab views, closures, folder visits and expansions to the millisecond', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 20_000 });
  const api = memoryBrowser({
    groups,
    events: true,
    tabs: [
      { id: 1, windowId: 1, title: 'Viewed' },
      { id: 2, windowId: 1, title: 'Closed' },
    ],
  });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  const sequence = (items) => items.map(({ title, timestamp, event }) => [title, timestamp, event]);
  await send('enterGroup', { id: 'work' });
  t.mock.timers.tick(1);
  await api.tabs.update(1, { active: true });
  t.mock.timers.tick(1);
  await send('toggleGroup', { id: 'design' });
  await send('toggleGroup', { id: 'design' });
  t.mock.timers.tick(1);
  await send('closeTab', { id: 2 });
  let snapshot = await send('snapshot');
  const expected = [
    ['Closed', 20_003, undefined],
    ['Design', 20_002, 'Expanded'],
    ['Viewed', 20_001, undefined],
    ['Work', 20_000, 'Opened'],
  ];
  assert.deepEqual(sequence(activityItems(snapshot)), expected);
  assert.deepEqual(sequence(recentItems(snapshot)), expected);
  for (const kind of ['viewed', 'closed', 'folder'])
    assert.deepEqual(
      sequence(filterActivity(activityItems(snapshot), { kind })),
      sequence(recentItems(snapshot, kind)),
    );

  // Revisiting moves the existing folder to the top without duplicating it.
  t.mock.timers.tick(1);
  await send('enterGroup', { id: 'design' });
  snapshot = await send('snapshot');
  const revisited = [expected[1], expected[0], expected[2], expected[3]];
  revisited[0] = ['Design', 20_004, 'Opened'];
  assert.deepEqual(sequence(activityItems(snapshot)), revisited);
  assert.deepEqual(sequence(recentItems(snapshot)), revisited);
  // The page's Expanded filter keeps the expansion's own time, not the later visit.
  assert.deepEqual(
    sequence(
      filterActivity(activityItems(snapshot, { folderEvent: 'expanded' }), { kind: 'folder' }),
    ),
    [['Design', 20_002, 'Expanded']],
  );
  controller.dispose();
});

test('equal timestamps preserve native closed-session and saved folder recency on both screens', () => {
  const state = {
    groups,
    tabs: [{ id: 1, title: 'Viewed', lastAccessed: 2000 }],
    view: {
      recentFolders: [{ id: 'work', enteredAt: 1000 }],
      recentExpandedFolders: [
        { id: 'design', expandedAt: 3000 },
        { id: 'work', expandedAt: 3000 },
      ],
    },
    recentlyClosed: [
      { sessionId: 'z-newest', title: 'Latest close', closedAt: 4000 },
      { sessionId: 'a-older', title: 'Previous close', closedAt: 4000 },
    ],
  };
  const expected = [
    'closed:z-newest',
    'closed:a-older',
    'folder:design',
    'folder:work',
    'viewed:1',
  ];
  for (const items of [activityItems(state), recentItems(state)])
    assert.deepEqual(
      items.map(({ key }) => key),
      expected,
    );
  assert.deepEqual(
    filterActivity(activityItems(state, { folderEvent: 'expanded' }), { kind: 'folder' }).map(
      ({ key }) => key,
    ),
    ['folder:design', 'folder:work'],
  );
});

test('invalid timestamps cannot disrupt chronological ordering and undated closures stay last', () => {
  const state = {
    groups,
    tabs: [
      { id: 1, lastAccessed: Infinity },
      { id: 2, lastAccessed: NaN },
      { id: 3, lastAccessed: '3000' },
      { id: 4, lastAccessed: 1000 },
    ],
    view: {
      recentFolders: [{ id: 'work', enteredAt: Infinity }],
      recentExpandedFolders: [{ id: 'work', expandedAt: 2000 }],
    },
    recentlyClosed: [
      { sessionId: 'undated', closedAt: NaN },
      { sessionId: 'dated', closedAt: 3000 },
    ],
  };
  for (const items of [activityItems(state), recentItems(state)])
    assert.deepEqual(
      items.map(({ key }) => key),
      ['closed:dated', 'folder:work', 'viewed:4', 'closed:undated'],
    );
});

test('expansion records discard invalid, deleted and duplicate IDs and stay bounded', () => {
  const many = Array.from({ length: 110 }, (_, i) => ({ id: `g${i}`, parentId: null }));
  const normalized = normalizeView(
    { groups: many },
    {
      recentExpandedFolders: [
        null,
        {},
        { id: 'missing', expandedAt: 1000 },
        { id: 'g1', expandedAt: -1 },
        { id: 'g2', expandedAt: '2' },
        { id: 'g0', expandedAt: 500 },
        ...many.map(({ id }, i) => ({ id, expandedAt: i + 1 })),
      ],
    },
  );
  assert.equal(normalized.recentExpandedFolders.length, 100);
  assert.deepEqual(normalized.recentExpandedFolders[0], { id: 'g0', expandedAt: 500 });
  assert.equal(new Set(normalized.recentExpandedFolders.map(({ id }) => id)).size, 100);
});

test('page excludes itself and private tabs, searches folder paths, and uses local calendar boundaries', () => {
  const now = new Date(2026, 9, 10, 0, 10).getTime();
  const pageUrl = 'moz-extension://test/activity.html';
  const items = activityItems(
    {
      groups,
      view: {},
      tabs: [
        {
          id: 1,
          title: 'CSS notes',
          groupId: 'design',
          url: 'https://example.org',
          lastAccessed: now - 1200000,
        },
        { id: 2, title: 'Private', incognito: true, lastAccessed: now },
        {
          id: 3,
          title: 'Recent activity',
          url: `${pageUrl}?layout=detail#closed`,
          lastAccessed: now,
        },
      ],
      recentlyClosed: [
        { sessionId: 'page', url: pageUrl, closedAt: now },
        { sessionId: 'closed', title: 'Closed', closedAt: now },
      ],
    },
    { pageUrl },
  );
  assert.equal(items.length, 2);
  assert.equal(filterActivity(items, { query: 'css work design' }).length, 1);
  assert.equal(filterActivity(items, { period: 'today', now })[0].kind, 'closed');
  assert.equal(filterActivity(items, { period: 'yesterday', now })[0].kind, 'viewed');
  assert.equal(activityDay(now - 1200000, now), 'Yesterday');
});

test('activity times preserve relative labels without formatting a clock time', () => {
  const now = new Date(2026, 9, 24, 12).getTime();
  const unexpectedFormat = () => assert.fail('relative labels do not need a formatter');
  for (const [timestamp, expected] of [
    [0, ''],
    [undefined, ''],
    [now + 60000, 'Just now'],
    [now - 59000, 'Just now'],
    [now - 60000, '1m ago'],
    [now - 59 * 60000, '59m ago'],
    [now - 60 * 60000, '1h ago'],
    [now - 1439 * 60000, '23h ago'],
  ]) {
    assert.equal(activityTime(timestamp, now, unexpectedFormat), expected);
  }
});

test('older activity times allow a shared formatter and retain invalid-date behaviour', () => {
  const now = new Date(2026, 9, 24, 12).getTime();
  const formatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const formatted = [];

  const formatTime = (date) => {
    assert.ok(date instanceof Date);
    formatted.push(date.getTime());
    return formatter.format(date);
  };

  const timestamps = [now - 86400000, now - 30 * 86400000];
  for (const timestamp of timestamps) {
    const expected = new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    assert.equal(activityTime(timestamp, now), expected);
    assert.equal(activityTime(timestamp, now, formatTime), expected);
  }
  assert.deepEqual(formatted, timestamps);
  for (const timestamp of [-Infinity, -9e15]) {
    assert.equal(activityTime(timestamp, now, formatTime), 'Invalid Date');
  }
  assert.deepEqual(formatted, timestamps);
});

test('activity enrichment preserves frozen source records and returns independent items', () => {
  const opaque = Object.freeze({ sentinel: 'keep' });
  const state = Object.freeze({
    groups: Object.freeze(groups.map((group) => Object.freeze({ ...group }))),
    tabs: Object.freeze([
      Object.freeze({
        id: 1,
        groupId: 'design',
        title: 'Notes',
        url: 'https://www.example.com/notes',
        lastAccessed: 3000,
        opaque,
      }),
    ]),
    recentlyClosed: Object.freeze([
      Object.freeze({
        sessionId: 'closed',
        title: 'Closed notes',
        url: 'https://www.example.org/closed',
        closedAt: 2000,
        opaque,
      }),
    ]),
    view: Object.freeze({ recentFolders: Object.freeze([{ id: 'work', enteredAt: 1000 }]) }),
  });
  const before = structuredClone(state);
  const items = activityItems(state);
  assert.deepEqual(
    items.map(({ kind }) => kind),
    ['viewed', 'closed', 'folder'],
  );
  assert.equal(items[0].path, 'Work / Design');
  assert.equal(items[0].detail, 'example.com');
  assert.equal(items[1].detail, 'example.org');
  assert.equal(items[2].detail, 'Top level');
  assert.equal(items[2].tabCount, 1);
  assert.deepEqual(items[0].opaque, opaque);
  assert.deepEqual(items[1].opaque, opaque);
  const expected = structuredClone(items);
  for (const item of items) {
    item.title = 'Changed result';
    item.detail = 'Changed detail';
  }
  assert.deepEqual(activityItems(state), expected);
  assert.deepEqual(state, before);
});
