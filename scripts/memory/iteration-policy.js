import { resolve } from 'node:path';
import { compareSamples } from './summary.js';

export const iterationFixture = {
  version: 2,
  seed: 17,
  native: { tabs: 1000, windows: 2, livePages: 1, cycles: 3, idleMs: 1500, quietIdleMs: 5000 },
  synthetic: [
    { tabs: 100, windows: 1 },
    { tabs: 1000, windows: 2 },
    { tabs: 10000, windows: 9 },
  ],
  readers: 2,
};
export const iterationLimits = { maxRssBytes: 4 * 1024 ** 3, maxMs: 5 * 60000 };

export function iterationOptions(argv) {
  const result = { syntheticOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--confirm', '--calibrate', '--pilot'].includes(arg)) {
      if (result.mode) throw new Error('Choose one benchmark mode.');
      result.mode = arg.slice(2);
    } else if (arg === '--synthetic-only') result.syntheticOnly = true;
    else if (arg === '--report') result.report = true;
    else if (arg === '--working-tree') result.workingTree = true;
    else if (arg === '--help') result.help = true;
    else if (['--baseline', '--candidate', '--output', '--noise'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = ['--baseline', '--candidate'].includes(arg) ? value : resolve(value);
    } else
      throw new Error(
        `Unknown iteration option: ${arg}. Use the explicit stress commands for larger workloads.`,
      );
  }
  if (result.workingTree && result.candidate)
    throw new Error('Choose --candidate REF or --working-tree, not both.');
  result.baseline ??= result.report ? 'latest-release' : 'HEAD';
  result.candidate ??= result.report && !result.workingTree ? 'HEAD' : undefined;
  result.mode ??= result.report ? 'confirm' : 'screen';
  result.pairs = result.mode === 'pilot' ? 1 : result.mode === 'screen' ? 3 : 5;
  return result;
}

export function validateNoise(report, context, now = Date.now()) {
  if (report?.status !== 'completed' || report.kind !== 'optimisation-noise') return false;
  if (report.contextKey !== context || report.requestedPairs !== 5) return false;
  const age = now - Date.parse(report.finishedAt);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) return false;
  if (report.runs?.length !== 10) return false;
  const metrics = JSON.stringify(Object.keys(report.runs[0]?.metrics || {}).sort());
  for (let pair = 1; pair <= 5; pair++) {
    const samples = report.runs.filter((run) => run.pair === pair);
    if (samples.length !== 2 || new Set(samples.map((run) => run.role)).size !== 2) return false;
    for (const run of samples)
      if (
        !['baseline', 'candidate'].includes(run.role) ||
        run.status !== 'completed' ||
        run.sourceHash !== report.baselineHash ||
        !run.metrics ||
        JSON.stringify(Object.keys(run.metrics).sort()) !== metrics ||
        !Object.keys(run.metrics).length ||
        Object.values(run.metrics).some((value) => !Number.isFinite(value))
      )
        return false;
  }
  return true;
}

export function assessMetric(
  baseline,
  candidate,
  noise = [],
  { confirmed = false, deterministic = false } = {},
) {
  const comparison = compareSamples(baseline, candidate, noise);
  const enough = baseline.length >= 3 && baseline.length === candidate.length;
  const repeatable =
    comparison.delta < 0
      ? candidate.every((value, i) => value < baseline[i])
      : candidate.every((value, i) => value > baseline[i]);
  const magnitude = Math.abs(comparison.delta);
  const measurable =
    enough &&
    repeatable &&
    comparison.baselineVariationRange !== null &&
    magnitude > 3 * comparison.baselineVariationRange;
  const reduction = comparison.relativeDelta !== null && comparison.relativeDelta < -0.1;
  const regression = comparison.relativeDelta !== null && comparison.relativeDelta > 0.1;
  let verdict = 'No demonstrated change';
  if (!enough) verdict = 'Pilot only';
  else if (
    deterministic &&
    baseline.every((n) => n === baseline[0]) &&
    candidate.every((n) => n === candidate[0])
  )
    verdict =
      comparison.delta < 0
        ? 'Repeatable work reduction'
        : comparison.delta > 0
          ? 'More work; review'
          : 'Unchanged work';
  else if (noise.length < 10) verdict = 'Uncalibrated; run --calibrate';
  else if (measurable && reduction)
    verdict =
      confirmed && baseline.length >= 5
        ? 'Demonstrated improvement'
        : 'Promising; confirm before keeping';
  else if (measurable && regression) verdict = 'Investigate regression';
  return { ...comparison, repeatable, verdict };
}
