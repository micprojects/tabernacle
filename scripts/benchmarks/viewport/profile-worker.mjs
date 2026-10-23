import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { FrameBrowser } from '../../memory/frame-browser.js';
import { nativeMemory } from '../../memory/native.js';
import { observeSidebar } from '../../memory/native-settlement.js';

const [root, output] = process.argv.slice(2);
assert(process.send, 'Run through profile-runner.mjs and its independent resource guard.');
const browser = new FrameBrowser();
const emit = (type, data = {}) => process.send({ type, ...data });
const result = { status: 'running', tabs: 1000, passes: 6 };
process.once('SIGTERM', () => browser.close().catch(() => {}));
try {
  result.runtime = await browser.open();
  emit('stage', { name: 'create-tabs' });
  for (let offset = 0; offset < result.tabs; offset += 25) {
    await browser.control(async (offset) => {
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          browser.tabs.create({
            url: `https://viewport-profile.invalid/${offset + i}`,
            title: `Profile ${offset + i}`,
            discarded: true,
            active: false,
          }),
        ),
      );
    }, offset);
    emit('progress', { tabs: offset + 25 });
  }
  emit('stage', { name: 'install' });
  await browser.install(root);
  await browser.show();
  let panel;
  for (let attempt = 0; attempt < 150; attempt++) {
    panel = (await browser.panels()).find((p) => p.isTarget && p.open && !p.hidden);
    if (
      panel &&
      (await browser.frame(
        panel.browserId,
        () => document.querySelectorAll('#tree .tab-row').length > 0,
      ))
    )
      break;
    panel = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(panel, 'Sidebar not ready');
  assert(await browser.noDebugger());
  const before = await browser.frame(panel.browserId, observeSidebar, { traverse: true });
  assert.equal(before.rows.length, result.tabs + 1);
  result.before = await nativeMemory(browser, true);
  result.profiler = await browser.chrome(async () => {
    const available = Services.profiler.GetFeatures();
    const features = ['js', 'jsallocations', 'cpu', 'leaf', 'stackwalk'].filter((f) =>
      available.includes(f),
    );
    if (!features.includes('jsallocations'))
      throw new Error('This Firefox build does not support JavaScript allocation profiling.');
    await Services.profiler.StartProfiler(8 * 1024 * 1024, 1, features, ['GeckoMain']);
    return { available, features };
  });
  emit('stage', { name: 'profile-scroll' });
  result.scroll = await browser.frame(
    panel.browserId,
    async (passes) => {
      const tree = document.getElementById('tree');
      window.__viewportWork.tabBuilds = window.__viewportWork.wrapperBuilds = 0;
      performance.mark('viewport-profile-start');
      const maximum = tree.scrollHeight - tree.clientHeight;
      const step = Math.max(1, tree.clientHeight - 60);
      let steps = 0;
      for (let pass = 0; pass < passes; pass++) {
        for (let distance = 0; distance < maximum + step; distance += step) {
          const offset = Math.min(maximum, distance);
          tree.scrollTop = pass % 2 ? maximum - offset : offset;
          tree.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          steps++;
        }
      }
      performance.mark('viewport-profile-end');
      performance.measure(
        'viewport-profile-scroll',
        'viewport-profile-start',
        'viewport-profile-end',
      );
      return {
        steps,
        ...window.__viewportWork,
        mountedRows: tree.querySelectorAll('.tab-row').length,
      };
    },
    result.passes,
  );
  emit('stage', { name: 'save-profile' });
  await browser.chrome(
    async (file) => {
      await Services.profiler.Pause();
      await Services.profiler.dumpProfileToFileAsync(file);
      await Services.profiler.StopProfiler();
    },
    resolve(output, 'profile.json'),
  );
  result.afterUnforced = await nativeMemory(browser, false);
  result.afterCollected = await nativeMemory(browser, true);
  const after = await browser.frame(panel.browserId, observeSidebar, { traverse: true });
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.duplicateRows, []);
  result.status = 'completed';
} catch (error) {
  result.status = 'failed';
  result.error = error.stack;
} finally {
  await browser.close();
  emit('result', { result });
}
if (result.status !== 'completed') process.exitCode = 1;
