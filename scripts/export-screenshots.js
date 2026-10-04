import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const fixture = JSON.parse(await readFile('assets/screenshots/screenshots.json', 'utf8'));
const source = process.argv[2] || 'output/promo';
const destination = process.argv[3] || 'assets/screenshots';
const { width, height, scale } = fixture.capture;
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

const logo = await sharp('assets/tabernacle-1024.png').resize(52, 52).png().toBuffer();
for (const [index, shot] of fixture.shots.entries()) {
  const input = join(source, shot.sourceFile || shot.file.replace('.png', '@2x.png'));
  const metadata = await sharp(input).metadata();
  assert.equal(metadata.width, fixture.window.width * scale, `${input}: wrong window width`);
  assert.equal(metadata.height, fixture.window.height * scale, `${input}: wrong window height`);
  const { crop, image, title, body, feature, dark } = shot.composition;
  const imageHeight = Math.round((crop.height / crop.width) * image.width);
  assert(image.left + image.width <= width - 40 && image.top + imageHeight <= height - 40);
  const pixels = await sharp(input)
    .extract(Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, value * scale])))
    .resize(image.width, imageHeight)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${image.width}" height="${imageHeight}"><rect width="100%" height="100%" rx="17" fill="white"/></svg>`,
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <radialGradient id="glow"><stop stop-color="${dark ? '#503967' : '#dfd3f0'}"/><stop offset="1" stop-color="${background}"/></radialGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur stdDeviation="17"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="${background}"/>
    <ellipse cx="990" cy="385" rx="520" ry="590" fill="url(#glow)"/>
    <rect x="${image.left}" y="${image.top + 17}" width="${image.width}" height="${imageHeight}" rx="18" fill="${dark ? '#0c0616' : '#443053'}" opacity=".17" filter="url(#shadow)"/>
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
  await sharp(Buffer.from(svg))
    .composite([
      { input: pixels, left: image.left, top: image.top },
      { input: logo, left: 72, top: 55 },
    ])
    .png()
    .toFile(join(destination, shot.file));
  console.log(`${shot.file}: ${width} × ${height} PNG`);
}
