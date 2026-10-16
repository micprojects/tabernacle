import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceColor } from '../extension/src/appearance-colors.js';
import { folderColors } from '../extension/src/folder-appearance.js';

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return channels
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

test('folder text and container marks remain readable on both neutral surfaces', () => {
  const colors = [
    ...folderColors.map(({ color }) => color),
    '#37adff',
    '#ff9f00',
    '#51cd00',
    '#ff4bda',
    '#000000',
    '#ffffff',
  ];
  for (const color of colors)
    for (const text of [false, true]) {
      const shades = appearanceColor(color, text).match(/#[\da-f]{6}/g);
      assert.equal(shades.length, 2);
      for (const [i, shade] of shades.entries()) {
        const values = [luminance(shade), luminance(i ? '#202020' : '#f7f7f7')].sort(
          (a, b) => a - b,
        );
        assert.ok(
          (values[1] + 0.05) / (values[0] + 0.05) >= (text ? 4.5 : 3),
          `${color}/${text}/${i}`,
        );
      }
    }
});

test('invalid colours fall back without accepting CSS expressions', () => {
  for (const color of [null, undefined, '', 'red', 'var(--text)', '#12', '#abcdef; color:red'])
    assert.equal(appearanceColor(color), null);
  assert.equal(appearanceColor('#37ADFF'), appearanceColor('#37adff'));
});
