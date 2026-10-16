import test from 'node:test';
import assert from 'node:assert/strict';
import { faviconColour } from '../extension/src/domain-header.js';

test('favicon colour favours the dominant opaque colour over white and transparent padding', () => {
  const pixels = new Uint8ClampedArray([
    ...Array(100).fill([255, 255, 255, 255]).flat(),
    ...Array(100).fill([0, 0, 255, 0]).flat(),
    ...Array(20).fill([240, 10, 20, 255]).flat(),
    ...Array(4).fill([0, 160, 255, 255]).flat(),
  ]);
  assert.deepEqual(faviconColour(pixels), [240, 10, 20]);
  assert.equal(faviconColour(new Uint8ClampedArray([50, 50, 50, 255, 255, 255, 255, 255])), null);
  assert.equal(faviconColour(new Uint8ClampedArray()), null);
});
