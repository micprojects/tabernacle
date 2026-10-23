import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bufferRange } from '../extension/src/tree/viewport-range.js';

const range = (startIndex, endIndex, count = 1000, overscan = 12) => ({
  startIndex,
  endIndex,
  count,
  overscan,
});

test('buffered ranges cover slow scrolling and reversals with bounded retained rows', () => {
  let previous;
  let updates = 0;
  for (const start of [
    ...Array.from({ length: 980 }, (_, i) => i),
    ...Array.from({ length: 980 }, (_, i) => 979 - i),
  ]) {
    const next = bufferRange(range(start, start + 20), previous);
    assert(next.start <= start && next.end >= start + 20);
    assert(next.start >= 0 && next.end < 1000);
    assert(next.end - next.start + 1 <= 45);
    if (next !== previous) updates++;
    previous = next;
  }
  assert(updates < 200, `Expected buffered refills, got ${updates}`);
});

test('an unchanged buffered window keeps its identity until an edge needs refilling', () => {
  const initial = bufferRange(range(100, 120));
  assert.equal(bufferRange(range(103, 123), initial), initial);
  const next = bufferRange(range(108, 128), initial);
  assert.notEqual(next, initial);
  assert(next.end > initial.end);
  assert.equal(bufferRange(range(109, 129), next), next);
});

test('jumps, viewport growth, shrinking lists and empty lists remain covered', () => {
  let previous;
  for (const visible of [
    range(0, 20),
    range(970, 999),
    range(120, 140),
    range(100, 160),
    range(0, 19, 20),
    range(0, -1, 0),
    range(0, 20),
    range(700, 700),
    range(0, 999),
  ]) {
    previous = bufferRange(visible, previous);
    assert(previous.start <= visible.startIndex);
    assert(previous.end >= visible.endIndex);
    assert(previous.start >= 0 && previous.end < visible.count);
  }
});

test('zero overscan never omits a newly visible row', () => {
  let previous;
  for (const start of [0, 1, 4, 50, 48, 0]) {
    previous = bufferRange(range(start, start + 10, 100, 0), previous);
    assert.equal(previous.start, start);
    assert.equal(previous.end, start + 10);
  }
});
