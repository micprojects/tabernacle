import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { toolbarIconSVG } from './toolbar-icon.js';

// Store artwork stays fixed; the transparent toolbar symbol uses neutral light/dark colours.
const source = await readFile('extension/icons/tabernacle.svg');
await writeFile('extension/icons/tabernacle-toolbar.svg', toolbarIconSVG());
const sizes = [16, 32, 48, 64, 96, 128, 256, 1024];
for (const size of sizes) {
  const path =
    size === 1024 ? 'assets/tabernacle-1024.png' : `extension/icons/tabernacle-${size}.png`;
  // Supersample the vector, then downsample once for smoother curve coverage.
  // Keep transparency so the violet edge works on both light and dark surfaces.
  await sharp(source, { density: (72 * size * 4) / 256 })
    .resize(size, size)
    .png()
    .toFile(path);
  console.log(`${path}: ${size} × ${size}`);
}
