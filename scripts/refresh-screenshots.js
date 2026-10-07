import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ScreenshotBrowser } from './screenshot-browser.js';
import { resolveScreenshotCrop } from './screenshot-layout.js';
import { installScreenshotResponses, loadScreenshotResponses } from './screenshot-network.js';
import {
  createScreenshotPreviews,
  publishScreenshots,
  screenshotFiles,
  verifyScreenshots,
} from './screenshot-output.js';
import {
  measureScreenshotRegion,
  setupScreenshotDemo,
  showScreenshotScene,
} from './screenshot-scenes.js';

const args = process.argv.slice(2);
assert(
  args.every((arg) => ['--preview', '--help'].includes(arg)),
  'Usage: npm run screenshots:refresh -- [--preview]',
);
if (args.includes('--help')) {
  console.log(
    'npm run screenshots:refresh              Capture, validate and replace all screenshot assets.\nnpm run screenshots:refresh -- --preview  Save a preview without changing tracked images.\n\nUses a new headless Firefox profile. Your normal Firefox can stay open.',
  );
  process.exit(0);
}
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const started = Date.now();
const fixturePath = 'assets/screenshots/screenshots.json';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const responses = await loadScreenshotResponses(fixture, dirname(fixturePath));

async function inputDigest() {
  const hash = createHash('sha256');
  const extensionFiles = (await readdir('extension', { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const files = [
    ...extensionFiles,
    fixturePath,
    'assets/tabernacle-1024.png',
    ...fixture.tabs.map((tab) => join(dirname(fixturePath), tab.favicon)),
  ];
  for (const file of files) hash.update(file).update(await readFile(file));
  return hash.digest('hex');
}

const digest = await inputDigest();
await mkdir('output/screenshots', { recursive: true });
const output = await mkdtemp(resolve('output/screenshots/run-'));
const sources = join(output, 'sources'),
  images = join(output, 'images');
await mkdir(sources);
await mkdir(images);
const resolvedFixture = structuredClone(fixture);
const browser = new ScreenshotBrowser();
const controller = new AbortController();

function interrupt(signal) {
  // The active WebDriver call completes before finally closes this owned session.
  controller.abort(new Error(`Screenshot refresh interrupted (${signal})`));
}

const sigint = () => interrupt('SIGINT'),
  sigterm = () => interrupt('SIGTERM');
process.once('SIGINT', sigint);
process.once('SIGTERM', sigterm);
const check = () => controller.signal.throwIfAborted();
const report = { inputDigest: digest, preview: args.includes('--preview'), output };

try {
  console.log('Starting an isolated headless Firefox…');
  report.environment = await browser.open(fixture, join(output, 'geckodriver.log'));
  check();
  const network = await installScreenshotResponses(browser.driver, responses);
  const initialTabs = await browser.evaluate(async () =>
    (await browser.tabs.query({ currentWindow: true })).map((tab) => tab.id),
  );
  const session = await browser.evaluate(setupScreenshotDemo, fixture, {
    closeHelper: false,
    resizeWindow: false,
  });
  check();
  await browser.evaluate(async (ids) => browser.tabs.remove(ids), initialTabs);
  await browser.evaluate(
    async (fixture, session) => {
      const deadline = Date.now() + 20000;
      let pending;
      do {
        const tabs = await browser.tabs.query({ currentWindow: true });
        pending = fixture.tabs.filter((item) => {
          const tab = tabs.find((tab) => tab.id === session.tabs[item.key]);
          return tab?.status !== 'complete' || tab.title !== item.title || !tab.favIconUrl;
        });
        if (!pending.length) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error(`Demo tabs did not settle: ${pending.map((item) => item.key).join(', ')}`);
    },
    fixture,
    session,
  );
  network.verify();
  const sourceFile = (shot) =>
    shot.sourceFile || shot.file.replace('.png', `@${fixture.capture.scale}x.png`);
  const captured = new Set();
  for (const [index, shot] of fixture.shots.entries()) {
    if (captured.has(sourceFile(shot))) continue;
    check();
    console.log(`Capturing ${shot.file}…`);
    await browser.evaluate(showScreenshotScene, fixture, session, index);
    for (const related of resolvedFixture.shots.filter(
      (item) => sourceFile(item) === sourceFile(shot),
    )) {
      const measured = await browser.evaluate(measureScreenshotRegion, related.framing);
      related.composition.crop = resolveScreenshotCrop(
        related.framing,
        measured,
        fixture.capture.sourceOrigin,
      );
    }
    // Reject moving/loading UI instead of quietly exporting a partial frame.
    let png = await browser.screenshot(fixture.capture),
      stable = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      check();
      await browser.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const next = await browser.screenshot(fixture.capture);
      if (next.equals(png)) {
        stable = true;
        break;
      }
      png = next;
    }
    assert(stable, `${shot.file}: sidebar did not settle`);
    await writeFile(join(sources, sourceFile(shot)), png);
    captured.add(sourceFile(shot));
  }
  await browser.close();
  check();
  const resolvedPath = join(output, 'resolved-fixture.json');
  await writeFile(resolvedPath, JSON.stringify(resolvedFixture, null, 2) + '\n');
  console.log('Exporting PNG/WebP images and checking UI pixels, transparency and borders…');
  await promisify(execFile)(
    process.execPath,
    ['scripts/export-screenshots.js', sources, images, resolvedPath],
    { signal: controller.signal },
  );
  report.shots = await verifyScreenshots(resolvedFixture, sources, images);
  await createScreenshotPreviews(resolvedFixture, images, output);
  check();
  assert.equal(
    await inputDigest(),
    digest,
    'Screenshot inputs changed during capture; rerun against the latest UI',
  );
  if (!report.preview)
    await publishScreenshots(screenshotFiles(fixture), images, resolve('assets/screenshots'));
  report.seconds = Math.round((Date.now() - started) / 1000);
  report.success = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile('output/screenshots/latest.json', JSON.stringify({ output }, null, 2) + '\n');
  console.log(
    `${report.preview ? 'Preview ready' : 'Refreshed all 24 screenshot assets'} in ${report.seconds}s.\nPreview: ${join(output, 'contact-sheet.png')}\nCompositions: ${join(output, 'compositions.png')}\nReport: ${join(output, 'report.json')}`,
  );
} catch (error) {
  report.success = false;
  report.error = error.stack || String(error);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(`${error.message}\nDiagnostics: ${output}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.removeListener('SIGINT', sigint);
  process.removeListener('SIGTERM', sigterm);
}
