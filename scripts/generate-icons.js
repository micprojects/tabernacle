import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { toolbarIconSVG } from './toolbar-icon.js';

// Raster listings cannot follow a theme. Keep their neutral light variant fixed;
// the original SVG adapts to the colour scheme of the page that embeds it.
const source = (await readFile('extension/icons/tabernacle.svg', 'utf8')).replace(
  /\s*<style>[\s\S]*?<\/style>/,
  '',
);
await writeFile('extension/icons/tabernacle-toolbar.svg', toolbarIconSVG());
const sizes = [16, 32, 48, 64, 96, 128, 256, 1024, 4096];
for (const size of sizes) {
  const path =
    size >= 1024 ? `assets/tabernacle-${size}.png` : `extension/icons/tabernacle-${size}.png`;
  // Rasterise at the target size: the vector renderer antialiases curves while
  // keeping pixel-aligned straight edges sharp, without an unnecessary resize.
  await sharp(Buffer.from(source), { density: (72 * size) / 256 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path);
  console.log(`${path}: ${size} × ${size}`);
}
