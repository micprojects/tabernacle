import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exec, fingerprintSource, machineInfo, repositoryRoot } from '../../memory/common.js';
import { runGuarded } from '../../memory/guard.js';
import { iterationLimits, validateNoise } from '../../memory/iteration-policy.js';
import { comparisons } from '../../memory/iteration-report.js';
import { digest, freezeSource } from '../../memory/iteration-source.js';
import {
  scrollFixture,
  scrollHarness,
  scrollMarkdown,
  scrollMetrics,
  scrollOptions,
  scrollOptionalMetrics,
} from './scroll-policy.mjs';

const options = scrollOptions(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: node scripts/benchmarks/viewport/scroll-runner.mjs [--baseline REF] [--candidate REF | --working-tree] [--calibrate | --confirm | --pilot] [--noise REPORT_JSON] [--output DIRECTORY]
Supplement to benchmark:optim: fixed 1,000-tab/one-sidebar scrolling and memory-lifetime workload.
Default: three alternating pairs, HEAD versus frozen working tree. --calibrate: five A/A pairs cached for 24 hours. --confirm: five pairs, calibrating first if needed. --pilot: one candidate diagnostic, no comparison.
No profiler, injected instrumentation, larger-workload option or retries. Full row correctness runs after measurement. The standard benchmark and functional suites remain required.`);
} else {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24 from .nvmrc.');
  const started = Date.now();
  const resultsRoot = resolve(repositoryRoot, 'test-results/memory/viewport-scroll');
  await mkdir(resultsRoot, { recursive: true });
  let output;
  if (options.output) {
    output = options.output;
    await mkdir(resolve(output, '..'), { recursive: true });
    await mkdir(output);
  } else output = await mkdtemp(resolve(resultsRoot, 'run-'));
  const environment = {
    ...machineInfo(),
    geckodriver: process.env.GECKODRIVER_BINARY || 'managed 0.37.1',
    firefoxBinary: process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox',
  };
  environment.firefox = (
    await exec(environment.firefoxBinary, ['--version'], { timeout: 15000 })
  ).stdout.trim();
  environment.firefoxVersion = environment.firefox.match(/Firefox\s+(\S+)/)?.[1];
  assert(environment.firefoxVersion, 'Could not identify Firefox runtime.');
  const sources = {
    baseline: await freezeSource(resolve(output, 'baseline'), options.baseline),
    candidate: await freezeSource(resolve(output, 'candidate'), options.candidate),
  };
  const harness = await scrollHarness();
  const contextKey = digest({
    workload: 'viewport-scroll',
    baseline: sources.baseline.sha256,
    harness: harness.sha256,
    environment,
    fixture: scrollFixture,
  });
  const noisePath = options.noise || resolve(resultsRoot, `noise-${contextKey}.json`);
  let noise;
  try {
    const value = JSON.parse(await readFile(noisePath, 'utf8'));
    if (validateNoise(value, contextKey)) noise = value;
    else if (options.noise) throw new Error('Explicit A/A report is incomplete or mismatched.');
  } catch (error) {
    if (error.code !== 'ENOENT' || options.noise) throw error;
  }

  async function runBatch(mode, pairs, calibrating = false) {
    const directory = calibrating ? resolve(output, 'calibration') : output;
    await mkdir(directory, { recursive: true });
    const report = {
      version: 1,
      workload: 'viewport-scroll',
      kind: calibrating ? 'optimisation-noise' : 'optimisation-comparison',
      mode,
      requestedPairs: pairs,
      status: 'running',
      contextKey,
      baselineHash: sources.baseline.sha256,
      sources: calibrating ? { baseline: sources.baseline, candidate: sources.baseline } : sources,
      harness,
      environment,
      fixture: scrollFixture,
      limits: iterationLimits,
      startedAt: new Date().toISOString(),
      runs: [],
    };

    const save = async () => {
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      await writeFile(resolve(directory, 'report.md'), scrollMarkdown(report));
    };

    try {
      outer: for (let pair = 1; pair <= pairs; pair++) {
        const roles =
          mode === 'pilot'
            ? ['candidate']
            : pair % 2
              ? ['baseline', 'candidate']
              : ['candidate', 'baseline'];
        for (const role of roles) {
          const remaining = 30 * 60000 - (Date.now() - started);
          if (remaining <= 0) {
            report.status = 'inconclusive';
            report.error = 'The complete benchmark reached its 30 minute limit.';
            break outer;
          }
          const source = sources[calibrating ? 'baseline' : role];
          assert.equal((await scrollHarness()).sha256, harness.sha256, 'Harness changed.');
          assert.equal((await fingerprintSource(source.root)).sha256, source.sha256);
          const workerOutput = resolve(directory, `${pair}-${role}`);
          await mkdir(workerOutput);
          const run = {
            pair,
            role,
            sourceHash: source.sha256,
            status: 'running',
            metrics: {},
            residentSamples: [],
          };
          report.runs.push(run);
          let extensionPids = [],
            phase = 'startup',
            closing = false,
            log = '';
          console.log(`${mode} ${pair}/${pairs} ${role}`);
          run.guard = await runGuarded(
            process.execPath,
            [resolve(import.meta.dirname, 'scroll-worker.mjs'), source.root, workerOutput],
            {
              cwd: repositoryRoot,
              limits: { ...iterationLimits, maxMs: Math.min(iterationLimits.maxMs, remaining) },
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],

              onOutput(data) {
                log += data;
              },

              onSample(observation, owned) {
                if (closing || !extensionPids.length) return;
                const processes = owned.filter((entry) => extensionPids.includes(entry.pid));
                run.residentSamples.push({
                  elapsedMs: observation.elapsedMs,
                  phase,
                  complete: processes.length === extensionPids.length,
                  rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
                });
              },

              onMessage(message) {
                if (message.type === 'extension-processes') extensionPids = message.pids;
                if (message.type === 'closing') closing = true;
                if (message.type === 'result') run.result = message.result;
                if (message.type === 'stage') {
                  phase = message.name;
                  console.log(`  ${phase}`);
                }
              },
            },
          );
          await writeFile(resolve(workerOutput, 'worker.log'), log);
          if (run.guard.status !== 'completed' || run.result?.status !== 'completed') {
            report.status = run.status = run.guard.status === 'aborted' ? 'inconclusive' : 'failed';
            report.error = run.guard.reason || run.result?.error || 'Incomplete worker result.';
            break outer;
          }
          assert.equal(run.result.source.sha256, source.sha256);
          assert.equal(run.result.harness.sha256, harness.sha256);
          assert.equal(run.result.fixture.sha256, digest(scrollFixture));
          assert.equal(run.result.environment.node, environment.node);
          assert.equal(run.result.environment.firefox, environment.firefoxVersion);
          run.metrics = scrollMetrics(run.result, run.guard, run.residentSamples);
          run.optionalMetrics = scrollOptionalMetrics(run.result);
          run.status = 'completed';
          await save();
        }
      }
      assert.equal((await scrollHarness()).sha256, harness.sha256, 'Harness changed.');
      if (report.status === 'running') report.status = 'completed';
      if (!calibrating && noise) report.noisePath = noisePath;
      report.comparison = comparisons(report, noise);
    } catch (error) {
      report.status = 'failed';
      report.error = error.stack;
    } finally {
      report.finishedAt = new Date().toISOString();
      report.elapsedMs = Date.now() - started;
      await save();
    }
    console.log(`${report.status}: ${resolve(directory, 'report.md')}`);
    return report;
  }

  let report;
  if (options.mode === 'calibrate' || (options.mode === 'confirm' && !noise)) {
    report = await runBatch('calibrate', 5, true);
    if (validateNoise(report, contextKey)) {
      noise = report;
      await writeFile(noisePath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  if (options.mode !== 'calibrate' && (!report || report.status === 'completed'))
    report = await runBatch(options.mode, options.pairs);
  if (report.kind === 'optimisation-noise') {
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'report.md'), scrollMarkdown(report));
  }
  if (report.status !== 'completed') process.exitCode = report.status === 'inconclusive' ? 2 : 1;
}
