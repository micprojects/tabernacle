import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  iterationOptions,
  iterationFixture,
  iterationLimits,
  validateNoise,
  assessMetric,
} from '../scripts/memory/iteration-policy.js';
import { lowerGuardLimits, memoryGuard } from '../scripts/memory/common.js';
import { comparisons, iterationHtml, nativeMetrics } from '../scripts/memory/iteration-report.js';

const now = Date.now();

function calibration() {
  return {
    kind: 'optimisation-noise',
    status: 'completed',
    contextKey: 'matching',
    baselineHash: 'same',
    requestedPairs: 5,
    finishedAt: new Date(now).toISOString(),
    runs: Array.from({ length: 10 }, (_, i) => ({
      pair: Math.floor(i / 2) + 1,
      role: i % 2 ? 'candidate' : 'baseline',
      status: 'completed',
      sourceHash: 'same',
      metrics: { ms: 100 },
    })),
  };
}

test('routine commands select the bounded benchmark and stress remains explicit', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const name of ['benchmark:optim', 'benchmark:memory', 'benchmark:memory:firefox'])
    assert.equal(scripts[name], 'node scripts/benchmark-optimisation.js');
  assert.match(scripts['benchmark:memory:stress'], /--stress/);
  assert.match(scripts['benchmark:memory:firefox:stress'], /--stress --tabs 100 --windows 2/);
  assert.equal(iterationOptions([]).pairs, 3);
  assert.equal(iterationOptions([]).baseline, 'HEAD');
  assert.equal(iterationOptions(['--confirm']).pairs, 5);
  assert.equal(iterationOptions(['--pilot']).pairs, 1);
  assert.equal(iterationFixture.native.tabs, 1000);
  assert.equal(iterationFixture.native.livePages, 1);
  assert.equal(Math.max(...iterationFixture.synthetic.map((f) => f.tabs)), 10000);
  for (const args of [
    ['--tabs', '60000'],
    ['--pairs', '100'],
    ['--confirm', '--pilot'],
    ['--baseline'],
  ])
    assert.throws(() => iterationOptions(args));
});

test('iteration limits can only tighten the existing independent watchdog', () => {
  assert.deepEqual(lowerGuardLimits(iterationLimits), iterationLimits);
  for (const limits of [
    { maxRssBytes: 5 * 1024 ** 3 },
    { maxMs: 31 * 60000 },
    { maxMs: 0 },
    { maxMs: NaN },
    { mystery: 1 },
  ])
    assert.throws(() => lowerGuardLimits(limits), /Invalid or raised/);
  const safe = { pressureLevel: 1, pressurePercent: 50, rssBytes: 2.5 * 1024 ** 3, elapsedMs: 0 };
  assert.equal(memoryGuard(safe, iterationLimits), null);
  assert.equal(iterationLimits.maxRssBytes, 4 * 1024 ** 3);
  assert.equal(memoryGuard({ ...safe, rssBytes: 3 * 1024 ** 3 }, iterationLimits), null);
  assert.equal(memoryGuard({ ...safe, rssBytes: 4 * 1024 ** 3 - 1 }, iterationLimits), null);
  assert.match(memoryGuard({ ...safe, rssBytes: 4 * 1024 ** 3 }, iterationLimits), /4 GiB/);
  assert.match(memoryGuard({ ...safe, pressureLevel: 4 }, iterationLimits), /critical/);
  assert.match(
    memoryGuard({ ...safe, pressurePercent: 19, lowPressureSamples: 3 }, iterationLimits),
    /20%/,
  );
  assert.match(memoryGuard({ ...safe, elapsedMs: 5 * 60000 }, iterationLimits), /5 minute/);
  assert.match(
    memoryGuard({ ...safe, pressurePercent: 29 }, { ...iterationLimits, start: true }),
    /30%/,
  );
  assert.match(memoryGuard({ ...safe, idleMs: 60000 }, iterationLimits), /60 seconds/);
});

test('calibration requires five complete same-source pairs, a matching context and recent evidence', () => {
  assert.equal(validateNoise(calibration(), 'matching', now), true);
  assert.equal(validateNoise(calibration(), 'other runtime/source/fixture/harness', now), false);
  const mutations = [
    (r) => {
      r.status = 'inconclusive';
    },
    (r) => {
      r.requestedPairs = 3;
    },
    (r) => {
      r.finishedAt = new Date(now - 25 * 3600000).toISOString();
    },
    (r) => {
      r.finishedAt = new Date(now + 1000).toISOString();
    },
    (r) => {
      r.runs.pop();
    },
    (r) => {
      r.runs[0].role = 'candidate';
    },
    (r) => {
      r.runs[0].sourceHash = 'different';
    },
    (r) => {
      r.runs[0].status = 'failed';
    },
    (r) => {
      r.runs[0].metrics.ms = null;
    },
  ];
  for (const mutate of mutations) {
    const report = calibration();
    mutate(report);
    assert.equal(validateNoise(report, 'matching', now), false);
  }
});

test('screening never labels a timing gain proven and noisy or uncalibrated differences stay inconclusive', () => {
  const noise = [99, 100, 101, 99, 100, 101, 100, 100, 100, 100];
  assert.match(assessMetric([100, 100, 100], [70, 70, 70], noise).verdict, /Promising/);
  assert.equal(
    assessMetric([100, 100, 100, 100, 100], [70, 70, 70, 70, 70], noise, { confirmed: true })
      .verdict,
    'Demonstrated improvement',
  );
  assert.match(assessMetric([100, 100, 100], [70, 70, 70]).verdict, /Uncalibrated/);
  assert.equal(assessMetric([100], [1], noise, { confirmed: true }).verdict, 'Pilot only');
  assert.equal(
    assessMetric([100, 100, 100], [97, 99, 102], noise).verdict,
    'No demonstrated change',
  );
  assert.match(assessMetric([100, 100, 100], [120, 120, 120], noise).verdict, /Investigate/);
  assert.equal(
    assessMetric([100, 100, 100], [105, 105, 105], noise).verdict,
    'No demonstrated change',
  );
  assert.equal(
    assessMetric([100, 100, 100], [0, 0, 0], [], { deterministic: true }).verdict,
    'Repeatable work reduction',
  );
});

test('resource-stopped reports cannot produce comparison verdicts and HTML escapes input', () => {
  assert.deepEqual(comparisons({ kind: 'optimisation-comparison', status: 'inconclusive' }), []);
  const html = iterationHtml({
    status: 'failed',
    error: '<script>bad()</script>',
    requestedPairs: 3,
  });
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;'));
  assert(html.includes('No matching A/A calibration'));
});

function memory(pid, resident, heap) {
  return {
    processes: [{ pid, type: 'extension' }],
    reports: {
      [`WebExtensions (pid ${pid})`]: {
        resident,
        'resident-unique': resident / 2,
        'heap-allocated': heap,
      },
      'Main process': { resident: 500 },
    },
  };
}

test('native attribution uses a stable shared extension PID and never conflates heap with RAM', () => {
  const phase = (name, pid, resident, heap) => ({
    name,
    elapsedMs: 10,
    cpu: { extensionMs: 2, totalMs: 3 },
    beforeCollection: memory(pid, resident, heap),
    afterCollection: memory(pid, resident - 5, heap - 2),
  });
  const result = {
    phases: [phase('disabled-before', 10, 100, 20), phase('enabled-idle', 10, 150, 30)],
  };
  const metrics = nativeMetrics(result, { peakRssBytes: 2000 }, [
    { complete: true, phase: 'enabled-idle', rssBytes: 160 },
  ]);
  assert.equal(metrics['Firefox/enabled-idle/unforced/added-resident.bytes'], 50);
  assert.equal(metrics['Firefox/enabled-idle/unforced/added-heap-allocated.bytes'], 10);
  assert.equal(metrics['Firefox/enabled-idle/unforced/whole-browser-resident.bytes'], 650);
  assert.equal(metrics['Firefox/sampled-extension-RSS-peak.bytes'], 160);
  result.phases[1] = phase('enabled-idle', 11, 150, 30);
  assert.throws(() => nativeMetrics(result, { peakRssBytes: 2000 }), /process restarted/);
});

test('search frame observations stay separate from complete traversal and accept older results', () => {
  const result = {
    phases: [
      { name: 'disabled-before', elapsedMs: 0, cpu: { extensionMs: 0, totalMs: 0 } },
      {
        name: 'search',
        elapsedMs: 900,
        cpu: { extensionMs: 70, totalMs: 100 },
        samples: [
          { query: 'Fixture 00042', response: { renderFrameMs: 4, nextFrameMs: 10 } },
          { query: 'Fixture', response: { renderFrameMs: 8, nextFrameMs: 16 } },
          { query: '', response: { renderFrameMs: 12, nextFrameMs: 20 } },
        ],
      },
    ],
  };
  const metrics = nativeMetrics(result, { peakRssBytes: 2000 });
  assert.equal(metrics['Firefox/search/elapsed.ms'], 900);
  assert.equal(metrics['Firefox/search/exact-render-frame.ms'], 4);
  assert.equal(metrics['Firefox/search/exact-next-frame.ms'], 10);
  assert.equal(metrics['Firefox/search/broad-render-frame.ms'], 8);
  assert.equal(metrics['Firefox/search/broad-next-frame.ms'], 16);
  assert.equal(metrics['Firefox/search/clear-render-frame.ms'], 12);
  assert.equal(metrics['Firefox/search/clear-next-frame.ms'], 20);
  for (const sample of result.phases[1].samples) delete sample.response;
  const legacy = nativeMetrics(result, { peakRssBytes: 2000 });
  assert.equal(legacy['Firefox/search/elapsed.ms'], 900);
  assert(!Object.keys(legacy).some((key) => key.includes('-frame.ms')));
});

test('resource totals require every active phase and exclude idle, collection and disable costs', () => {
  const names = [
    'enabled-initial',
    'warm-snapshots',
    'search',
    'title-burst',
    'folder-actions',
    'sidebars-reopened',
    'view-cycles',
  ];
  const result = {
    phases: [
      ...names,
      'disabled-before',
      'enabled-idle',
      'quiet-idle',
      'sidebars-closed',
      'disabled-final',
    ].map((name, i) => ({
      name,
      elapsedMs: (i + 1) * 100,
      cpu: { extensionMs: i + 1, totalMs: (i + 1) * 10 },
      windows: [{ samples: [{ round: 1, ms: 1, bytes: 1 }] }],
    })),
  };
  const metrics = nativeMetrics(result, { peakRssBytes: 2000 });
  assert.equal(metrics['Firefox/active-workload/extensionCPU.ms'], 28);
  assert.equal(metrics['Firefox/active-workload/elapsed.ms'], 2800);
  assert.equal(metrics['Firefox/quiet-idle/extensionCPU.ms'], 10);
  result.phases.splice(2, 1);
  assert(
    !('Firefox/active-workload/extensionCPU.ms' in nativeMetrics(result, { peakRssBytes: 2000 })),
  );
});

test('quiet idle is a bounded wait without observer work and participates in fixture identity', async () => {
  assert.equal(iterationFixture.native.quietIdleMs, 5000);
  const source = await readFile(
    new URL('../scripts/memory/iteration-native.js', import.meta.url),
    'utf8',
  );
  const body = source.split("await phase('quiet-idle', async () => {")[1].split(/\n\s*\}\);/)[0];
  assert.match(body, /await wait\(iterationFixture.native.quietIdleMs\)/);
  assert(!/settle\(|browser\.|nativeMemory\(/.test(body));
  assert.match(source, /quietIdleMs: iterationFixture.native.quietIdleMs/);
});

test(
  'the external watchdog actually stops only its owned child at a tightened RSS limit',
  { skip: process.platform !== 'darwin' },
  async () => {
    const { runGuarded } = await import('../scripts/memory/guard.js');
    const result = await runGuarded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      pressure: async () => ({ percent: 50, level: 1 }),
      limits: { maxRssBytes: 1, maxMs: 5000 },
      sampleMs: 25,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    assert.equal(result.status, 'aborted');
    assert.match(result.reason, /RSS reached/);
    assert(result.peakRssBytes > 1);
  },
);

test('legacy stress CLI remains opt-in and rejects pre-retention A/A reports', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { exec, repositoryRoot } = await import('../scripts/memory/common.js');
  const directory = await mkdtemp(resolve(tmpdir(), 'tabernacle-benchmark-cli-'));
  const script = resolve(repositoryRoot, 'scripts/benchmark-memory.js');
  try {
    await assert.rejects(
      exec(process.execPath, [script, '--tabs', '20', '--windows', '2']),
      /requires --stress/,
    );
    const output = resolve(directory, 'small.json');
    await exec(process.execPath, [
      script,
      '--stress',
      '--tabs',
      '20',
      '--windows',
      '2',
      '--output',
      output,
    ]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.status, 'completed');
    assert.equal(report.version, 2);
    assert.equal(report.runs[0].phases[0].displayedTabReferences, 40);
    report.version = 1;
    report.runs.push(structuredClone(report.runs[0]));
    const previous = resolve(directory, 'old-method.json');
    await writeFile(previous, JSON.stringify(report));
    const rejected = resolve(directory, 'rejected.json');
    await assert.rejects(
      exec(process.execPath, [
        script,
        '--stress',
        '--tabs',
        '20',
        '--windows',
        '2',
        '--baseline-root',
        repositoryRoot,
        '--variation-baseline',
        previous,
        '--output',
        rejected,
      ]),
    );
    const failure = JSON.parse(await readFile(rejected, 'utf8'));
    assert.equal(failure.status, 'failed');
    assert.equal(failure.runs.length, 0);
    assert.match(failure.error, /Variation baseline/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
