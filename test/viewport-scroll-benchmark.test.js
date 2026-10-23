import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  processCpuDelta,
  scrollFixture,
  scrollMetrics,
  scrollOptions,
  scrollOptionalMetrics,
} from '../scripts/benchmarks/viewport/scroll-policy.mjs';
import { comparisons } from '../scripts/memory/iteration-report.js';
import { digest } from '../scripts/memory/iteration-source.js';
import { validateNoise } from '../scripts/memory/iteration-policy.js';
import { nativeMemory } from '../scripts/memory/native.js';

test('scrolling benchmark keeps bounded fixtures and normal pairing policy', () => {
  assert.equal(scrollFixture.tabs, 1000);
  assert.equal(scrollFixture.windows, 1);
  assert.equal(scrollOptions([]).pairs, 3);
  assert.equal(scrollOptions(['--confirm']).pairs, 5);
  assert.equal(scrollOptions(['--calibrate']).pairs, 5);
  assert.equal(scrollOptions(['--pilot']).pairs, 1);
  assert.equal(scrollOptions(['--baseline', 'optim', '--candidate', 'HEAD']).baseline, 'optim');
  for (const args of [
    ['--tabs', '60000'],
    ['--synthetic-only'],
    ['--report'],
    ['--confirm', '--calibrate'],
    ['--candidate', 'HEAD', '--working-tree'],
  ])
    assert.throws(() => scrollOptions(args));
});

test('CPU deltas reject extension restarts and identify omitted exited processes', () => {
  const before = [
    { pid: 1, type: 'extension', cpuTimeNs: 1000000 },
    { pid: 2, type: 'browser', cpuTimeNs: 2000000 },
    { pid: 3, type: 'web', cpuTimeNs: 3000000 },
  ];
  const after = [
    { pid: 1, type: 'extension', cpuTimeNs: 5000000 },
    { pid: 2, type: 'browser', cpuTimeNs: 8000000 },
    { pid: 4, type: 'web', cpuTimeNs: 2000000 },
  ];
  const measured = processCpuDelta(before, after);
  assert.equal(measured.extensionMs, 4);
  assert.equal(measured.totalMs, 10);
  assert.deepEqual(measured.exitedPids, [3]);
  assert.equal(measured.processes.find((process) => process.pid === 4).cpuMs, null);
  assert.throws(() => processCpuDelta(before, [{ ...after[0], pid: 5 }, after[1]]));
});

test('metric extraction preserves independent memory measures and excludes correctness RSS', () => {
  const result = {
    stages: [
      {
        name: 'cold-idle',
        memory: {
          processes: [{ pid: 1, type: 'extension', reportedBytes: 99 }],
          reports: {
            'WebExtensions (pid 1)': {
              resident: 10,
              'resident-unique': 11,
              'heap-allocated': 12,
              'js-main-runtime-gc-heap': 13,
              'resident-phys-footprint': 17,
              orphanDomBytes: 18,
              ghostWindows: 0,
              explicitBytes: 14,
              selectedDomStyleBytes: 15,
              selectedImageBytes: 16,
            },
          },
        },
        dom: { elements: 100, rows: 10 },
      },
    ],
    workloads: [
      {
        mode: 'slow-scroll',
        cpu: { extensionMs: 4, totalMs: 10 },
        elapsedMs: 80,
        frameIntervals: [16, 16, 40],
      },
    ],
  };
  const samples = [
    { complete: true, phase: 'slow-scroll', rssBytes: 20 },
    { complete: true, phase: 'correctness-after-measurement', rssBytes: 200 },
    { complete: true, phase: 'final-collected', rssBytes: 150 },
  ];
  const metrics = scrollMetrics(result, { peakRssBytes: 300 }, samples);
  assert.equal(metrics['Firefox/cold-idle/resident.bytes'], 10);
  assert.equal(metrics['Firefox/cold-idle/process-reported-memory.bytes'], 99);
  assert.equal(metrics['Firefox/sampled-extension-RSS-peak.bytes'], 20);
  assert.equal(metrics['Watchdog/owned-peak.bytes'], 300);
  assert.equal(metrics['Firefox/slow-scroll/frames-over-33ms.count'], 1);
  assert(!Object.hasOwn(metrics, 'Firefox/cold-idle/js-main-runtime-gc-heap.bytes'));
  assert(!Object.hasOwn(metrics, 'Firefox/cold-idle/ghost-windows.count'));
  const optional = scrollOptionalMetrics(result);
  assert.equal(optional['Firefox/cold-idle/resident-phys-footprint.bytes'], 17);
  assert.equal(optional['Firefox/cold-idle/orphanDomBytes.bytes'], 18);
  assert.equal(optional['Firefox/cold-idle/ghost-windows.count'], 0);
  for (const key of [
    'js-main-runtime-gc-heap',
    'resident-phys-footprint',
    'orphanDomBytes',
    'ghostWindows',
  ])
    delete result.stages[0].memory.reports['WebExtensions (pid 1)'][key];
  assert.deepEqual(scrollOptionalMetrics(result), {
    'Firefox/cold-idle/js-main-runtime-gc-heap.bytes': null,
    'Firefox/cold-idle/resident-phys-footprint.bytes': null,
    'Firefox/cold-idle/orphanDomBytes.bytes': null,
    'Firefox/cold-idle/ghost-windows.count': null,
  });
  assert.equal(
    scrollMetrics(result, { peakRssBytes: 300 }, samples)['Firefox/cold-idle/resident.bytes'],
    10,
  );
  assert.throws(() => scrollMetrics(result, { peakRssBytes: 300 }, []));
  delete result.stages[0].memory.reports['WebExtensions (pid 1)'].resident;
  assert.throws(() => scrollMetrics(result, { peakRssBytes: 300 }, samples));
});

test('native memory preserves optional footprint and explicit orphan reporters without double counting', async () => {
  const entries = [
    ['resident', 100],
    ['resident-phys-footprint', 50],
    ['explicit/window-objects/a/dom/orphan-nodes', 7],
    ['explicit/window-objects/b/dom/orphan-nodes', 9],
    ['window-objects/dom/orphan-nodes', 16],
  ];
  const browser = {
    chrome(fn, ...args) {
      return runInNewContext(`(${fn.toString()})(...args)`, {
        args,
        setTimeout,
        clearTimeout,
        Ci: { nsIMemoryReporterManager: {} },
        Cc: {
          '@mozilla.org/memory-reporter-manager;1': {
            getService: () => ({
              getReportsExtended(report, _data, done, _data2, _anonymise, minimise) {
                assert.equal(minimise, false);
                for (const [path, amount] of entries)
                  report('WebExtensions (pid 1)', path, 0, 0, amount);
                done();
              },
            }),
          },
        },
        ChromeUtils: { requestProcInfo: async () => ({ pid: 1, type: 'extension', memory: 80 }) },
      });
    },
  };
  const report = (await nativeMemory(browser)).reports['WebExtensions (pid 1)'];
  assert.equal(report.resident, 100);
  assert.equal(report['resident-phys-footprint'], 50);
  assert.equal(report.explicitBytes, 16);
  assert.equal(report.orphanDomBytes, 16);
  entries.splice(1);
  const unavailable = (await nativeMemory(browser)).reports['WebExtensions (pid 1)'];
  assert.equal(unavailable.orphanDomBytes, null);
  assert(!Object.hasOwn(unavailable, 'resident-phys-footprint'));
});

test('targeted confirmation requires complete pairs and matching five-pair calibration', () => {
  const contextKey = digest({ fixture: scrollFixture, baseline: 'old', harness: 'test' });
  const runs = (candidate) =>
    Array.from({ length: 5 }, (_, index) =>
      ['baseline', 'candidate'].map((role) => ({
        pair: index + 1,
        role,
        sourceHash: 'old',
        status: 'completed',
        metrics: { 'Firefox/slow-scroll/extensionCPU.ms': role === 'candidate' ? candidate : 100 },
      })),
    ).flat();
  const noise = {
    kind: 'optimisation-noise',
    status: 'completed',
    contextKey,
    baselineHash: 'old',
    requestedPairs: 5,
    finishedAt: new Date().toISOString(),
    runs: runs(100),
  };
  assert(validateNoise(noise, contextKey));
  assert(!validateNoise(noise, 'different harness or source'));
  const report = {
    kind: 'optimisation-comparison',
    mode: 'confirm',
    status: 'completed',
    requestedPairs: 5,
    runs: runs(75),
  };
  assert.equal(comparisons(report, noise)[0].verdict, 'Demonstrated improvement');
  assert.equal(
    comparisons({ ...report, mode: 'screen' }, noise)[0].verdict,
    'Promising; confirm before keeping',
  );
  assert.deepEqual(comparisons({ ...report, runs: report.runs.slice(1) }, noise), []);
  assert.deepEqual(comparisons({ ...report, status: 'inconclusive' }, noise), []);
  report.runs[1].metrics['Firefox/slow-scroll/extensionCPU.ms'] = 101;
  assert.equal(comparisons(report, noise)[0].verdict, 'No demonstrated change');
});
