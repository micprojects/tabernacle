import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintSource, parseOptions, percentile } from './memory/common.js';
import { runSynthetic } from './memory/synthetic.js';
import { compareSamples, comparisonPolicy, sampleRange } from './memory/summary.js';

const options = parseOptions(process.argv.slice(2));
if (!options.help && !options.stress)
  throw new Error(
    'Use npm run benchmark:optim for routine optimisation. This exceptional harness requires --stress.',
  );
if (options.help) {
  console.log(
    'Usage: node --expose-gc scripts/benchmark-memory.js --stress [--source-root PATH] [--baseline-root PATH] [--variation-baseline AA_REPORT] [--tabs 60000] [--windows 28] [--readers 2] [--pairs 5] [--output PATH]',
  );
} else if (process.env.TABERNACLE_MEMORY_WORKER === '1') {
  try {
    process.send({ type: 'result', result: await runSynthetic(options) });
  } catch (error) {
    process.send({ type: 'failure', error: error.stack });
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
} else {
  if (options.native)
    throw new Error('Native diagnostics use scripts/benchmark-memory-firefox.js.');
  const output = options.output || resolve('test-results/memory', `synthetic-${Date.now()}.json`);
  await mkdir(dirname(output), { recursive: true });
  const runs = [];
  const roots = options.baselineRoot
    ? [
        { role: 'baseline', sourceRoot: options.baselineRoot },
        { role: 'candidate', sourceRoot: options.sourceRoot },
      ]
    : [{ role: 'candidate', sourceRoot: options.sourceRoot }];
  const pairs = options.baselineRoot ? options.pairs : 1;
  const report = {
    version: 2,
    kind: 'synthetic-comparison',
    requestedPairs: pairs,
    policy: comparisonPolicy,
    runs,
  };
  try {
    const variation = options.variationBaseline
      ? JSON.parse(await readFile(options.variationBaseline, 'utf8'))
      : null;
    if (variation) {
      const baseline = await fingerprintSource(options.baselineRoot || options.sourceRoot);
      if (
        variation.version !== report.version ||
        variation.status !== 'completed' ||
        variation.kind !== report.kind ||
        !Array.isArray(variation.runs) ||
        variation.runs.length < 2 ||
        variation.runs.some(
          (run) =>
            run.source?.sha256 !== baseline.sha256 ||
            run.fixture?.tabs !== options.tabs ||
            run.fixture?.windows !== options.windows ||
            run.fixture?.readersPerWindow !== options.readers,
        )
      )
        throw new Error(
          'Variation baseline must be a complete A/A report with matching source and topology.',
        );
      report.variationBaseline = options.variationBaseline;
    }
    for (let pair = 0; pair < pairs; pair++) {
      // Alternate order to reduce systematic before/after thermal/order bias.
      for (const { role, sourceRoot } of pair % 2 ? [...roots].reverse() : roots) {
        const result = await new Promise((done, reject) => {
          let result;
          const child = fork(
            fileURLToPath(import.meta.url),
            [
              '--stress',
              '--source-root',
              sourceRoot,
              '--tabs',
              String(options.tabs),
              '--windows',
              String(options.windows),
              '--readers',
              String(options.readers),
            ],
            {
              execArgv: ['--expose-gc'],
              env: { ...process.env, TABERNACLE_MEMORY_WORKER: '1' },
              stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            },
          );
          child.on('message', (message) => {
            if (message.type === 'result') result = message.result;
            if (message.type === 'progress')
              console.log(JSON.stringify({ pair: pair + 1, sourceRoot, ...message }));
            if (message.type === 'failure') reject(new Error(message.error));
          });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 && result
              ? done(result)
              : reject(new Error(`Benchmark worker exited ${code} without a complete result.`)),
          );
        });
        runs.push({
          pair: pair + 1,
          role,
          ...result,
        });
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      }
    }
    report.summary = roots.map(({ role, sourceRoot }) => {
      const samples = runs.filter((run) => run.role === role);
      return {
        sourceRoot,
        role,
        runs: samples.length,
        phases: samples[0].phases.map(({ name }) => {
          const phases = samples.map((run) => run.phases.find((phase) => phase.name === name));
          return {
            name,
            elapsedMs: sampleRange(phases.map((phase) => phase.elapsedMs)),
            heapUsed: sampleRange(phases.map((phase) => phase.memory.heapUsed)),
            medianElapsedMs: percentile(
              phases.map((phase) => phase.elapsedMs),
              0.5,
            ),
            medianHeapUsed: percentile(
              phases.map((phase) => phase.memory.heapUsed),
              0.5,
            ),
            peakReads: Math.max(...phases.map((phase) => phase.api.peakReads)),
            fulls: phases.map((phase) => phase.messages.fulls),
            deltas: phases.map((phase) => phase.messages.deltas),
          };
        }),
      };
    });
    if (options.baselineRoot)
      report.comparison = runs[0].phases.map(({ name }) => {
        const values = (role, metric) =>
          runs
            .filter((run) => run.role === role)
            .map((run) => metric(run.phases.find((phase) => phase.name === name)));
        const variationValues = (metric) =>
          (variation?.runs || []).map((run) =>
            metric(run.phases.find((phase) => phase.name === name)),
          );
        const elapsed = (phase) => phase?.elapsedMs;
        const heap = (phase) => phase?.memory.heapUsed;
        return {
          name,
          elapsedMs: compareSamples(
            values('baseline', elapsed),
            values('candidate', elapsed),
            variationValues(elapsed),
          ),
          heapUsed: compareSamples(
            values('baseline', heap),
            values('candidate', heap),
            variationValues(heap),
          ),
        };
      });
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`${report.status}: ${output}`);
}
