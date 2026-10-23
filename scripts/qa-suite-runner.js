import { spawn } from 'node:child_process';
import { firefoxSuites } from './qa-suites.js';
import { runGuarded } from './memory/guard.js';
import { waitForPreflight } from './memory/preflight.js';

const nativeSuites = new Set([...firefoxSuites, 'stress-firefox']);

// A guard stop ends this batch. Keep the inconclusive result visible and never
// turn the remaining suites into automatic retries or an implicit continuation.
export async function* runQaBatch(suites, run) {
  for (const suite of suites) {
    const outcome = await run(suite);
    yield { suite, outcome };
    if (outcome.status === 'inconclusive') return;
  }
}

// The optional guard is macOS-specific. Ordinary QA keeps its existing portable
// subprocess behaviour, and never probes system pressure unless requested.
export async function runQaSuite(
  suite,
  {
    cwd,
    env = process.env,
    onOutput = () => {},
    onMessage = () => {},
    preflight = waitForPreflight,
    guard = runGuarded,
  } = {},
) {
  if (env.TABERNACLE_MEMORY_GUARD !== '1' || !nativeSuites.has(suite.name))
    return new Promise((resolve) => {
      const child = spawn(suite.command, suite.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (data) => onOutput(data, 'stdout'));
      child.stderr.on('data', (data) => onOutput(data, 'stderr'));
      let failure;
      child.once('error', (error) => {
        failure = error.message;
      });
      child.once('close', (code, signal) =>
        resolve({
          status:
            code === 0 && !failure
              ? 'passed'
              : suite.name === 'test-memory-benchmark-firefox' && code === 2
                ? 'inconclusive'
                : 'failed',
          code,
          signal,
          ...(failure ? { error: failure } : {}),
        }),
      );
    });

  let preflightWait;
  try {
    preflightWait = await preflight({
      onReading(reading) {
        onOutput(
          Buffer.from(`[memory preflight] ${reading.elapsedMs}ms: ${reading.reason || 'ready'}\n`),
          'stdout',
        );
      },
    });
    if (preflightWait.status !== 'ready')
      return {
        status: 'inconclusive',
        reason: preflightWait.readings.at(-1)?.reason || 'Native preflight did not become ready.',
        preflightWait,
      };
    // This reads pressure again immediately before spawn; a recovered reading
    // from the bounded wait cannot authorise a later unsafe native launch.
    const watchdog = await guard(suite.command, suite.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      onOutput,
      onMessage,
    });
    return {
      status:
        watchdog.status === 'aborted' ||
        (suite.name === 'test-memory-benchmark-firefox' && watchdog.code === 2)
          ? 'inconclusive'
          : watchdog.status === 'completed'
            ? 'passed'
            : 'failed',
      code: watchdog.code,
      signal: watchdog.signal,
      reason: watchdog.reason,
      preflightWait,
      watchdog,
    };
  } catch (error) {
    return { status: 'inconclusive', reason: error.message, preflightWait };
  }
}
