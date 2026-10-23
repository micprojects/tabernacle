import test from 'node:test';
import assert from 'node:assert/strict';
import { runQaSuite, runQaBatch } from '../scripts/qa-suite-runner.js';
import { runGuarded } from '../scripts/memory/guard.js';
import { firefoxSuites } from '../scripts/qa-suites.js';

const command = (name, source) => ({ name, command: process.execPath, args: ['-e', source] });
const safe = async () => ({ percent: 50, level: 1 });
const ready = async () => ({ status: 'ready', elapsedMs: 0, readings: [] });

test('ordinary native QA remains portable and drains final stdout and stderr without pressure probes', async () => {
  const chunks = { stdout: [], stderr: [] };
  const outcome = await runQaSuite(
    command(firefoxSuites[0], "process.stdout.write('last out');process.stderr.write('last err')"),
    {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '0' },
      onOutput: (data, stream) => chunks[stream].push(data),

      preflight() {
        assert.fail('Default QA must not read platform-specific memory pressure');
      },
    },
  );
  assert.equal(outcome.status, 'passed');
  assert.equal(Buffer.concat(chunks.stdout).toString(), 'last out');
  assert.equal(Buffer.concat(chunks.stderr).toString(), 'last err');
});

test('enabling native guards leaves UI and check suites on the ordinary failure path', async () => {
  for (const name of ['check', 'test-ui', 'build']) {
    const outcome = await runQaSuite(command(name, 'process.exitCode = 7'), {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },

      preflight() {
        assert.fail('A nonnative suite must not be blocked by the native preflight');
      },
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.code, 7);
  }
});

test('every registered native and stress suite gets a fresh bounded preflight', async () => {
  let calls = 0;
  const logs = [];
  for (const name of [...firefoxSuites, 'stress-firefox']) {
    const outcome = await runQaSuite(command(name, 'process.exitCode = 99'), {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },
      onOutput: (data) => logs.push(data.toString()),

      async preflight({ onReading }) {
        calls++;
        const reading = { elapsedMs: 120000, percent: 40, level: 2, reason: 'Not normal' };
        onReading(reading);
        return { status: 'timed-out', elapsedMs: 120000, readings: [reading] };
      },

      guard() {
        assert.fail('A timed-out preflight must never launch its native suite');
      },
    });
    assert.equal(outcome.status, 'inconclusive');
    assert.equal(outcome.reason, 'Not normal');
    assert.equal(outcome.preflightWait.elapsedMs, 120000);
  }
  assert.equal(calls, firefoxSuites.length + 1);
  assert.equal(logs.length, calls);
  assert(logs.every((line) => line.includes('120000ms: Not normal')));
});

test('the immediate guard can refuse a native launch even after its bounded wait passed', async () => {
  const outcome = await runQaSuite(
    { name: firefoxSuites[0], command: '/must/not/launch', args: [] },
    {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },
      preflight: ready,
      guard: (command, args, options) =>
        runGuarded(command, args, {
          ...options,
          pressure: async () => ({ percent: 40, level: 2 }),
        }),
    },
  );
  assert.equal(outcome.status, 'inconclusive');
  assert.equal(outcome.watchdog.status, 'aborted');
  assert.equal(outcome.watchdog.samples.length, 0);
  assert.match(outcome.reason, /not normal/);
});

test('guarded suites tee complete output and stage messages before returning the outcome', async () => {
  const output = { stdout: [], stderr: [] };
  const stages = [];
  const outcome = await runQaSuite(
    command(
      'stress-firefox',
      "process.send({type:'stage',name:'fixture'});process.stdout.write('a'.repeat(200000));process.stderr.write('end')",
    ),
    {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },
      preflight: ready,
      guard: (command, args, options) => runGuarded(command, args, { ...options, pressure: safe }),
      onOutput: (data, stream) => output[stream].push(data),
      onMessage: (message) => stages.push(message),
    },
  );
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.watchdog.status, 'completed');
  assert.equal(Buffer.concat(output.stdout).length, 200000);
  assert.equal(Buffer.concat(output.stderr).toString(), 'end');
  assert.deepEqual(stages, [{ type: 'stage', name: 'fixture' }]);
});

test('watchdog aborts remain inconclusive and native test failures remain failures', async () => {
  for (const [status, expected] of [
    ['aborted', 'inconclusive'],
    ['failed', 'failed'],
  ]) {
    const outcome = await runQaSuite(command(firefoxSuites[0], ''), {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },
      preflight: ready,
      guard: async () => ({
        status,
        reason: 'Fixture reason',
        code: status === 'failed' ? 1 : null,
      }),
    });
    assert.equal(outcome.status, expected);
    assert.equal(outcome.reason, 'Fixture reason');
  }
});

test('the iteration benchmark retains its inner resource-stop status in ordinary and guarded QA', async () => {
  for (const guarded of [false, true]) {
    const result = await runQaSuite(
      command('test-memory-benchmark-firefox', 'process.exitCode = 2'),
      {
        env: { ...process.env, TABERNACLE_MEMORY_GUARD: guarded ? '1' : '0' },
        preflight: ready,
        guard: async () => ({ status: 'failed', code: 2, reason: 'Inner 3 GiB iteration guard' }),
      },
    );
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.code, 2);
  }
});

test('an inconclusive guard ends the QA batch without launching or retrying remaining suites', async () => {
  const suites = ['check', firefoxSuites[0], firefoxSuites[1], 'stress-firefox', 'build'].map(
    (name) => command(name, ''),
  );
  const launched = [],
    results = [];
  for await (const { suite, outcome } of runQaBatch(suites, async (suite) => {
    launched.push(suite.name);
    if (suite.name === 'check') return { status: 'passed' };
    return runQaSuite(suite, {
      env: { ...process.env, TABERNACLE_MEMORY_GUARD: '1' },
      preflight: ready,
      guard: async () => ({ status: 'aborted', reason: 'No reported progress for 60 seconds.' }),
    });
  }))
    results.push({ name: suite.name, status: outcome.status });
  assert.deepEqual(launched, ['check', firefoxSuites[0]]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['passed', 'inconclusive'],
  );
  assert.deepEqual(
    suites.slice(results.length).map((suite) => suite.name),
    [firefoxSuites[1], 'stress-firefox', 'build'],
  );
});

test('ordinary functional failures remain reported while independent QA suites continue', async () => {
  const results = [];
  for await (const result of runQaBatch(['check', 'ui', 'native'], async (suite) => ({
    status: suite === 'ui' ? 'failed' : 'passed',
  })))
    results.push(result);
  assert.deepEqual(
    results.map(({ suite, outcome }) => [suite, outcome.status]),
    [
      ['check', 'passed'],
      ['ui', 'failed'],
      ['native', 'passed'],
    ],
  );
});
