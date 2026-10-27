// Reporting only: decompose each paired idle RSS estimate without changing the
// samples, calibration, thresholds or performance verdicts.
export const attributionNote =
  'Added RSS = enabled RSS − disabled RSS. Each delta below is new − old, so Δ added = Δ enabled − Δ control. A changing disabled control can amplify, hide or reverse the enabled-process difference. These diagnostics do not establish a cause, exclude samples or replace matched A/A calibration.';

export const reporterNote =
  '“Unforced” means no explicit GC/CC request, not an observation without side effects. On macOS, Firefox’s resident memory reporter can purge freed allocator pages even with minimisation disabled. A short stable RSS window also does not prove completed reclamation. Do not mix OS RSS, reporter RSS, physical footprint and collected heap.';

export function idleReporterNote(report) {
  return `${reporterNote} ${
    report.fixture?.idle?.reporterTiming === 'after-both-endpoints'
      ? 'This idle protocol finishes both enabled and disabled OS RSS endpoints before requesting any memory reporters. The final disabled report is diagnostic; enabled reporter categories are unavailable in this worker.'
      : 'This report does not record deferred idle reporters. Older idle workers requested a memory report between enabled and disabled OS samples, giving those endpoints different reporter histories. Inspect the recorded harness before treating either endpoint as unperturbed.'
  }`;
}

export function idleAttribution(report) {
  const runs = report.runs || [];
  const prefixes = new Set();
  for (const run of runs) {
    for (const name of Object.keys(run.metrics || {})) {
      const match =
        /^(Firefox\/idle-\d+)\/(?:enabled-idle\/settled-(?:added-)?resident|disabled-final\/settled-resident)\.bytes$/.exec(
          name,
        );
      if (match) prefixes.add(match[1]);
    }
  }
  const pairs = [...new Set(runs.map((run) => run.pair))]
    .filter((pair) => Number.isInteger(pair) && pair > 0)
    .sort((a, b) => a - b);

  const endpoint = (pair, role, prefix) => {
    const matches = runs.filter((run) => run.pair === pair && run.role === role);
    if (matches.length !== 1) return { enabled: null, disabled: null, complete: false };
    const run = matches[0];

    const read = (suffix) => {
      const value = run.metrics?.[`${prefix}/${suffix}.bytes`];
      return Number.isFinite(value) ? value : null;
    };

    return {
      enabled: read('enabled-idle/settled-resident'),
      disabled: read('disabled-final/settled-resident'),
      recordedAdded: read('enabled-idle/settled-added-resident'),
      complete: run.status === 'completed',
    };
  };

  return [...prefixes].sort().flatMap((prefix) =>
    pairs.map((pair) => {
      const baseline = endpoint(pair, 'baseline', prefix);
      const candidate = endpoint(pair, 'candidate', prefix);
      const row = {
        prefix,
        pair,
        baseline,
        candidate,
        enabledDelta: null,
        controlDelta: null,
        addedDelta: null,
        note: 'Incomplete or ambiguous pair; no paired arithmetic.',
      };
      const sides = [baseline, candidate];
      if (!sides.every((side) => side.complete && side.enabled !== null && side.disabled !== null))
        return row;
      if (
        sides.some(
          (side) =>
            side.recordedAdded !== null && side.recordedAdded !== side.enabled - side.disabled,
        )
      ) {
        row.note = 'Stored added RSS differs from its endpoints; inspect raw evidence.';
        return row;
      }
      row.enabledDelta = candidate.enabled - baseline.enabled;
      row.controlDelta = candidate.disabled - baseline.disabled;
      row.addedDelta = row.enabledDelta - row.controlDelta;
      row.note =
        row.enabledDelta * row.addedDelta < 0
          ? 'Disabled control reverses the direction.'
          : Math.abs(row.controlDelta) > Math.abs(row.enabledDelta)
            ? 'Disabled control shifts more than enabled RSS.'
            : 'Read with matched A/A calibration.';
      return row;
    }),
  );
}
