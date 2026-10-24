import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exec, fingerprintSource, machineInfo, repositoryRoot } from './memory/common.js';
import { runGuarded } from './memory/guard.js';
import {
  iterationWorkload,
  iterationLimits,
  iterationOptions,
  validateNoise,
} from './memory/iteration-policy.js';
import { digest, freezeSource, iterationHarness } from './memory/iteration-source.js';
import { iterationMarkdown } from './memory/iteration-markdown.js';
import {
  comparisons,
  iterationHtml,
  nativeMetrics,
  syntheticMetrics,
} from './memory/iteration-report.js';

const options = iterationOptions(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: npm run benchmark:optim -- [--baseline REF] [--candidate REF | --working-tree] [--calibrate | --confirm | --pilot] [--synthetic-only] [--noise REPORT_JSON] [--output DIRECTORY]
Default: three alternating pairs, HEAD versus a frozen working tree, 1,000 native tabs / two real sidebars plus 100/1,000/10,000 synthetic tabs.
Posting reports: npm run benchmark:report -- [options] (equivalent to --report).
--report: latest local stable release tag versus committed HEAD; five pairs with matching A/A calibration.
--baseline REF: old version; latest-release selects the highest local vMAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH tag (no prereleases; no implicit fetch).
--candidate REF: new committed version; --working-tree explicitly includes uncommitted source.
Every run writes report.md alongside report.json and report.html.
--calibrate: five fresh baseline/baseline pairs; cache the matched A/A noise for 24 hours.
--confirm: five comparison pairs, first calibrating if no matching cache exists.
--pilot: one candidate sample; diagnostics only.
--synthetic-only: no Firefox evidence. Useful for fast controller experiments; uses a separate calibration.
Idle headline: a separate 1,000-tab / 100-folder, three-level fixture in two sidebars, with natural memory settlement before enabled/disabled samples.
--idle-scaling: dedicated 5,000-tab / 500-folder idle stress comparison, with the same resource ceilings. Omits the active and synthetic workloads; compare this with the ordinary 1,000-tab headline to track scaling.
Other exceptional high-capacity tests use benchmark:memory:stress or benchmark:memory:firefox:stress.`);
} else {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24 from .nvmrc.');
  const fixture = iterationWorkload(options);
  const started = Date.now();
  const resultsRoot = resolve(repositoryRoot, 'test-results/memory/iteration');
  await mkdir(resultsRoot, { recursive: true });
  const output = options.output || (await mkdtemp(resolve(resultsRoot, 'run-')));
  if (options.output) {
    // Explicit evidence directories must be new, even if they lack reserved.json.
    await mkdir(resolve(output, '..'), { recursive: true });
    await mkdir(output);
  }
  // Do not overwrite existing evidence or frozen exports, even with --output.
  await writeFile(
    resolve(output, 'reserved.json'),
    JSON.stringify({ startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );
  const environment = {
    ...machineInfo(),
    geckodriver: process.env.GECKODRIVER_BINARY || 'managed 0.37.1',
  };
  if (!options.syntheticOnly) {
    environment.firefoxBinary =
      process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox';
    const version = (await exec(environment.firefoxBinary, ['--version'], { timeout: 15000 }))
      .stdout;
    environment.firefox = version.trim();
    environment.firefoxVersion = version.match(/Firefox\s+(\S+)/)?.[1];
    assert(environment.firefoxVersion, 'Could not identify Firefox runtime.');
  }
  const sources = {
    baseline: await freezeSource(resolve(output, 'baseline'), options.baseline),
    candidate: await freezeSource(resolve(output, 'candidate'), options.candidate),
  };
  const harness = await iterationHarness();
  const contextKey = digest({
    baseline: sources.baseline.sha256,
    harness: harness.sha256,
    environment,
    fixture,
    syntheticOnly: options.syntheticOnly,
  });
  const noisePath = options.noise || resolve(resultsRoot, `noise-${contextKey}.json`);
  let noise;
  const workerContexts = new Map();
  try {
    const value = JSON.parse(await readFile(noisePath, 'utf8'));
    if (validateNoise(value, contextKey)) noise = value;
    else if (options.noise)
      throw new Error(
        'Explicit A/A report is incomplete, expired or from different source/runtime/harness/fixture.',
      );
  } catch (error) {
    if (error.code !== 'ENOENT' || options.noise) throw error;
  }

  async function runBatch(mode, pairs, calibrating = false) {
    const batchDirectory = calibrating ? resolve(output, 'calibration') : output;
    await mkdir(batchDirectory, { recursive: true });
    const report = {
      version: 1,
      kind: calibrating ? 'optimisation-noise' : 'optimisation-comparison',
      mode,
      requestedPairs: pairs,
      status: 'running',
      contextKey,
      baselineHash: sources.baseline.sha256,
      sources,
      harness,
      environment,
      fixture,
      syntheticOnly: options.syntheticOnly,
      idleOnly: Boolean(options.idleScaling),
      limits: iterationLimits,
      startedAt: new Date().toISOString(),
      runs: [],
    };

    const save = async () => {
      await writeFile(
        resolve(batchDirectory, 'report.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
      await writeFile(resolve(batchDirectory, 'report.html'), iterationHtml(report));
      await writeFile(resolve(batchDirectory, 'report.md'), iterationMarkdown(report));
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
          const source = sources[calibrating ? 'baseline' : role];
          assert.equal(
            (await iterationHarness()).sha256,
            harness.sha256,
            'Harness changed during measurement.',
          );
          assert.equal((await fingerprintSource(source.root)).sha256, source.sha256);
          const run = {
            pair,
            role,
            sourceHash: source.sha256,
            status: 'running',
            metrics: {},
            workers: [],
          };
          report.runs.push(run);
          const jobs = [
            ...(!options.syntheticOnly && fixture.native
              ? [
                  {
                    kind: 'native',
                    script: 'iteration-native.js',
                    args: [source.root, '1000', '2'],
                  },
                ]
              : []),
            ...(!options.syntheticOnly
              ? fixture.idle.sizes.map(({ tabs, folders }) => ({
                  kind: 'idle-native',
                  script: 'iteration-native.js',
                  args: [source.root, String(tabs), String(fixture.idle.windows), String(folders)],
                }))
              : []),
            ...fixture.synthetic.map(({ tabs, windows }) => ({
              kind: 'synthetic',
              script: 'iteration-synthetic.js',
              args: [source.root, String(tabs), String(windows)],
            })),
          ];
          for (const job of jobs) {
            const remaining = 30 * 60000 - (Date.now() - started);
            if (remaining <= 0) {
              report.status = run.status = 'inconclusive';
              report.error = 'The complete benchmark reached its 30 minute limit.';
              break outer;
            }
            const worker = { kind: job.kind, tabs: Number(job.args[1]), phases: [] };
            run.workers.push(worker);
            console.log(`${mode} ${pair}/${pairs} ${role}: ${job.kind} ${worker.tabs}`);
            let log = '';
            let extensionPids = [],
              currentPhase = 'startup',
              closing = false;
            worker.residentSamples = [];
            worker.guard = await runGuarded(
              process.execPath,
              ['--expose-gc', resolve(repositoryRoot, 'scripts/memory', job.script), ...job.args],
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
                  worker.residentSamples.push({
                    elapsedMs: observation.elapsedMs,
                    phase: currentPhase,
                    complete: processes.length === extensionPids.length,
                    rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
                  });
                },

                onMessage(message) {
                  if (message.type === 'extension-processes') extensionPids = message.pids;
                  if (message.type === 'closing') closing = true;
                  if (message.type === 'stage') currentPhase = message.name;
                  if (message.type === 'result') worker.result = message.result;
                  if (message.type === 'phase') worker.phases.push(message.phase);
                  if (message.type === 'failure') worker.error = message.error;
                  if (message.type === 'stage') console.log(`  ${message.name}`);
                },
              },
            );
            await writeFile(
              resolve(batchDirectory, `${pair}-${role}-${job.kind}-${worker.tabs}.log`),
              log,
            );
            if (worker.guard.status !== 'completed' || worker.result?.status !== 'completed') {
              report.status = run.status =
                worker.guard.status === 'aborted' || worker.result?.status === 'inconclusive'
                  ? 'inconclusive'
                  : 'failed';
              report.error =
                worker.guard.reason ||
                worker.result?.error ||
                worker.error ||
                'Incomplete worker result';
              break outer;
            }
            assert.equal(worker.result.source.sha256, source.sha256, 'Worker source differs.');
            const workerKey = `${job.kind}/${worker.tabs}`;
            const context = {
              fixture: worker.result.fixture.sha256,
              node: worker.result.environment.node,
            };
            assert(context.fixture, 'Worker omitted fixture fingerprint.');
            if (workerContexts.has(workerKey))
              assert.deepEqual(
                context,
                workerContexts.get(workerKey),
                'Worker fixture or Node runtime changed.',
              );
            else workerContexts.set(workerKey, context);
            if (job.kind === 'native' || job.kind === 'idle-native') {
              assert(
                worker.residentSamples.length &&
                  worker.residentSamples.every((sample) => sample.complete),
                'Incomplete extension-process RSS accounting; native comparison is invalid.',
              );
              assert.equal(
                worker.result.environment.firefox,
                environment.firefoxVersion,
                'Firefox runtime changed.',
              );
              Object.assign(
                run.metrics,
                Object.fromEntries(
                  Object.entries(
                    nativeMetrics(worker.result, worker.guard, worker.residentSamples),
                  ).map(([name, value]) => [
                    job.kind === 'idle-native'
                      ? name.replace('Firefox/', `Firefox/idle-${worker.tabs}/`)
                      : name,
                    value,
                  ]),
                ),
              );
            } else Object.assign(run.metrics, syntheticMetrics(worker.result));
            assert(
              Object.values(run.metrics).every(Number.isFinite),
              'A metric is missing or non-finite.',
            );
            await save();
          }
          run.status = 'completed';
          await save();
        }
      }
      assert.equal(
        (await iterationHarness()).sha256,
        harness.sha256,
        'Harness changed during measurement.',
      );
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
    console.log(`${report.status}: ${resolve(batchDirectory, 'report.md')}`);
    return report;
  }

  let report;
  if (options.mode === 'calibrate' || (options.mode === 'confirm' && !noise)) {
    report = await runBatch('calibrate', 5, true);
    if (validateNoise(report, contextKey)) {
      noise = report;
      await writeFile(noisePath, JSON.stringify(report, null, 2) + '\n');
      console.log(`A/A calibration cached: ${noisePath}`);
    }
  }
  if (options.mode !== 'calibrate' && (!report || report.status === 'completed'))
    report = await runBatch(options.mode, options.pairs);
  // A stopped calibration must still leave a discoverable report at the run root.
  if (report.kind === 'optimisation-noise') {
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'report.html'), iterationHtml(report));
    await writeFile(resolve(output, 'report.md'), iterationMarkdown(report));
  }
  if (report.status !== 'completed') process.exitCode = report.status === 'inconclusive' ? 2 : 1;
  else if (!noise && options.mode !== 'pilot')
    console.log(
      'No calibrated timing/memory verdict. Run --calibrate once, or --confirm for calibration plus five comparison pairs.',
    );
}
