import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

// The same full-canvas vector powers Firefox's toolbar, add-on listings and previews.
const source = await readFile('extension/icons/tabernacle-toolbar-full.svg');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 1024];
for (const size of sizes) {
  const path =
    size === 1024 ? 'assets/tabernacle-1024.png' : `extension/icons/tabernacle-${size}.png`;
  // Rasterize the 16-unit SVG at the output resolution instead of enlarging a bitmap.
  await sharp(source, { density: (72 * size) / 16 })
    .resize(size, size)
    .png()
    .toFile(path);
  console.log(`${path}: ${size} × ${size}`);
}
