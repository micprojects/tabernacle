import assert from 'node:assert/strict';
import test from 'node:test';
import { treeLayout, visibleRange, revealOffset } from '../extension/src/tree-geometry.js';

function projection(specs) {
  const visibleRows = specs.map(([key, kind, parentKey = null]) => ({
    key,
    kind,
    parentKey,
    depth: 0,
    visible: true,
    children: [],
  }));
  const byKey = new Map(visibleRows.map((row) => [row.key, row]));
  for (const row of visibleRows) {
    const parent = byKey.get(row.parentKey);
    if (parent) {
      parent.children.push(row);
      row.depth = parent.depth + 1;
    }
  }
  return { visibleRows };
}

test('nested geometry preserves row slots, branch endpoints and sibling positions', () => {
  const input = projection([
    ['g0', 'group'],
    ['g1', 'group', 'g0'],
    ['t1', 'tab', 'g1'],
    ['t2', 'tab', 't1'],
    ['add-child', 'new-tab', 't1'],
    ['t3', 'tab', 'g1'],
    ['add-g1', 'new-tab', 'g1'],
    ['g2', 'group', 'g0'],
    ['add-g2', 'new-tab', 'g2'],
    ['add-g0', 'new-tab', 'g0'],
    ['g3', 'group'],
    ['t4', 'tab'],
    ['add-root', 'new-tab'],
  ]);
  const before = structuredClone(input);
  const layout = treeLayout(input, { gap: 4, groupGap: 8 });
  assert.deepEqual(
    layout.entries.map(({ start, top, end, last, sibling }) => [start, top, end, last, sibling]),
    [
      [0, 0, 330, 9, 0],
      [32, 32, 226, 6, 0],
      [64, 64, 158, 4, 0],
      [94, 94, 124, 3, 0],
      [124, 128, 158, 4, 1],
      [158, 162, 192, 5, 1],
      [192, 196, 226, 6, 2],
      [226, 230, 296, 8, 1],
      [262, 266, 296, 8, 0],
      [296, 300, 330, 9, 2],
      [330, 338, 370, 10, 1],
      [370, 370, 400, 11, 2],
      [400, 404, 434, 12, 3],
    ],
  );
  assert.equal(layout.totalSize, 434);
  assert.equal(layout.sizes.get(null), 4);
  assert.equal(layout.sizes.get('g1'), 3);
  assert.equal(layout.byKey.get('t1'), layout.entries[2]);
  assert.deepEqual(input, before);
});

test('scoped roots, hidden children, fractional spacing and touch action heights remain distinct', () => {
  const input = projection([
    ['folder', 'group', 'scope'],
    ['tab', 'tab', 'scope'],
    ['add', 'new-tab', 'scope'],
  ]);
  input.visibleRows[0].children.push({ visible: false });
  const layout = treeLayout(input, { tabHeight: 38, addHeight: 44, gap: 2.5, groupGap: 8 });
  assert.deepEqual(
    layout.entries.map(({ start, top, height, end }) => [start, top, height, end]),
    [
      [0, 0, 32, 32],
      [32, 32, 38, 70],
      [70, 72.5, 44, 116.5],
    ],
  );
  assert.equal(layout.sizes.get('scope'), 3);
  assert.equal(layout.totalSize, 116.5);
});

test('range lookup agrees with an independent slot intersection across boundaries and jumps', () => {
  const input = projection(
    Array.from({ length: 317 }, (_, i) => [String(i), i % 9 ? 'tab' : 'group']),
  );
  const { entries, totalSize } = treeLayout(input, { tabHeight: 38, gap: 2.5 });
  const offsets = [-50, totalSize, totalSize + 999];
  for (const entry of entries) offsets.push(entry.start - 0.5, entry.start, entry.start + 0.5);
  for (const offset of offsets)
    for (const height of [0.25, 30, 307.5, totalSize * 2]) {
      const top = Math.max(0, offset);
      const intersecting = entries.filter(
        (entry) => entry.top + entry.height > top && entry.start < top + height,
      );
      const expected = intersecting.length
        ? [intersecting[0].index, intersecting.at(-1).index]
        : [entries.length - 1, entries.length - 1];
      const actual = visibleRange(entries, offset, height);
      assert.deepEqual([actual.startIndex, actual.endIndex], expected, `${offset}/${height}`);
    }
});

test('range lookup uses row endpoints rather than enclosing branch endpoints', () => {
  const { entries } = treeLayout(
    projection([
      ['group', 'group'],
      ['tab', 'tab', 'group'],
      ['child', 'tab', 'tab'],
      ['last', 'tab', 'group'],
    ]),
  );
  assert.equal(entries[0].end, 122);
  assert.deepEqual(visibleRange(entries, 0, 70), {
    startIndex: 0,
    endIndex: 2,
    count: 4,
    overscan: 24,
  });
});

test('empty and hidden views have no range; unchanged ranges retain their identity', () => {
  const { entries } = treeLayout(
    projection([
      ['a', 'tab'],
      ['b', 'tab'],
      ['c', 'tab'],
    ]),
  );
  assert.equal(visibleRange([], 0, 300), null);
  assert.equal(visibleRange(entries, 0, 0), null);
  const initial = visibleRange(entries, 1, 31);
  assert.equal(visibleRange(entries, 2, 31, initial), initial);
  assert.notEqual(visibleRange(entries, 31, 31, initial), initial);
  assert.notEqual(visibleRange(entries.slice(0, 2), 1, 31, initial), initial);
  assert.equal(treeLayout({ visibleRows: [] }).totalSize, 0);
});

test('Saved heading occupies one fixed slot without becoming a keyboard row or tree sibling', () => {
  for (const tabHeight of [30, 38]) {
    for (const ordinary of [
      [],
      [
        ['folder', 'group'],
        ['open', 'tab', 'folder'],
      ],
    ]) {
      const input = projection([...ordinary, ['saved1', 'tab'], ['saved2', 'tab']]);
      for (const row of input.visibleRows.slice(-2)) row.mode = 'saved';
      const before = structuredClone(input);
      const layout = treeLayout(input, { tabHeight, gap: 2, groupGap: 6 });
      const start = ordinary.length ? 32 + tabHeight : 0;
      assert.equal(layout.saved.start, start);
      assert.equal(layout.saved.top, start + 34);
      assert.equal(layout.totalSize, start + 34 + 2 * tabHeight);
      assert.equal(layout.entries.length, input.visibleRows.length);
      assert.equal(layout.byKey.get('saved1').top, start + 34);
      assert.equal(layout.byKey.get('saved2').sibling, 1);
      assert.equal(layout.sizes.get(layout.saved.key), 2);
      assert.equal(layout.byKey.get('folder')?.end ?? 0, start);
      assert.deepEqual(input, before);
      for (const offset of [start, start + 15, start + 33, start + 34]) {
        const range = visibleRange(layout.entries, offset, 30);
        assert(range.startIndex <= input.visibleRows.length - 2);
        assert(range.endIndex >= input.visibleRows.length - 2);
      }
    }
  }
});

test('range lookup stays logarithmic for distant jumps and full-height views', () => {
  const { entries } = treeLayout(
    projection(Array.from({ length: 10000 }, (_, i) => [String(i), 'tab'])),
  );
  let reads = 0;
  const observed = new Proxy(entries, {
    get(target, key) {
      if (/^\d+$/.test(String(key))) reads++;
      return target[key];
    },
  });
  for (const [offset, height] of [
    [0, 300000],
    [250000, 500],
    [30, 1],
  ]) {
    reads = 0;
    visibleRange(observed, offset, height);
    assert(reads < 60, `Expected logarithmic lookup, observed ${reads} entry reads`);
  }
});

test('reveals move the minimum distance, use the row height and clamp to scroll bounds', () => {
  const entry = { start: 300, top: 304, height: 30, end: 900 };
  assert.equal(revealOffset(entry, 280, 100, 900), 280);
  assert.equal(revealOffset(entry, 400, 100, 900), 300);
  assert.equal(revealOffset(entry, 0, 100, 900), 234);
  assert.equal(revealOffset(entry, 0, 100, 200), 200);
  assert.equal(revealOffset(entry, 0, 1000, -100), 0);
});
