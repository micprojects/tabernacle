import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture, performanceBrowser } from '../preview/performance-fixture.js';
import { memoryGuard, ownedProcesses, parseOptions, percentile } from '../scripts/memory/common.js';
import { runGuarded } from '../scripts/memory/guard.js';
import { runSynthetic } from '../scripts/memory/synthetic.js';
import { exec, repositoryRoot } from '../scripts/memory/common.js';
import { compareSamples, sampleRange } from '../scripts/memory/summary.js';
import { waitForPreflight } from '../scripts/memory/preflight.js';

test('performance fixtures are deterministic and cover 60,000 tabs in 28 windows', () => {
  const fixture = performanceFixture();
  assert.equal(fixture.tabs.length, 60000);
  assert.equal(fixture.windows.length, 28);
  assert.equal(fixture.memberships.size, 60000);
  assert.deepEqual(
    performanceFixture({ tabs: 40, windows: 3 }),
    performanceFixture({ tabs: 40, windows: 3 }),
  );
  for (const tab of fixture.tabs) {
    const membership = fixture.memberships.get(tab.id);
    for (const ancestor of membership.ancestors) {
      const id = Number(ancestor.slice('perf-tab-'.length));
      assert.equal(fixture.tabs[id - 1].windowId, tab.windowId);
      assert.equal(fixture.memberships.get(id).groupId, membership.groupId);
    }
  }
});

test('Map adapter records overlapping reads and isolates caller mutations', async () => {
  const fixture = performanceFixture({ tabs: 400, windows: 4 });
  const f = performanceBrowser(fixture);
  await Promise.all(
    fixture.tabs.map((tab) => f.api.sessions.getTabValue(tab.id, 'tabernacle.membership.v1')),
  );
  assert.equal(f.stats().peakReads, 400);
  assert.equal(f.stats().reads, 400);
  assert.equal(f.stats().activeReads, 0);
  const record = await f.api.sessions.getTabValue(1, 'tabernacle.membership.v1');
  record.fixtureUnknown.retained = false;
  assert.equal(f.memberships.get(1).fixtureUnknown.retained, true);
  await f.api.tabs.update(1, { title: 'After' });
  assert.equal((await f.api.tabs.query({ windowId: 1 }))[0].title, 'After');
  await f.api.tabs.remove(1);
  await assert.rejects(f.api.sessions.getTabValue(1, 'tabernacle.membership.v1'), /Invalid tab ID/);
  assert.equal(f.native.has(1), false);
  f.resetStats();
  assert.equal(f.stats().reads, 0);
});

test('watchdog thresholds preserve preflight and sustained-pressure rules', () => {
  const safe = { pressurePercent: 45, pressureLevel: 1, rssBytes: 1024, elapsedMs: 0 };
  assert.equal(memoryGuard(safe, { start: true }), null);
  assert.match(memoryGuard({ ...safe, pressureLevel: 2 }, { start: true }), /not normal/);
  assert.match(memoryGuard({ ...safe, pressurePercent: 29 }, { start: true }), /30%/);
  assert.equal(memoryGuard({ ...safe, pressurePercent: 19, lowPressureSamples: 2 }), null);
  assert.match(memoryGuard({ ...safe, pressurePercent: 19, lowPressureSamples: 3 }), /20%/);
  assert.match(memoryGuard({ ...safe, pressureLevel: 4 }), /critical/);
  assert.match(memoryGuard({ ...safe, rssBytes: 4 * 1024 ** 3 }), /4 GiB/);
  assert.match(memoryGuard({ ...safe, elapsedMs: 30 * 60 * 1000 }), /30 minute/);
  assert.match(memoryGuard({ ...safe, stageMs: 10 * 60 * 1000 }), /10 minute/);
  assert.match(memoryGuard({ ...safe, idleMs: 60000 }), /60 seconds/);
  assert.match(memoryGuard({ ...safe, pressurePercent: null }), /could not be measured/);
  assert.match(
    memoryGuard({ ...safe, pressureLevel: null }, { start: true }),
    /could not be measured/,
  );
  assert.match(memoryGuard({ ...safe, pressureLevel: undefined }), /could not be measured/);
});

test('process accounting never selects unrelated Firefox or siblings', () => {
  const selected = ownedProcesses('10 1 500\n11 10 1000\n12 11 2000\n20 1 9000\n21 20 9000\n', 10);
  assert.deepEqual(
    selected.map((p) => p.pid),
    [10, 11, 12],
  );
  assert.equal(
    selected.reduce((sum, p) => sum + p.rssBytes, 0),
    3500 * 1024,
  );
});

test('failed preflight never launches its requested command', async () => {
  const result = await runGuarded('/path/that/must/not/be/launched', [], {
    pressure: async () => ({ percent: 29, level: 1 }),
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.samples.length, 0);
  assert.match(result.reason, /30%/);
});

test('owned process groups include reparented descendants but exclude other sessions', () => {
  const rows = '10 1 500 10\n11 1 1000 10\n12 11 2000 12\n20 1 9000 20\n21 20 9000 20';
  assert.deepEqual(
    ownedProcesses(rows, 10).map((p) => p.pid),
    [10],
  );
  assert.deepEqual(
    ownedProcesses(rows, 10, 10).map((p) => p.pid),
    [10, 11, 12],
  );
});

test(
  'an exited worker cannot hide behind inherited output pipes',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    let descendant;
    const output = [];
    const result = await runGuarded(
      process.execPath,
      [
        '-e',
        `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'],
      {stdio:['ignore', process.stdout, process.stderr]});
    child.unref();
    process.send({pid:child.pid}, () => process.disconnect());
    process.stdout.write('final output');
  `,
      ],
      {
        pressure: async () => ({ percent: 50, level: 1 }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        sampleMs: 25,
        limits: { maxMs: 10000 },

        onMessage(message) {
          descendant = message.pid;
        },

        onOutput(data) {
          output.push(data);
        },
      },
    );
    assert.equal(result.exit.code, 0);
    assert.equal(result.status, 'aborted');
    assert.match(result.reason, /output pipes/);
    assert.equal(Buffer.concat(output).toString(), 'final output');
    assert(result.elapsedMs < 9000);
    assert(
      result.samples.some(
        (sample) => sample.processes > 0 && sample.elapsedMs > result.exit.elapsedMs,
      ),
    );
    const { stdout } = await exec('/bin/ps', ['-o', 'stat=', '-p', String(descendant)]).catch(
      (error) => {
        assert.equal(error.code, 1, 'Unexpected process-query failure');
        return { stdout: '' };
      },
    );
    // Some Unix init processes reap orphans later; a zombie has exited too.
    assert(!stdout.trim() || stdout.trim().startsWith('Z'), 'Owned descendant is still running');
  },
);

test('diagnostic CLI rejects malformed counts and percentile reports have no pass threshold', () => {
  assert.equal(parseOptions([]).tabs, 1000);
  assert.equal(parseOptions(['--stress']).tabs, 60000);
  assert.equal(parseOptions([]).windows, 2);
  assert.equal(parseOptions(['--stress']).windows, 28);
  assert.equal(parseOptions([]).pairs, 5);
  assert.throws(() => parseOptions(['--tabs', '-1']), /Invalid/);
  assert.throws(() => parseOptions(['--windows', '70000']), /Window/);
  assert.throws(() => parseOptions(['--source-root']), /Missing/);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([], 0.95), null);
});

test('synthetic lifecycle diagnostics preserve fixture data and report warm-read counters', async () => {
  const result = await runSynthetic({
    sourceRoot: repositoryRoot,
    tabs: 80,
    windows: 4,
    readers: 2,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.preservedMemberships, true);
  assert.equal(result.fixture.seed, 17);
  assert.equal(result.phases.find((phase) => phase.name === 'cold-readers').api.reads, 80);
  assert.equal(result.phases.find((phase) => phase.name === 'warm-readers').api.reads, 0);
  assert.equal(result.phases.find((phase) => phase.name === 'background-restart').api.reads, 80);
  assert.equal(result.phases.at(-1).name, 'disposed');
  assert.equal(result.phases[0].displayedSnapshots, 8);
  assert.equal(result.phases[0].displayedTabReferences, 160);
  assert.equal(
    result.phases.find((phase) => phase.name === 'readers-closed').displayedTabReferences,
    0,
  );
  assert.equal(
    result.phases.find((phase) => phase.name === 'readers-reopened').displayedTabReferences,
    160,
  );
  assert.equal(result.phases[0].sampledMemory.exactPeak, false);
});

test('diagnostic comparisons use both ordinary review thresholds and supplied A/A variation', () => {
  assert.deepEqual(sampleRange([null, 3, 1, 2, undefined]), {
    count: 3,
    median: 2,
    min: 1,
    max: 3,
  });
  assert.match(compareSamples([100], [120]).assessment, /unavailable/);
  assert.match(compareSamples([100], [120], [98, 102]).assessment, /Investigate/);
  assert.match(compareSamples([100], [120], [95, 105]).assessment, /Does not exceed/);
  assert.match(compareSamples([100], [108], [99, 101]).assessment, /Does not exceed/);
  assert.equal(compareSamples([90, 110], [100, 120], [98, 102]).rangeOverlap, true);
});

test('native preflight waits only for normal pressure and remains bounded', async () => {
  let time = 0;
  let calls = 0;
  const options = {
    timeoutMs: 15000,
    intervalMs: 5000,
    now: () => time,

    wait: async (milliseconds) => {
      time += milliseconds;
    },
  };
  const ready = await waitForPreflight({
    ...options,
    pressure: async () => ({ percent: 40, level: ++calls < 3 ? 2 : 1 }),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.elapsedMs, 10000);
  assert.deepEqual(
    ready.readings.map((reading) => reading.level),
    [2, 2, 1],
  );
  const blocked = await waitForPreflight({
    ...options,
    pressure: async () => ({ percent: 29, level: 1 }),
  });
  assert.equal(blocked.status, 'timed-out');
  assert.equal(blocked.elapsedMs, 15000);
  assert.equal(blocked.readings.length, 4);
});
