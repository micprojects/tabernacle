import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FrameBrowser } from '../../memory/frame-browser.js';
import { nativeMemory } from '../../memory/native.js';
import { observeSidebar, sendNativeResult } from '../../memory/native-settlement.js';
import { fingerprintSource, machineInfo } from '../../memory/common.js';
import { digest } from '../../memory/iteration-source.js';
import { processCpuDelta, scrollFixture, scrollHarness } from './scroll-policy.mjs';

const [root, output] = process.argv.slice(2);
assert(process.send, 'Run through scroll-runner.mjs and its independent resource guard.');
const browser = new FrameBrowser();
const emit = (type, data = {}) => process.send({ type, ...data });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = {
  status: 'running',
  fixture: { ...scrollFixture, sha256: digest(scrollFixture) },
  source: await fingerprintSource(root),
  harness: await scrollHarness(),
  environment: machineInfo(),
  stages: [],
  workloads: [],
};
const started = performance.now();
let panel;
process.once('SIGTERM', () => browser.close().catch(() => {}));

async function sample(name, minimize = false) {
  emit('stage', { name });
  const stage = {
    name,
    elapsedMs: performance.now() - started,
    memory: await nativeMemory(browser, minimize),
  };
  const pids = stage.memory.processes.filter((p) => p.type === 'extension').map((p) => p.pid);
  emit('extension-processes', { pids });
  if (panel) {
    stage.dom = await browser.frame(panel.browserId, () => ({
      elements: document.querySelectorAll('*').length,
      rows: document.querySelectorAll('#tree .tab-row').length,
      error: document.querySelector('#toast.error:not([hidden])')?.textContent || null,
    }));
    assert.equal(stage.dom.error, null, 'Sidebar reported an error.');
  }
  result.stages.push(stage);
  await writeFile(resolve(output, 'partial.json'), JSON.stringify(result, null, 2) + '\n');
}

async function scroll(mode) {
  emit('stage', { name: mode });
  const before = await browser.cpu();
  const work = await browser.frame(
    panel.browserId,
    async (mode, fixture) => {
      const tree = document.getElementById('tree');
      const maximum = Math.max(0, tree.scrollHeight - tree.clientHeight);
      const step = mode === 'slow-scroll' ? fixture.slowStepPx : tree.clientHeight - 60;
      const limit =
        mode === 'slow-scroll' ? fixture.slowStepsPerDirection * fixture.slowStepPx : maximum;
      if (step <= 0 || maximum < limit) throw new Error('Unexpected scrolling geometry.');
      const passes = mode === 'slow-scroll' ? 2 : fixture.fullPasses;
      const frameIntervals = [];
      const start = performance.now();
      // Native scroll events are deliberately not duplicated with synthetic ones.
      for (let pass = 0; pass < passes; pass++) {
        for (let distance = step; distance < limit + step; distance += step) {
          const tick = performance.now();
          const offset = Math.min(limit, distance);
          tree.scrollTop = pass % 2 ? limit - offset : offset;
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          frameIntervals.push(performance.now() - tick);
        }
      }
      // Include the final update in the measured CPU interval.
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
      );
      return {
        mode,
        maximum,
        viewport: tree.clientHeight,
        step,
        limit,
        passes,
        elapsedMs: performance.now() - start,
        frameIntervals,
        finalOffset: tree.scrollTop,
      };
    },
    mode,
    scrollFixture,
  );
  work.cpu = processCpuDelta(before, await browser.cpu());
  assert.equal(work.finalOffset, 0, 'Scroll sequence did not return to the top.');
  result.workloads.push(work);
}

try {
  const runtime = await browser.open();
  result.environment.firefox = runtime.firefox;
  emit('stage', { name: 'create-tabs' });
  for (let offset = 0; offset < scrollFixture.tabs; offset += 25) {
    await browser.control(async (offset) => {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          browser.tabs.create({
            url: `https://viewport-scroll.invalid/${offset + index}`,
            title: `Scroll fixture ${offset + index}`,
            discarded: true,
            active: false,
          }),
        ),
      );
    }, offset);
    emit('progress', { tabs: offset + 25 });
  }
  result.expected = await browser.control(async () =>
    (await browser.tabs.query({ currentWindow: true })).map(({ id, title }) => ({ id, title })),
  );
  assert.equal(result.expected.length, scrollFixture.tabs + 1);
  await sample('before-install');
  emit('stage', { name: 'install' });
  await browser.install(root);
  await browser.show();
  for (let attempt = 0; attempt < 150; attempt++) {
    panel = (await browser.panels()).find((p) => p.isTarget && p.open && !p.hidden);
    if (
      panel &&
      (await browser.frame(
        panel.browserId,
        () =>
          document.readyState === 'complete' &&
          document.fonts.status === 'loaded' &&
          document.querySelectorAll('#tree .tab-row').length > 0,
      ))
    )
      break;
    panel = null;
    await wait(100);
  }
  assert(panel, 'Sidebar not ready.');
  assert(await browser.noDebugger(), 'DevTools must be detached.');
  await wait(scrollFixture.initialIdleMs);
  await sample('cold-idle');
  await scroll('slow-scroll');
  await sample('after-slow-scroll');
  emit('stage', { name: 'slow-natural-idle' });
  await wait(scrollFixture.idleMs[0]);
  await sample('slow-idle-10s');
  await scroll('viewport-jumps');
  const fullFinished = performance.now();
  await sample('after-viewport-jumps');
  for (const idleMs of scrollFixture.idleMs) {
    emit('stage', { name: `full-natural-idle-${idleMs / 1000}s` });
    await wait(Math.max(0, idleMs - (performance.now() - fullFinished)));
    await sample(`full-idle-${idleMs / 1000}s`);
  }
  await sample('final-collected', true);
  emit('stage', { name: 'correctness-after-measurement' });
  const observed = await browser.frame(panel.browserId, observeSidebar, { traverse: true });
  assert.deepEqual(observed.duplicateRows, []);
  assert.deepEqual(observed.rows, result.expected);
  assert.equal(observed.errorToast, null);
  assert.equal(observed.pendingImages, 0);
  assert.equal(observed.brokenImages, 0);
  assert(observed.fontsLoaded);
  assert(await browser.noDebugger());
  result.correctness = { rows: observed.rows.length, duplicates: observed.duplicateRows };
  result.status = 'completed';
} catch (error) {
  result.status = 'failed';
  result.error = error.stack;
} finally {
  emit('closing');
  await browser.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await sendNativeResult(result);
}
if (result.status !== 'completed') process.exitCode = 1;
