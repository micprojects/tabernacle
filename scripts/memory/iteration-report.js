import assert from 'node:assert/strict';
import { assessMetric } from './iteration-policy.js';
import { percentile } from './common.js';

// Sum each run before comparing medians: this is a fixed workload, not an
// average of percentage improvements or a sum of independent phase medians.
const activePhases = [
  'enabled-initial',
  'warm-snapshots',
  'search',
  'title-burst',
  'folder-actions',
  'sidebars-reopened',
  'view-cycles',
];

function extensionReport(memory) {
  const pids = memory.processes.filter((p) => p.type === 'extension').map((p) => p.pid);
  assert.equal(pids.length, 1, 'The control page must keep one shared extension process alive.');
  const report = Object.entries(memory.reports).find(([name]) =>
    name.includes(`pid ${pids[0]})`),
  )?.[1];
  assert(report, 'Missing extension-process memory report');
  for (const key of ['resident', 'resident-unique', 'heap-allocated'])
    assert(Number.isFinite(report[key]), `Missing ${key}`);
  return { pid: pids[0], ...report };
}

export function nativeMetrics(result, guard, samples = []) {
  const metrics = {};
  const before = result.phases.find((p) => p.name === 'disabled-before');
  for (const phase of result.phases) {
    const prefix = `Firefox/${phase.name}`;
    metrics[`${prefix}/elapsed.ms`] = phase.elapsedMs;
    metrics[`${prefix}/extensionCPU.ms`] = phase.cpu.extensionMs;
    metrics[`${prefix}/browserCPU.ms`] = phase.cpu.totalMs;
    for (const [field, label] of [
      ['beforeCollection', 'unforced'],
      ['afterCollection', 'collected'],
    ]) {
      if (!phase[field]) continue;
      const ext = extensionReport(phase[field]);
      const base = extensionReport(before[field]);
      assert.equal(
        ext.pid,
        base.pid,
        'Extension process restarted; off/on attribution is invalid.',
      );
      for (const key of ['resident', 'resident-unique', 'heap-allocated']) {
        metrics[`${prefix}/${label}/${key}.bytes`] = ext[key];
        if (phase !== before)
          metrics[`${prefix}/${label}/added-${key}.bytes`] = ext[key] - base[key];
      }
      metrics[`${prefix}/${label}/whole-browser-resident.bytes`] = Object.values(
        phase[field].reports,
      ).reduce((sum, row) => sum + (row.resident || 0), 0);
      metrics[`${prefix}/${label}/ghost-windows.count`] = ext.ghostWindows || 0;
    }
    if (phase.sidebars) {
      metrics[`${prefix}/DOM-elements.count`] = phase.sidebars.reduce(
        (sum, row) => sum + row.elements,
        0,
      );
      metrics[`${prefix}/tab-rows.count`] = phase.sidebars.reduce((sum, row) => sum + row.rows, 0);
    }
    if (phase.name === 'warm-snapshots') {
      const samples = phase.windows.flatMap((window) =>
        window.samples.filter((sample) => sample.round > 0),
      );
      metrics[`${prefix}/reply-median.ms`] = percentile(
        samples.map((sample) => sample.ms),
        0.5,
      );
      metrics[`${prefix}/reply-p95.ms`] = percentile(
        samples.map((sample) => sample.ms),
        0.95,
      );
      metrics[`${prefix}/payload.bytes`] = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    }
    if (phase.name === 'search') {
      for (const sample of phase.samples || []) {
        if (!sample.response) continue;
        const query =
          sample.query === '' ? 'clear' : sample.query === 'Fixture' ? 'broad' : 'exact';
        metrics[`${prefix}/${query}-render-frame.ms`] = sample.response.renderFrameMs;
        metrics[`${prefix}/${query}-next-frame.ms`] = sample.response.nextFrameMs;
      }
    }
  }
  const active = activePhases.map((name) => result.phases.find((phase) => phase.name === name));
  if (active.every(Boolean)) {
    metrics['Firefox/active-workload/extensionCPU.ms'] = active.reduce(
      (sum, phase) => sum + phase.cpu.extensionMs,
      0,
    );
    metrics['Firefox/active-workload/elapsed.ms'] = active.reduce(
      (sum, phase) => sum + phase.elapsedMs,
      0,
    );
  }
  metrics['Watchdog/owned-peak.bytes'] = guard.peakRssBytes;
  const resident = samples.filter(
    (sample) => sample.complete && sample.phase !== 'disabled-before',
  );
  if (resident.length)
    metrics['Firefox/sampled-extension-RSS-peak.bytes'] = Math.max(
      ...resident.map((sample) => sample.rssBytes),
    );
  return metrics;
}

export function syntheticMetrics(result) {
  const metrics = {};
  for (const phase of result.phases) {
    const prefix = `Node-${result.fixture.tabs}/${phase.name}`;
    metrics[`${prefix}/elapsed.ms`] = phase.elapsedMs;
    metrics[`${prefix}/retained-heap.bytes`] = phase.memory.heapUsed;
    metrics[`${prefix}/sampled-peak-heap.bytes`] = phase.sampledMemory.maxHeapUsed;
    for (const key of ['reads', 'writes', 'peakReads'])
      metrics[`${prefix}/${key}.count`] = phase.api[key];
    metrics[`${prefix}/payload.bytes`] = phase.messages.bytes;
  }
  return metrics;
}

export function comparisons(report, noise) {
  if (report.status !== 'completed' || report.kind !== 'optimisation-comparison') return [];
  const baseline = report.runs.filter((run) => run.role === 'baseline');
  const candidate = report.runs.filter((run) => run.role === 'candidate');
  if (baseline.length !== report.requestedPairs || candidate.length !== report.requestedPairs)
    return [];
  if (!baseline.length || [...baseline, ...candidate].some((run) => run.status !== 'completed'))
    return [];
  for (const runs of [baseline, candidate]) {
    if (new Set(runs.map((run) => run.pair)).size !== report.requestedPairs) return [];
    runs.sort((a, b) => a.pair - b.pair);
    if (runs.some((run, index) => run.pair !== index + 1)) return [];
  }
  const names = Object.keys(baseline[0].metrics);
  assert(
    [...baseline, ...candidate].every(
      (run) => JSON.stringify(Object.keys(run.metrics)) === JSON.stringify(names),
    ),
    'Comparison metric sets differ',
  );
  return names.map((name) => ({
    name,
    ...assessMetric(
      baseline.map((run) => run.metrics[name]),
      candidate.map((run) => run.metrics[name]),
      noise?.runs.map((run) => run.metrics[name]).filter(Number.isFinite) || [],
      {
        confirmed: report.mode === 'confirm',
        deterministic: /\/(reads|writes|peakReads)\.count$/.test(name),
      },
    ),
  }));
}

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const number = (value) =>
  Number.isFinite(value) ? value.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '—';

export function iterationHtml(report) {
  const rows = (report.comparison || [])
    .map((item) => {
      const scale = item.name.endsWith('.bytes') ? 1e6 : 1;
      const unit = scale === 1e6 ? 'MB' : item.name.endsWith('.ms') ? 'ms' : 'count';
      const format = (value) => `${number(Number.isFinite(value) ? value / scale : null)} ${unit}`;
      return `<tr><th>${escape(item.name)}</th><td>${format(item.baseline.median)}<small>${format(item.baseline.min)}–${format(item.baseline.max)}</small></td><td>${format(item.candidate.median)}<small>${format(item.candidate.min)}–${format(item.candidate.max)}</small></td><td>${number(item.relativeDelta === null ? null : item.relativeDelta * 100)}%</td><td>${escape(item.verdict)}</td></tr>`;
    })
    .join('');
  const highlights = [
    'Firefox/enabled-idle/unforced/added-resident.bytes',
    'Firefox/enabled-idle/collected/added-heap-allocated.bytes',
    'Firefox/warm-snapshots/reply-median.ms',
  ];
  const charts = highlights
    .map((name) => {
      const item = report.comparison?.find((item) => item.name === name);
      if (!item || item.baseline.median <= 0 || item.candidate.median < 0) return '';
      const max = Math.max(item.baseline.median, item.candidate.median);
      return `<figure><figcaption>${escape(name)}</figcaption><div>Baseline <meter min="0" max="${max}" value="${item.baseline.median}"></meter></div><div>Candidate <meter min="0" max="${max}" value="${item.candidate.median}"></meter></div><p>${escape(item.verdict)} (${number(item.relativeDelta === null ? null : item.relativeDelta * 100)}%)</p></figure>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabernacle optimisation benchmark</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f7f7f5;color:#242424;margin:32px auto;padding:0 24px;max-width:1200px}h1{font-size:30px}p{max-width:90ch}small{display:block;color:#666}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #ccc;padding:10px;vertical-align:top}th{font-weight:500;overflow-wrap:anywhere}figure{display:inline-block;max-width:330px;vertical-align:top;margin:10px 20px 20px 0;padding:16px;border:1px solid #ccc;border-radius:6px}figcaption{overflow-wrap:anywhere;font-size:13px}meter{width:200px;max-width:70%}.scroll{overflow:auto}code{overflow-wrap:anywhere}</style><h1>Tabernacle optimisation benchmark</h1><p><strong>${escape(report.status)} · ${escape(report.mode)} · ${report.requestedPairs} pair(s)</strong>. ${escape(report.error || '')}</p><p>Baseline <code>${escape(report.sources?.baseline.commit)}</code>; candidate <code>${escape(report.sources?.candidate.sha256)}</code>. ${escape(report.environment?.firefox || 'No Firefox')} · ${escape(report.environment?.node)}. <a href="report.json">Raw evidence and individual samples</a>.</p><p>${report.noisePath ? 'Matched five-pair A/A calibration applied.' : 'No matching A/A calibration. Timing and memory differences are descriptive only.'} Three-pair screening identifies candidates for confirmation; keep changes only after five-pair confirmation and the relevant regression suites.</p><p>Native: 1,000 mostly discarded tabs, two real sidebar documents, one live update page; complete row order checked. Node: 100 / 1,000 / 10,000 tabs with two readers per window. ${report.syntheticOnly ? '<strong>This run is synthetic only: no Firefox memory evidence.</strong>' : ''}</p>${charts}<p>Added memory is the difference from the same profile with Tabernacle disabled; a small control extension keeps the shared extension process alive. “Unforced” idle is sampled before enabled-memory collection. Later phases have earlier collections in their history. Collected heap measures retention, not ordinary RAM. Whole-browser resident sums may double-count shared pages. Node heap includes fixtures and readers and is not Firefox memory. One-second OS samples include an extension-process RSS peak. Neither this nor the owned-process peak is an exact allocation peak; the latter includes the driver and worker and is primarily a safety metric. CPU totals omit exited processes; elapsed UI observations include a 200 ms stability floor.</p><p>The routine benchmark has a ${number(report.limits?.maxRssBytes / 1024 ** 3)} GiB owned-process stop, normal-pressure preflight and a five-minute per-worker timeout. Resource stops are inconclusive, never passes. This fixture does not replace deep-chain, container, recovery, upgrade, native Find, drag or high-capacity regression suites.</p><div class="scroll"><table><thead><tr><th>Metric</th><th>Baseline median (range)</th><th>Candidate median (range)</th><th>Change</th><th>Assessment</th></tr></thead><tbody>${rows}</tbody></table></div><p>Recorded ${escape(report.finishedAt)}. Harness <code>${escape(report.harness?.sha256)}</code>.</p></html>`;
}
