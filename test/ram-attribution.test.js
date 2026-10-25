import test from 'node:test';
import assert from 'node:assert/strict';
import { idleAttribution } from '../scripts/memory/attribution.js';
import { iterationHtml } from '../scripts/memory/iteration-report.js';
import { iterationMarkdown } from '../scripts/memory/iteration-markdown.js';

const prefix = 'Firefox/idle-1000';
const run = (pair, role, enabled, disabled, scope = prefix) => ({
  pair,
  role,
  status: 'completed',
  metrics: {
    [`${scope}/enabled-idle/settled-resident.bytes`]: enabled,
    [`${scope}/disabled-final/settled-resident.bytes`]: disabled,
    [`${scope}/enabled-idle/settled-added-resident.bytes`]: enabled - disabled,
  },
});

test('RAM audit pairs by identity, preserves negative estimates and exposes control reversals', () => {
  const report = {
    runs: [
      run(2, 'candidate', 110, 110),
      run(1, 'baseline', 450, 449),
      run(2, 'baseline', 100, 110),
      run(1, 'candidate', 380, 320),
    ],
  };
  const original = structuredClone(report);
  const rows = idleAttribution(report);
  assert.deepEqual(
    rows.map((row) => row.pair),
    [1, 2],
  );
  assert.equal(rows[0].enabledDelta, -70);
  assert.equal(rows[0].controlDelta, -129);
  assert.equal(rows[0].addedDelta, 59);
  assert.match(rows[0].note, /reverses/);
  assert.equal(rows[1].baseline.recordedAdded, -10);
  assert.equal(rows[1].candidate.recordedAdded, 0);
  assert.equal(rows[1].addedDelta, 10);
  assert.deepEqual(report, original);
});

test('control drift is visible even with unchanged enabled RSS, without a performance verdict', () => {
  const [row] = idleAttribution({
    kind: 'optimisation-noise',
    runs: [run(1, 'baseline', 100, 80), run(1, 'candidate', 100, 95)],
  });
  assert.equal(row.addedDelta, -15);
  assert.match(row.note, /control shifts more/);
  assert(!('verdict' in row));
});

test('RAM audit retains missing, failed and duplicate pairs without inventing zero controls', () => {
  for (const mutate of [
    (r) => r.runs.pop(),
    (r) => {
      r.runs[1].status = 'inconclusive';
    },
    (r) => {
      r.runs[1].metrics[`${prefix}/disabled-final/settled-resident.bytes`] = null;
    },
    (r) => {
      delete r.runs[1].metrics[`${prefix}/disabled-final/settled-resident.bytes`];
    },
    (r) => {
      r.runs[1].metrics[`${prefix}/enabled-idle/settled-resident.bytes`] = NaN;
    },
    (r) => r.runs.push(structuredClone(r.runs[1])),
  ]) {
    const report = { runs: [run(1, 'baseline', 100, 80), run(1, 'candidate', 90, 80)] };
    mutate(report);
    const [row] = idleAttribution(report);
    assert.equal(row.baseline.enabled, 100);
    assert.equal(row.addedDelta, null);
    assert.match(row.note, /Incomplete or ambiguous/);
  }
  assert.deepEqual(idleAttribution({}), []);
});

test('RAM audit separates fixture sizes and surfaces inconsistent stored arithmetic', () => {
  const baseline = run(1, 'baseline', 100, 80);
  const candidate = run(1, 'candidate', 90, 80);
  Object.assign(baseline.metrics, run(1, 'baseline', 500, 350, 'Firefox/idle-5000').metrics);
  Object.assign(candidate.metrics, run(1, 'candidate', 450, 340, 'Firefox/idle-5000').metrics);
  candidate.metrics[`${prefix}/enabled-idle/settled-added-resident.bytes`] = 99;
  const rows = idleAttribution({ runs: [baseline, candidate] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].addedDelta, null);
  assert.match(rows[0].note, /differs from its endpoints/);
  assert.equal(rows[1].addedDelta, -40);
  assert.match(rows[1].note, /calibration/);
});

test('HTML and Markdown expose the same raw paired arithmetic, including calibration reports', () => {
  for (const kind of ['optimisation-comparison', 'optimisation-noise']) {
    const report = {
      kind,
      status: 'completed',
      mode: 'calibrate',
      requestedPairs: 1,
      runs: [run(1, 'baseline', 450e6, 449e6), run(1, 'candidate', 380e6, 320e6)],
    };
    for (const rendered of [iterationHtml(report), iterationMarkdown(report)]) {
      assert.match(rendered, /Disabled control reverses the direction/);
      assert.match(rendered, /-129 MB/);
      assert.match(rendered, /59 MB/);
      assert.match(rendered, /purge freed allocator pages/);
      assert.match(rendered, /different reporter histories/);
      assert(!rendered.includes('make this estimate conservative'));
    }
  }
});
