import test from 'node:test';
import assert from 'node:assert/strict';
import { audioOptions, validateAudioNoise } from '../scripts/benchmarks/audio/policy.mjs';

test('audio benchmark fixes pair modes and requires calibration for confirmation', () => {
  assert.deepEqual(audioOptions(['screen', 'evidence']), {
    mode: 'screen',
    output: 'evidence',
    baseline: 'HEAD',
    noise: undefined,
  });
  assert.equal(audioOptions(['confirm', 'evidence', 'HEAD', 'noise.json']).noise, 'noise.json');
  for (const args of [
    [],
    ['confirm', 'evidence'],
    ['calibrate', 'evidence', 'HEAD', 'noise.json'],
    ['screen', '--tabs', '60000'],
    ['screen', 'evidence', 'HEAD', 'noise', 'extra'],
  ])
    assert.throws(() => audioOptions(args), /Usage/);
});

function calibration() {
  const hash = '0'.repeat(64);
  return {
    kind: 'audio-noise',
    mode: 'calibrate',
    status: 'completed',
    context: 'context',
    finishedAt: new Date(1000000).toISOString(),
    sources: {
      baseline: { original: { sha256: hash } },
      candidate: { original: { sha256: hash } },
    },
    environment: { firefox: 'Mozilla Firefox 158.0' },
    runs: Array.from({ length: 5 }, (_, index) =>
      ['baseline', 'candidate'].flatMap((role) =>
        [100, 1000].map((count) => ({
          pair: index + 1,
          role,
          count,
          guard: { status: 'completed', peakRssBytes: 1024 },
          result: {
            status: 'completed',
            source: { sha256: hash },
            runtime: { firefox: '158.0' },
            count,
            cpuMs: 500,
            elapsedMs: 4000,
            observation: { rounds: 90, dom: Array(90).fill(40), frames: Array(90).fill(50) },
          },
        })),
      ),
    ).flat(),
  };
}

test('audio calibration requires complete matching same-source pairs and finite metrics', () => {
  const report = calibration();
  assert(validateAudioNoise(report, 'context', 1000001));
  assert(!validateAudioNoise(report, 'other', 1000001));
  assert(!validateAudioNoise(report, 'context', 999999));
  assert(!validateAudioNoise(report, 'context', 1000001 + 24 * 3600000));
  for (const change of [
    (report) => {
      report.runs[0].pair = 5;
    },
    (report) => {
      report.runs[0].count = 60000;
    },
    (report) => {
      report.runs[0].guard.status = 'aborted';
    },
    (report) => {
      report.runs[0].result.source.sha256 = 'other';
    },
    (report) => {
      report.runs[0].result.runtime.firefox = '159.0';
    },
    (report) => {
      report.runs[0].result.cpuMs = NaN;
    },
    (report) => {
      report.runs[0].result.observation.dom.pop();
    },
    (report) => {
      report.runs[0].result.observation.rounds = 89;
    },
    (report) => {
      delete report.runs[0].result.elapsedMs;
    },
    (report) => {
      report.sources.candidate.original.sha256 = 'other';
    },
    (report) => {
      report.finishedAt = 'invalid';
    },
  ]) {
    const changed = structuredClone(report);
    change(changed);
    assert(!validateAudioNoise(changed, 'context', 1000001));
  }
});
