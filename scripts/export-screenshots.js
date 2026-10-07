import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { fitScreenshotImage } from './screenshot-layout.js';

const fixture = JSON.parse(
  await readFile(process.argv[4] || 'assets/screenshots/screenshots.json', 'utf8'),
);
const source = process.argv[2] || 'output/promo';
const destination = process.argv[3] || 'assets/screenshots';
const { width, height, scale } = fixture.capture;
const sourceSize = fixture.capture.sourceSize || fixture.window;
const sourceOrigin = fixture.capture.sourceOrigin || { left: 0, top: 0 };
const outputScale = fixture.capture.outputScale || 1;
const px = (value) => Math.round(value * outputScale);
const pngOptions = { compressionLevel: 9, adaptiveFiltering: true };
await mkdir(destination, { recursive: true });

function escapeXml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function textLines(lines, x, y, lineHeight, attributes) {
  return `<text x="${x}" y="${y}" ${attributes}>${lines
    .map(
      (line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`,
    )
    .join('')}</text>`;
}

const logo = await sharp('assets/tabernacle-1024.png').resize(px(52), px(52)).png().toBuffer();
for (const [index, shot] of fixture.shots.entries()) {
  const input = join(source, shot.sourceFile || shot.file.replace('.png', `@${scale}x.png`));
  const metadata = await sharp(input).metadata();
  assert.equal(metadata.width, sourceSize.width * scale, `${input}: wrong capture width`);
  assert.equal(metadata.height, sourceSize.height * scale, `${input}: wrong capture height`);
  const { crop, image, title, body, feature, dark } = shot.composition;
  const imageHeight = Math.round((crop.height / crop.width) * image.width);
  const layout = fitScreenshotImage(image, imageHeight, { width, height });
  assert(crop.width * scale >= px(image.width), `${input}: capture would need upscaling`);
  const pixels = await sharp(input)
    .extract({
      left: (crop.left - sourceOrigin.left) * scale,
      top: (crop.top - sourceOrigin.top) * scale,
      width: crop.width * scale,
      height: crop.height * scale,
    })
    .resize(px(image.width), px(imageHeight))
    .composite([
      {
        input: Buffer.from(
          `<svg width="${px(image.width)}" height="${px(imageHeight)}"><rect width="100%" height="100%" rx="${px(17)}" fill="white"/></svg>`,
        ),
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
  const ink = dark ? '#f5f0ff' : '#282232';
  const muted = dark ? '#cbc0dc' : '#62566f';
  const accent = dark ? '#c4a1ff' : '#7542cc';
  const background = dark ? '#211a2d' : '#efebf6';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="glow"><stop stop-color="${dark ? '#503967' : '#dfd3f0'}"/><stop offset="1" stop-color="${background}"/></radialGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur stdDeviation="17"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="${background}"/>
    <ellipse cx="990" cy="385" rx="520" ry="590" fill="url(#glow)"/>
    <rect x="${layout.left}" y="${layout.top + 17}" width="${layout.width}" height="${layout.height}" rx="18" fill="${dark ? '#0c0616' : '#443053'}" opacity=".17" filter="url(#shadow)"/>
    <g font-family="Arial, Helvetica, sans-serif">
      <text x="139" y="91" font-size="26" font-weight="700" fill="${ink}" letter-spacing="-.5">Tabernacle</text>
      <text x="74" y="220" font-size="13" font-weight="700" letter-spacing="2" fill="${accent}">${escapeXml(feature)}</text>
      ${textLines(title, 70, 298, 64, `font-size="56" font-weight="700" letter-spacing="-2" fill="${ink}"`)}
      <rect x="74" y="400" width="46" height="4" rx="2" fill="${accent}"/>
      ${textLines(body, 74, 451, 34, `font-size="22" fill="${muted}"`)}
      <text x="74" y="730" font-size="15" fill="${muted}">Firefox extension</text>
      <text x="493" y="730" font-size="14" fill="${muted}">${String(index + 1).padStart(2, '0')} / ${String(fixture.shots.length).padStart(2, '0')}</text>
    </g>
  </svg>`;
  const composition = await sharp(Buffer.from(svg))
    .composite([
      {
        input:
          layout.width === image.width
            ? pixels
            : await sharp(pixels).resize(px(layout.width), px(layout.height)).png().toBuffer(),
        left: px(layout.left),
        top: px(layout.top),
      },
      { input: logo, left: px(72), top: px(55) },
    ])
    .png(pngOptions)
    .toBuffer();
  await writeFile(join(destination, shot.file), composition);
  await sharp(composition)
    .webp({ lossless: true, effort: 6 })
    .toFile(join(destination, shot.file.replace('.png', '.webp')));

  // Retain the existing one-pixel green frame on standalone website images.
  const uiWidth = px(image.width + 2);
  const uiHeight = px(imageHeight + 2);
  const frame = Buffer.from(
    `<svg width="${uiWidth}" height="${uiHeight}"><rect x="${outputScale / 2}" y="${outputScale / 2}" width="${uiWidth - outputScale}" height="${uiHeight - outputScale}" rx="${px(17.5)}" fill="none" stroke="#81998d" stroke-width="${outputScale}"/></svg>`,
  );
  const standalone = await sharp({
    create: { width: uiWidth, height: uiHeight, channels: 4, background: '#00000000' },
  })
    .composite([
      { input: pixels, left: px(1), top: px(1) },
      { input: frame, left: 0, top: 0 },
    ])
    .png(pngOptions)
    .toBuffer();
  const uiFile = shot.file.replace('.png', '-ui.png');
  await writeFile(join(destination, uiFile), standalone);
  await sharp(standalone)
    .webp({ lossless: true, effort: 6 })
    .toFile(join(destination, uiFile.replace('.png', '.webp')));
  console.log(`${shot.file}: ${px(width)} × ${px(height)}; UI: ${uiWidth} × ${uiHeight}`);
}
