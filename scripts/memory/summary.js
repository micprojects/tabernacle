import { percentile } from './common.js';

export function sampleRange(values) {
  const samples = values.filter(Number.isFinite);
  return {
    count: samples.length,
    median: percentile(samples, 0.5),
    min: samples.length ? Math.min(...samples) : null,
    max: samples.length ? Math.max(...samples) : null,
  };
}

// Timing and memory are diagnostics, never correctness-test assertions. A/A
// variation is the full observed range, intentionally conservative for small N.
export function compareSamples(baselineValues, candidateValues, variationValues = []) {
  const baseline = sampleRange(baselineValues);
  const candidate = sampleRange(candidateValues);
  const variation = sampleRange(variationValues);
  const delta =
    baseline.median !== null && candidate.median !== null
      ? candidate.median - baseline.median
      : null;
  const variationRange = variation.count > 1 ? variation.max - variation.min : null;
  const relativeDelta = delta !== null && baseline.median > 0 ? delta / baseline.median : null;
  const investigate =
    relativeDelta !== null && variationRange !== null
      ? relativeDelta > 0.1 && delta > 3 * variationRange
      : null;
  return {
    baseline,
    candidate,
    delta,
    relativeDelta,
    baselineVariationRange: variationRange,
    rangeOverlap:
      baseline.count && candidate.count
        ? baseline.min <= candidate.max && candidate.min <= baseline.max
        : null,
    assessment:
      investigate === null
        ? 'A/A variation or comparison samples unavailable; inspect raw samples.'
        : investigate
          ? 'Investigate: regression exceeds both 10% and three times A/A variation.'
          : 'Does not exceed both ordinary regression review thresholds.',
  };
}

export const comparisonPolicy = {
  baselineVariation: 'Full min/max range across supplied A/A samples.',
  ordinaryRegression: 'Investigate when worse by both >10% and >3 times A/A variation.',
  inconclusive: 'After five additional inconclusive pairs, report no demonstrated improvement.',
  timingAssertions: false,
};
