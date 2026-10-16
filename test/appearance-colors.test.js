import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceColor, guideColors, labelColor } from '../extension/src/appearance-colors.js';
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

test('guide shades preserve colour and contrast as depth becomes less prominent', () => {
  for (const color of [
    ...folderColors.map(({ color }) => color),
    '#00a7e0',
    '#51cd00',
    '#ffcb00',
    '#ffffff',
    '#000000',
  ]) {
    const shades = guideColors(color).map((pair) => pair.match(/#[\da-f]{6}/g));
    assert.equal(shades.length, 3);
    for (const theme of [0, 1]) {
      let previous = Infinity;
      for (const pair of shades) {
        const values = [luminance(pair[theme]), luminance(theme ? '#202020' : '#ffffff')].sort(
          (a, b) => a - b,
        );
        const contrast = (values[1] + 0.05) / (values[0] + 0.05);
        assert.ok(contrast >= (theme ? 4.6 : 3.1), `${color}/${theme}: ${contrast}`);
        assert.ok(contrast < previous, `${color}/${theme}: depth must become quieter`);
        previous = contrast;
      }
    }
  }
  // Approved B mockup: a green stays green rather than fading towards grey.
  assert.deepEqual(
    guideColors('#45994d').map((pair) => pair.match(/#[\da-f]{6}/g)[0]),
    ['#398e42', '#44994d', '#50a357'],
  );
  assert.equal(guideColors('#00A7E0'), guideColors('#00a7e0'));
  for (const invalid of [null, undefined, 'red', 'var(--text)', '#123']) {
    assert.equal(guideColors(invalid), guideColors('#858585'));
  }
});

test('identity captions keep readable contrast across neutral, hover and selected surfaces', () => {
  const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  for (const color of [
    ...folderColors.map(({ color }) => color),
    '#00a7e0',
    '#f89c24',
    '#00a465',
    '#ffffff',
    '#000000',
  ]) {
    for (const background of [
      [255, 255, 255],
      [242, 242, 242],
      [235, 235, 239],
      [32, 32, 32],
      [52, 52, 52],
      [128, 128, 128],
    ]) {
      for (const target of [7, 4.6]) {
        const shade = labelColor(color, [background], target);
        assert.ok(shade);
        const values = [luminance(shade), luminance(hex(background))].sort((a, b) => a - b);
        assert.ok(
          (values[1] + 0.05) / (values[0] + 0.05) >= 4.5,
          `${color}/${background}/${target}`,
        );
      }
    }
  }
  assert.equal(labelColor('var(--text)', [[255, 255, 255]]), null);
  assert.equal(
    labelColor('#ff0000', [
      [0, 0, 0],
      [255, 255, 255],
    ]),
    null,
  );
});
