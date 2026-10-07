import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setupScreenshotDemo } from './screenshot-scenes.js';

const fixture = JSON.parse(await readFile('assets/screenshots/screenshots.json', 'utf8'));
await mkdir('output/promo', { recursive: true });
await writeFile(
  'output/promo/setup-console.js',
  `(${setupScreenshotDemo.toString()})(${JSON.stringify(fixture)}).catch(error => { globalThis.tabernaclePromoSetupRunning = false; console.error(error); });\n`,
);
console.log('Paste output/promo/setup-console.js into the console of Tabernacle’s sidebar.html.');
