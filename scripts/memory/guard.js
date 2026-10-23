import { spawn } from 'node:child_process';
import { exec, memoryGuard, ownedProcesses, readPressure, lowerGuardLimits } from './common.js';

// Spawn, observe and (if necessary) stop only this child and its descendants.
// Never discover or terminate an unrelated Firefox process by its executable name.
export async function runGuarded(
  command,
  args,
  {
    cwd,
    env = process.env,
    onMessage = () => {},
    onOutput = () => {},
    onSample = () => {},
    stdio = 'inherit',
    sampleMs = 1000,
    pressure = readPressure,
    limits = {},
  } = {},
) {
  limits = lowerGuardLimits(limits);
  const preflight = await pressure();
  const reason = memoryGuard(
    {
      pressurePercent: preflight.percent,
      pressureLevel: preflight.level,
      rssBytes: 0,
      elapsedMs: 0,
    },
    { start: true, ...limits },
  );
  const report = {
    status: reason ? 'aborted' : 'running',
    reason,
    preflight,
    guards: {
      startFreePercent: 30,
      stopFreePercent: 20,
      maxRssBytes: limits.maxRssBytes,
      lowPressureSamples: 3,
      maxMs: limits.maxMs,
      maxStageMs: 10 * 60 * 1000,
      noProgressMs: 60000,
    },
    peakRssBytes: 0,
    minimumFreePercent: preflight.percent,
    samples: [],
  };
  if (reason) return report;
  const started = Date.now();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: stdio === 'inherit' ? ['inherit', 'pipe', 'pipe', 'ipc'] : stdio,
  });
  let stageStarted = started;
  let progressed = started;
  let lowPressureSamples = 0;
  child.on('message', (message) => {
    progressed = Date.now();
    if (message?.type === 'stage') stageStarted = progressed;
    onMessage(message);
  });
  for (const [stream, destination, name] of [
    [child.stdout, process.stdout, 'stdout'],
    [child.stderr, process.stderr, 'stderr'],
  ])
    stream?.on('data', (data) => {
      progressed = Date.now();
      onOutput(data, name);
      if (stdio === 'inherit') destination.write(data);
    });
  let aborted = false;
  let finished = false;
  let sampling = false;
  let escalation;
  let drainTimeout;

  const stop = (why) => {
    if (aborted || finished) return;
    aborted = true;
    report.status = 'aborted';
    report.reason = why;
    // Cooperative handlers may close their profile first. A stuck browser must
    // not defeat the watchdog: the owned process group is killed after 3 seconds.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    escalation = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 3000);
    escalation.unref();
  };

  const sample = async () => {
    if (sampling || aborted || finished) return;
    sampling = true;
    try {
      const [{ stdout }, reading] = await Promise.all([
        exec('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pgid='], { timeout: 5000 }),
        pressure(),
      ]);
      if (finished) return;
      const owned = ownedProcesses(
        stdout,
        child.pid,
        process.platform === 'win32' ? undefined : child.pid,
      );
      const rssBytes = owned.reduce((sum, entry) => sum + entry.rssBytes, 0);
      lowPressureSamples = reading.percent < 20 ? lowPressureSamples + 1 : 0;
      const observation = {
        elapsedMs: Date.now() - started,
        rssBytes,
        pressurePercent: reading.percent,
        pressureLevel: reading.level,
        lowPressureSamples,
        stageMs: Date.now() - stageStarted,
        idleMs: Date.now() - progressed,
        processes: owned.length,
      };
      onSample(observation, owned);
      report.samples.push(observation);
      report.peakRssBytes = Math.max(report.peakRssBytes, rssBytes);
      if (Number.isFinite(reading.percent))
        report.minimumFreePercent = Math.min(report.minimumFreePercent, reading.percent);
      const why = memoryGuard(observation, limits);
      if (why) stop(why);
    } catch (error) {
      stop(`Watchdog could not sample its owned process tree: ${error.message}`);
    } finally {
      sampling = false;
    }
  };

  const timer = setInterval(sample, sampleMs);
  const interrupted = () => stop('Interrupted by the operator.');
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error: error.message }));
      child.once('exit', (code, signal) => {
        report.exit = { code, signal, elapsedMs: Date.now() - started };
        // An inherited pipe can outlive an exited worker. Still drain its final
        // output, but report a cleanup failure promptly instead of a misleading
        // workload stall. Never accept a result message as proof of shutdown.
        drainTimeout = setTimeout(
          () => stop('Worker exited but its output pipes did not close within 3 seconds.'),
          3000,
        );
      });
      // Drain both output streams before the caller closes its per-suite log.
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    Object.assign(report, outcome, { elapsedMs: Date.now() - started });
    if (!aborted) report.status = outcome.code === 0 ? 'completed' : 'failed';
    if (outcome.error) report.reason = outcome.error;
    if (aborted) {
      // Clean surviving members of the same owned group even if Node exited
      // before geckodriver/Firefox. ESRCH simply means it already disappeared.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    return report;
  } finally {
    finished = true;
    clearInterval(timer);
    clearTimeout(escalation);
    clearTimeout(drainTimeout);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}
