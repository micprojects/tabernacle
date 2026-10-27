import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { FrameBrowser } from '../../scripts/memory/frame-browser.js';
import { nativeMemory } from '../../scripts/memory/native.js';
import { repositoryRoot } from '../../scripts/memory/common.js';
import { waitForStableObservation } from '../../scripts/memory/native-settlement.js';

const browser = new FrameBrowser();
const key = `allocation-check-${randomUUID()}`;
const tolerance = 64 * 1024;
const backgroundBytes = 16 * 1024 ** 2;
const sidebarBytes = 8 * 1024 ** 2;
let panel;
let profile;
const checks = [];

async function allocate(background, sidebar) {
  return browser.frame(
    panel.browserId,
    (key, background, sidebar) => {
      const views = browser.extension.getViews();
      const sizes = {
        '/_generated_background_page.html': background,
        '/sidebar.html': sidebar,
      };
      for (const [path, size] of Object.entries(sizes)) {
        const owners = views.filter((view) => view.location.pathname === path);
        if (owners.length !== 1) throw Error('Ambiguous allocation owner');
        const owner = owners[0];
        if (!size) {
          delete owner[key];
          continue;
        }
        if (!owner[key]) {
          Object.defineProperty(owner, key, {
            value: new owner.ArrayBuffer(size),
            configurable: true,
          });
          new owner.Uint8Array(owner[key]).fill(91);
        }
        const bytes = new owner.Uint8Array(owner[key]);
        if (
          owner[key].byteLength !== size ||
          Object.getPrototypeOf(owner[key]) !== owner.ArrayBuffer.prototype ||
          bytes[0] !== 91 || bytes[size - 1] !== 91
        )
          throw Error('Allocation was not held in the expected document realm');
      }
    },
    key,
    background,
    sidebar,
  );
}

try {
  ({ profile } = await browser.open());
  await browser.install(repositoryRoot);
  await browser.show();
  [panel] = (await waitForStableObservation(() => browser.panels(), {
    matches: (panels) => panels.length === 1 && panels.every((row) => row.isTarget && row.open && !row.watched),
    stableSamples: 1,
    label: 'single allocation-test sidebar',
  })).observation;
  await waitForStableObservation(
    () => browser.frame(panel.browserId, () => !document.getElementById('new-tab').disabled),
    { matches: Boolean, stableSamples: 1, label: 'ready allocation-test sidebar' },
  );
  const processes = (await browser.cpu()).filter((process) => process.type === 'extension');
  assert.equal(processes.length, 1);
  const pid = processes[0].pid;

  const capture = async () => {
    assert(await browser.noDebugger());
    const memory = await nativeMemory(browser, true);
    assert.equal(memory.attribution.origin, new URL(browser.sidebarUrl).hostname);
    assert.equal(memory.attribution.anonymized, false);
    assert(memory.minimized);
    const matches = Object.entries(memory.reports).filter(
      ([label]) => label.includes(`(pid ${pid})`) || label.includes(`(pid ${pid},`),
    );
    assert.equal(matches.length, 1);
    const report = matches[0][1];
    assert(report.attributedExplicitReports > 0);
    assert(Number.isSafeInteger(report.attributedExplicitBytes));
    return report.attributedExplicitBytes;
  };

  const baseline = await capture();
  for (const [background, sidebar] of [
    [backgroundBytes, 0],
    [backgroundBytes, sidebarBytes],
    [0, sidebarBytes],
    [0, 0],
  ]) {
    await allocate(background, sidebar);
    const delta = await capture() - baseline;
    const expected = background + sidebar;
    assert(Math.abs(delta - expected) <= tolerance, `Attributed ${delta} bytes; expected ${expected}`);
    checks.push({ expected, delta, tolerance });
  }
} finally {
  try {
    if (panel) await allocate(0, 0);
  } finally {
    await browser.close();
  }
}
await assert.rejects(access(profile), { code: 'ENOENT' });
console.log(JSON.stringify({ passed: true, checks, profileRemoved: true }));
