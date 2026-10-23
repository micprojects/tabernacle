import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { percentile } from '../../memory/common.js';
import { iterationOptions } from '../../memory/iteration-policy.js';
import { digest, iterationHarness } from '../../memory/iteration-source.js';

export const scrollFixture = {
  version: 1,
  tabs: 1000,
  windows: 1,
  initialIdleMs: 1500,
  slowStepPx: 24,
  slowStepsPerDirection: 240,
  fullPasses: 6,
  idleMs: [10000, 30000],
};

export function scrollOptions(argv) {
  for (const option of ['--synthetic-only', '--report'])
    assert(!argv.includes(option), `${option} is not a viewport benchmark option.`);
  return iterationOptions(argv);
}

export async function scrollHarness() {
  const base = await iterationHarness();
  const files = ['scroll-runner.mjs', 'scroll-worker.mjs', 'scroll-policy.mjs'];
  const contents = await Promise.all(
    files.map(async (file) => [file, await readFile(new URL(file, import.meta.url), 'utf8')]),
  );
  return { sha256: digest([base.sha256, contents]), shared: base, files };
}

export function processCpuDelta(before, after) {
  const oldExtension = before.filter((process) => process.type === 'extension');
  const newExtension = after.filter((process) => process.type === 'extension');
  assert.equal(oldExtension.length, 1, 'Expected one shared extension process.');
  assert.equal(newExtension.length, 1, 'Expected one shared extension process.');
  assert.equal(oldExtension[0].pid, newExtension[0].pid, 'Extension process restarted.');
  const processes = after.map((process) => {
    const old = before.find((previous) => previous.pid === process.pid);
    return {
      pid: process.pid,
      type: process.type,
      cpuMs: old ? (process.cpuTimeNs - old.cpuTimeNs) / 1e6 : null,
    };
  });
  return {
    extensionMs: processes.find((process) => process.type === 'extension').cpuMs,
    totalMs: processes.reduce((sum, process) => sum + (process.cpuMs || 0), 0),
    processes,
    exitedPids: before
      .filter((process) => !after.some((current) => current.pid === process.pid))
      .map((process) => process.pid),
  };
}

export function scrollMetrics(result, guard, samples = []) {
  const metrics = {};
  let extensionPid;
  for (const stage of result.stages) {
    const processes = stage.memory.processes.filter((process) => process.type === 'extension');
    assert.equal(processes.length, 1, 'Expected one shared extension process.');
    const process = processes[0];
    extensionPid ??= process.pid;
    assert.equal(process.pid, extensionPid, 'Extension process restarted.');
    const memory = Object.entries(stage.memory.reports).find(([name]) =>
      name.includes(`pid ${process.pid})`),
    )?.[1];
    assert(memory, 'Missing extension memory report.');
    const prefix = `Firefox/${stage.name}`;
    for (const key of [
      'resident',
      'resident-unique',
      'heap-allocated',
      'explicitBytes',
      'selectedDomStyleBytes',
      'selectedImageBytes',
    ]) {
      assert(Number.isFinite(memory[key]), `Missing memory metric ${key}.`);
      metrics[`${prefix}/${key}.bytes`] = memory[key];
    }
    metrics[`${prefix}/process-reported-memory.bytes`] = process.reportedBytes;
    if (stage.dom) {
      metrics[`${prefix}/DOM-elements.count`] = stage.dom.elements;
      metrics[`${prefix}/tab-rows.count`] = stage.dom.rows;
    }
  }
  for (const work of result.workloads) {
    const prefix = `Firefox/${work.mode}`;
    metrics[`${prefix}/extensionCPU.ms`] = work.cpu.extensionMs;
    metrics[`${prefix}/browserCPU.ms`] = work.cpu.totalMs;
    metrics[`${prefix}/elapsed.ms`] = work.elapsedMs;
    metrics[`${prefix}/frame-p95.ms`] = percentile(work.frameIntervals, 0.95);
    metrics[`${prefix}/frame-max.ms`] = Math.max(...work.frameIntervals);
    metrics[`${prefix}/frames-over-33ms.count`] = work.frameIntervals.filter(
      (interval) => interval > 33,
    ).length;
    metrics[`${prefix}/steps.count`] = work.frameIntervals.length;
  }
  metrics['Watchdog/owned-peak.bytes'] = guard.peakRssBytes;
  const complete = samples.filter(
    (sample) =>
      sample.complete &&
      !['final-collected', 'correctness-after-measurement'].includes(sample.phase),
  );
  assert(complete.length, 'No extension-process RSS samples.');
  metrics['Firefox/sampled-extension-RSS-peak.bytes'] = Math.max(
    ...complete.map((sample) => sample.rssBytes),
  );
  assert(Object.values(metrics).every(Number.isFinite), 'Missing or non-finite metric.');
  return metrics;
}

export function scrollOptionalMetrics(result) {
  const metrics = {};
  for (const stage of result.stages) {
    const process = stage.memory.processes.find((process) => process.type === 'extension');
    const memory = Object.entries(stage.memory.reports).find(([name]) =>
      name.includes(`pid ${process.pid})`),
    )?.[1];
    for (const key of ['js-main-runtime-gc-heap', 'resident-phys-footprint', 'orphanDomBytes'])
      metrics[`Firefox/${stage.name}/${key}.bytes`] = Number.isFinite(memory?.[key])
        ? memory[key]
        : null;
    metrics[`Firefox/${stage.name}/ghost-windows.count`] = Number.isFinite(memory?.ghostWindows)
      ? memory.ghostWindows
      : null;
  }
  return metrics;
}

export function scrollMarkdown(report) {
  const escape = (value) => String(value ?? '').replace(/[|\r\n]/g, ' ');
  const value = (name, number) =>
    Number.isFinite(number)
      ? `${(number / (name.endsWith('.bytes') ? 1e6 : 1)).toFixed(3)}${name.endsWith('.bytes') ? ' MB' : name.endsWith('.ms') ? ' ms' : ''}`
      : 'N/A';
  return [
    '# Tabernacle targeted scrolling benchmark',
    '',
    `Status: ${escape(report.status)}. Mode: ${report.mode}. Pairs: ${report.requestedPairs}.`,
    `Baseline: ${escape(report.sources.baseline.ref)} (${report.sources.baseline.sha256}).`,
    `Candidate: ${escape(report.sources.candidate.ref)} (${report.sources.candidate.sha256}).`,
    `Runtime: ${escape(report.environment.firefox)}, Node ${report.environment.node}. Harness: ${report.harness.sha256}.`,
    report.noisePath
      ? 'Matched five-pair A/A calibration applied; improvement requires five-pair confirmation, >10% reduction, >3× the full A/A range and agreement in every pair.'
      : 'No matching A/A calibration applied. Differences do not establish an improvement.',
    '',
    'Supplement to benchmark:optim: 1,000 discarded tabs, one sidebar. Slow scrolling uses 24px per animation frame for 240 steps in each direction; jumps traverse the complete tree six times. CPU excludes memory reporting and complete correctness traversal. No profiler or production instrumentation. Memory is unforced until final collection; reporting itself may affect collection timing. Whole-browser CPU omits new/exited processes. Frame times include animation-frame scheduling, not pure render latency.',
    '',
    'Memory includes Firefox runtime and the control extension, not Tabernacle alone. Selected DOM/style and image reporters are partial diagnostic categories. Process-reported memory and resident memory differ and must not be added. Peaks are sampled once per second. All measures are reported below; counts describe workload, not an optimisation verdict. This fixture does not replace interaction, search, accessibility or persistence tests.',
    '',
    ...(report.error ? [`Error: ${escape(report.error)}`, ''] : []),
    '| Metric | Baseline median (range) | Candidate median (range) | Change | Assessment |',
    '| :--- | ---: | ---: | ---: | :--- |',
    ...(report.comparison || []).map((item) => {
      const format = (sample) =>
        `${value(item.name, sample.median)} (${value(item.name, sample.min)}–${value(item.name, sample.max)})`;
      return `| ${escape(item.name)} | ${format(item.baseline)} | ${format(item.candidate)} | ${item.relativeDelta === null ? 'N/A' : `${(item.relativeDelta * 100).toFixed(2)}%`} | ${item.name.endsWith('.count') ? 'Descriptive count; review' : item.verdict} |`;
    }),
    '',
    'Optional memory reporters below are descriptive only and excluded from calibrated verdicts. Every available sample is shown; N/A means unavailable, not zero.',
    '',
    '| Optional reporter | Baseline samples | Candidate samples |',
    '| :--- | :--- | :--- |',
    ...Object.keys(report.runs?.[0]?.optionalMetrics || {}).map((name) => {
      const samples = (role) =>
        report.runs
          .filter((run) => run.role === role)
          .map((run) => value(name, run.optionalMetrics?.[name]))
          .join(', ');
      return `| ${escape(name)} | ${samples('baseline')} | ${samples('candidate')} |`;
    }),
    '',
    'All individual samples, frame intervals, guard observations and correctness results: [report.json](report.json).',
    '',
  ].join('\n');
}
