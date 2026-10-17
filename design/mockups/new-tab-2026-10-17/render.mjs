import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = dirname(fileURLToPath(import.meta.url));
const root = resolve(destination, '../../..');
// Extract the existing PNG payloads without changing their pixels. These ICO
// fixtures report a larger container size than the embedded images in Chromium.
await mkdir(resolve(destination, 'favicons'), { recursive: true });
for (const name of ['youtube', 'wikipedia', 'copenhagen', 'metro']) {
  const source = await readFile(resolve(root, `assets/screenshots/favicons/${name}.ico`));
  const frames = [];
  for (let index = 0; index < source.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const length = source.readUInt32LE(entry + 8);
    const offset = source.readUInt32LE(entry + 12);
    const payload = source.subarray(offset, offset + length);
    if (payload.subarray(1, 4).toString() === 'PNG') frames.push(payload);
  }
  frames.sort((a, b) => b.readUInt32BE(16) - a.readUInt32BE(16));
  if (!frames.length) throw new Error(`No PNG frame in ${name}`);
  await writeFile(resolve(destination, `favicons/${name}.png`), frames[0]);
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + '/')) throw new Error('Outside project');
    response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1.5,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/design/mockups/new-tab-2026-10-17/mockup.html`;
  for (const [screen, height, file] of [
    ['new-tab', 960, '01-new-tab.png'],
    ['settings', 1110, '02-new-tab-settings.png'],
  ]) {
    await page.setViewportSize({ width: 1440, height });
    await page.goto(`${url}?screen=${screen}`);
    await page.waitForFunction(() => window.mockupReady);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    const metrics = await page.evaluate(() => ({
      width: innerWidth,
      contentWidth: document.documentElement.scrollWidth,
      height: innerHeight,
      contentHeight: document.documentElement.scrollHeight,
    }));
    await page.screenshot({ path: resolve(destination, file), fullPage: true });
    console.log(JSON.stringify({ screen, file, metrics }));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  server.close();
}
