export const audioFixture = Object.freeze({
  version: 1,
  tabs: Object.freeze([100, 1000]),
  windows: 1,
  livePages: 3,
  warmup: 9,
  rounds: 90,
  mechanism:
    'Fixed native mute sequence extension CPU is primary. DOM and next-frame timings are not exact paint. Audible-summary correctness is tested separately; this workload does not measure media decoding. Local live pages must not reload.',
});

export function audioOptions(args) {
  const [mode, output, baseline = 'HEAD', noise] = args;
  if (
    args.length > 4 ||
    !['pilot', 'screen', 'calibrate', 'confirm'].includes(mode) ||
    !output ||
    output.startsWith('--') ||
    (mode === 'confirm' && !noise) ||
    (mode === 'calibrate' && noise)
  )
    throw new Error(
      'Usage: node scripts/benchmarks/audio/audio-runner.mjs pilot|screen|calibrate|confirm OUTPUT [BASELINE=HEAD] [NOISE_REPORT]. Confirmation requires matching five-pair calibration. Workloads and resource limits cannot be increased.',
    );
  return { mode, output, baseline, noise };
}

export function validateAudioNoise(report, context, now = Date.now()) {
  if (
    report?.kind !== 'audio-noise' ||
    report.mode !== 'calibrate' ||
    report.status !== 'completed' ||
    report.context !== context ||
    report.runs?.length !== 20
  )
    return false;
  const age = now - Date.parse(report.finishedAt);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 3600000) return false;
  const hash = report.sources?.baseline?.original?.sha256;
  const firefox = report.environment?.firefox?.match(/Firefox\s+(\S+)/)?.[1];
  if (!hash || !firefox || report.sources?.candidate?.original?.sha256 !== hash) return false;
  for (let pair = 1; pair <= 5; pair++) {
    for (const role of ['baseline', 'candidate']) {
      for (const count of audioFixture.tabs) {
        const matching = report.runs.filter(
          (run) => run.pair === pair && run.role === role && run.count === count,
        );
        if (matching.length !== 1) return false;
        const { guard, result } = matching[0];
        if (
          guard?.status !== 'completed' ||
          result?.status !== 'completed' ||
          result.source?.sha256 !== hash ||
          result.runtime?.firefox !== firefox ||
          result.count !== count ||
          ![result.cpuMs, result.elapsedMs, guard.peakRssBytes].every(
            (value) => Number.isFinite(value) && value >= 0,
          )
        )
          return false;
        for (const [sequence, rounds] of [[result.observation, audioFixture.rounds]]) {
          if (sequence?.rounds !== rounds) return false;
          for (const values of [sequence.dom, sequence.frames])
            if (
              values?.length !== rounds ||
              !values.every((value) => Number.isFinite(value) && value >= 0)
            )
              return false;
        }
      }
    }
  }
  return true;
}
