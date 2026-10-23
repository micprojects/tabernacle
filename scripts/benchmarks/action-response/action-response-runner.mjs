import { actionFixture, actionOptions, validateActionNoise } from './policy.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { freezeSource, iterationHarness, digest } from '../../memory/iteration-source.js';
import { fingerprintSource, machineInfo, exec, percentile } from '../../memory/common.js';
import { runGuarded } from '../../memory/guard.js';
import { iterationLimits, assessMetric } from '../../memory/iteration-policy.js';

const {
  mode,
  output: outputArg,
  baseline: baselineRef,
  noise: noiseArg,
} = actionOptions(process.argv.slice(2));
assert.equal(process.versions.node.split('.')[0], '24');
const output = resolve(outputArg),
  started = Date.now();
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const directory = import.meta.dirname;
const files = [
  'action-response-worker.mjs',
  'action-response-runner.mjs',
  'policy.mjs',
  'action-hook.js',
];
const diagnostics = digest(
  await Promise.all(
    files.map(async (file) => [file, await readFile(resolve(directory, file), 'utf8')]),
  ),
);
const harness = await iterationHarness();
for (const file of files) {
  const target = resolve(output, 'diagnostics', file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(directory, file), target);
}
for (const file of harness.files) {
  const target = resolve(output, 'harness', file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(directory, '../../..', file), target);
}
const environment = {
  ...machineInfo(),
  nodeBinary: process.execPath,
  firefoxBinary: process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox',
  firefox: (
    await exec(process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox', [
      '--version',
    ])
  ).stdout.trim(),
};
const sources = {};
for (const role of ['baseline', 'candidate']) {
  const original = await freezeSource(
    resolve(output, role),
    role === 'baseline' || mode === 'calibrate' ? baselineRef : undefined,
  );
  await appendFile(
    resolve(original.root, 'extension/src/sidebar.js'),
    await readFile(resolve(directory, 'action-hook.js')),
  );
  sources[role] = { original, measured: await fingerprintSource(original.root) };
}
const fixture = actionFixture;
const context = digest({
  baseline: sources.baseline.original.sha256,
  diagnostics,
  harness,
  environment,
  fixture,
});
const noise = noiseArg ? JSON.parse(await readFile(noiseArg, 'utf8')) : null;
if (noise)
  assert(
    validateActionNoise(noise, context),
    'Calibration is incomplete, expired or does not match this source/runtime/harness/fixture.',
  );
const report = {
  kind: mode === 'calibrate' ? 'action-response-noise' : 'action-response-comparison',
  mode,
  context,
  sources,
  diagnostics,
  harness,
  environment,
  fixture,
  startedAt: new Date().toISOString(),
  status: 'running',
  runs: [],
};
const save = () =>
  writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
try {
  outer: for (let pair = 1; pair <= (mode === 'pilot' ? 1 : mode === 'screen' ? 3 : 5); pair++) {
    for (const role of mode === 'pilot'
      ? ['candidate']
      : pair % 2
        ? ['baseline', 'candidate']
        : ['candidate', 'baseline']) {
      for (const count of fixture.tabs) {
        if (Date.now() - started >= 30 * 60000) {
          report.status = 'inconclusive';
          report.error = '30 minute batch limit';
          break outer;
        }
        assert.equal((await iterationHarness()).sha256, harness.sha256);
        assert.equal(
          digest(
            await Promise.all(
              files.map(async (file) => [file, await readFile(resolve(directory, file), 'utf8')]),
            ),
          ),
          diagnostics,
        );
        const source = sources[role].measured;
        assert.equal((await fingerprintSource(source.root)).sha256, source.sha256);
        const run = { pair, role, count };
        report.runs.push(run);
        console.log(`${mode} ${pair} ${role} ${count}`);
        let log = '';
        run.guard = await runGuarded(
          process.execPath,
          [resolve(directory, 'action-response-worker.mjs'), source.root, String(count)],
          {
            cwd: resolve(directory, '../../..'),
            limits: {
              ...iterationLimits,
              maxMs: Math.min(iterationLimits.maxMs, 30 * 60000 - (Date.now() - started)),
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],

            onOutput: (data) => {
              log += data;
            },

            onMessage(message) {
              if (message.type === 'result') run.result = message.result;
              if (message.type === 'stage') console.log('  ' + message.name);
            },
          },
        );
        await writeFile(resolve(output, `${pair}-${role}-${count}.log`), log);
        if (run.guard.status !== 'completed' || run.result?.status !== 'completed') {
          report.status = run.guard.status === 'aborted' ? 'inconclusive' : 'failed';
          report.error = run.guard.reason || run.result?.error || 'Incomplete worker';
          await save();
          break outer;
        }
        assert.equal(run.result.source.sha256, source.sha256);
        assert.equal(run.result.runtime.firefox, environment.firefox.match(/Firefox\s+(\S+)/)[1]);
        await save();
      }
    }
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
}
if (report.status === 'running') report.status = 'completed';
report.finishedAt = new Date().toISOString();
const metrics = {
  responseP95Ms: (r) => percentile(r.result.observation.response, 0.95),
  cpuMs: (r) => r.result.cpuMs,
  domP95Ms: (r) => percentile(r.result.observation.dom, 0.95),
  nextFrameP95Ms: (r) => percentile(r.result.observation.frames, 0.95),
  elapsedMs: (r) => r.result.elapsedMs,
  ownedPeakRssBytes: (r) => r.guard.peakRssBytes,
};
report.comparisons = fixture.tabs.flatMap((count) =>
  Object.entries(metrics).map(([metric, read]) => ({
    count,
    metric,
    ...assessMetric(
      report.runs
        .filter(
          (r) => r.count === count && r.role === 'baseline' && r.result?.status === 'completed',
        )
        .map(read),
      report.runs
        .filter(
          (r) => r.count === count && r.role === 'candidate' && r.result?.status === 'completed',
        )
        .map(read),
      noise?.runs.filter((r) => r.count === count).map(read) || [],
      { confirmed: mode === 'confirm' },
    ),
  })),
);
report.primary = report.comparisons.find(
  (item) => item.count === 1000 && item.metric === 'responseP95Ms',
);
report.regressions = report.comparisons.filter((item) => item.verdict === 'Investigate regression');
report.adverseTrends = report.comparisons.filter((item) => item.repeatable && item.delta > 0);
await save();
console.log(
  JSON.stringify(
    { status: report.status, error: report.error, comparisons: report.comparisons },
    null,
    2,
  ),
);
if (report.status !== 'completed') process.exitCode = report.status === 'inconclusive' ? 2 : 1;
