import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fitScreenshotImage, resolveScreenshotCrop } from '../scripts/screenshot-layout.js';
import { loadScreenshotResponses } from '../scripts/screenshot-network.js';
import { publishScreenshots, screenshotFiles } from '../scripts/screenshot-output.js';

test('measured crops follow taller rows and retain the native capture origin', () => {
  const measured = {
    viewport: { width: 388, height: 711 },
    treeBottom: 650,
    bottom: { bottom: 580.2 },
  };
  assert.deepEqual(resolveScreenshotCrop({ paddingBottom: 10 }, measured, { left: 41, top: 134 }), {
    left: 41,
    top: 134,
    width: 388,
    height: 591,
  });
  measured.top = { top: 34.5 };
  assert.deepEqual(
    resolveScreenshotCrop({ paddingTop: 6, paddingBottom: 10 }, measured, { left: 41, top: 134 }),
    { left: 41, top: 162, width: 388, height: 563 },
  );
});

test('dialog crops round outwards without clipping fractional borders', () => {
  const measured = {
    viewport: { width: 388, height: 711 },
    element: { left: 24.25, top: 150.75, right: 364.5, bottom: 550.1 },
  };
  assert.deepEqual(resolveScreenshotCrop({}, measured, { left: 41, top: 134 }), {
    left: 65,
    top: 284,
    width: 341,
    height: 401,
  });
});

test('offscreen content and crops beyond the capture are rejected', () => {
  const measured = {
    viewport: { width: 388, height: 711 },
    treeBottom: 650,
    bottom: { bottom: 670 },
  };
  assert.throws(
    () => resolveScreenshotCrop({}, measured, { left: 0, top: 0 }),
    /scrolled out of view/,
  );
  measured.bottom.bottom = 645;
  assert.throws(
    () => resolveScreenshotCrop({ paddingBottom: 80 }, measured, { left: 0, top: 0 }),
    /outside/,
  );
});

test('taller UI fits the promotional canvas without changing standalone image configuration', () => {
  const image = { left: 660, top: 28, width: 518 };
  const fitted = fitScreenshotImage(image, 900, { width: 1280, height: 800 });
  assert.equal(fitted.height, 752);
  assert.equal(fitted.top, 24);
  assert.equal(fitted.left + fitted.width / 2, image.left + image.width / 2);
  assert.deepEqual(image, { left: 660, top: 28, width: 518 });
  assert.deepEqual(fitScreenshotImage(image, 730, { width: 1280, height: 800 }), {
    ...image,
    height: 730,
  });
});

test('every demo page has local favicon bytes and an escaped deterministic title', async () => {
  const directory = 'assets/screenshots';
  const fixture = JSON.parse(await readFile(join(directory, 'screenshots.json'), 'utf8'));
  const responses = await loadScreenshotResponses(fixture, directory);
  assert.equal(responses.size, fixture.tabs.length * 2);
  const barr = fixture.tabs.find((tab) => tab.key === 'barr-review');
  const html = responses.get(barr.url).data.toString();
  assert.match(
    html,
    /<title>RESTAURANT BARR, Copenhagen - 2026 Reviews &amp; Information<\/title>/,
  );
  for (const { data } of responses.values()) assert(data.length > 0);
  assert.equal(screenshotFiles(fixture).length, 24);
  fixture.tabs[0].favicon = '../../LICENSE';
  await assert.rejects(loadScreenshotResponses(fixture, directory), /Invalid favicon path/);
});

test('an incomplete export cannot replace any existing screenshots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'screenshot-publish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const images = join(root, 'images'),
    destination = join(root, 'destination');
  await mkdir(images);
  await mkdir(destination);
  await writeFile(join(destination, 'first.png'), 'original');
  await writeFile(join(images, 'first.png'), 'new');
  await assert.rejects(
    publishScreenshots(['first.png', 'missing.png'], images, destination),
    /ENOENT/,
  );
  assert.equal(await readFile(join(destination, 'first.png'), 'utf8'), 'original');
  await writeFile(join(images, 'missing.png'), 'second');
  await publishScreenshots(['first.png', 'missing.png'], images, destination);
  assert.equal(await readFile(join(destination, 'first.png'), 'utf8'), 'new');
  assert.equal(await readFile(join(destination, 'missing.png'), 'utf8'), 'second');
});
