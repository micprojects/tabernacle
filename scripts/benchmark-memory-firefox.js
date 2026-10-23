import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintSource, machineInfo, parseOptions } from './memory/common.js';
import { runGuarded } from './memory/guard.js';
import { runNative, fingerprintNativeHarness } from './memory/native.js';
import { compareSamples, comparisonPolicy, sampleRange } from './memory/summary.js';
import { waitForPreflight } from './memory/preflight.js';
import {
  validateNativeVariation,
  completeNativePhase,
  sendNativeResult,
} from './memory/native-settlement.js';

const options = parseOptions(['--tabs', '100', '--windows', '2', ...process.argv.slice(2)]);
if (!options.help && !options.stress)
  throw new Error(
    'Use npm run benchmark:optim for routine optimisation. This exceptional harness requires --stress.',
  );
if (options.help) {
  console.log(
    'Usage: node scripts/benchmark-memory-firefox.js --stress [--source-root PATH] [--baseline-root PATH] [--variation-baseline AA_REPORT] [--tabs 100] [--windows 2] [--pairs 5] [--output PATH]',
  );
} else if (process.env.TABERNACLE_NATIVE_MEMORY_WORKER === '1') {
  const result = await runNative(options, process.env.TABERNACLE_NATIVE_MEMORY_LOG);
  await sendNativeResult(result);
  process.exitCode = result.status === 'completed' ? 0 : 1;
  process.disconnect();
} else {
  const output = options.output || resolve('test-results/memory', `native-${Date.now()}.json`);
  await mkdir(dirname(output), { recursive: true });
  const entries = options.baselineRoot
    ? [
        { role: 'baseline', root: options.baselineRoot },
        { role: 'candidate', root: options.sourceRoot },
      ]
    : [{ role: 'candidate', root: options.sourceRoot }];
  const report = {
    version: 1,
    kind: 'native-comparison',
    harness: await fingerprintNativeHarness(),
    status: 'running',
    environment: machineInfo(),
    fixture: { tabs: options.tabs, windows: options.windows, seed: 17 },
    policy: comparisonPolicy,
    runs: [],
  };
  const pairs = options.baselineRoot ? options.pairs : 1;
  report.requestedPairs = pairs;
  try {
    const variation = options.variationBaseline
      ? JSON.parse(await readFile(options.variationBaseline, 'utf8'))
      : null;
    for (const entry of entries) entry.source = await fingerprintSource(entry.root);
    report.sources = entries.map(({ role, source }) => ({ role, ...source }));
    let expectedRuntime = variation
      ? validateNativeVariation(variation, {
          sourceSha256: entries[0].source.sha256,
          harnessSha256: report.harness.sha256,
          fixture: report.fixture,
          environment: report.environment,
        })
      : null;
    if (variation) report.variationBaseline = options.variationBaseline;
    outer: for (let pair = 0; pair < pairs; pair++)
      for (const entry of pair % 2 ? [...entries].reverse() : entries) {
        const partial = {
          pair: pair + 1,
          role: entry.role,
          source: await fingerprintSource(entry.root),
          created: 0,
          phases: [],
        };
        assert.equal(
          partial.source.sha256,
          entry.source.sha256,
          'Source changed between native comparison samples.',
        );
        report.runs.push(partial);
        let lastPressure;
        partial.preflightWait = await waitForPreflight({
          onReading(reading) {
            const pressure = JSON.stringify([reading.percent, reading.level, reading.reason]);
            if (pressure !== lastPressure) {
              lastPressure = pressure;
              console.log(
                JSON.stringify({
                  pair: pair + 1,
                  role: entry.role,
                  type: 'preflight-wait',
                  ...reading,
                }),
              );
            }
          },
        });
        // Keep the guard's own fresh preflight check, including its rejection
        // after this bounded wait, and never retry a run that has launched.
        const guard = await runGuarded(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            '--stress',
            '--source-root',
            entry.root,
            '--tabs',
            String(options.tabs),
            '--windows',
            String(options.windows),
          ],
          {
            cwd: entry.root,
            env: {
              ...process.env,
              TABERNACLE_NATIVE_MEMORY_WORKER: '1',
              TABERNACLE_NATIVE_MEMORY_LOG: `${output}.${pair + 1}-${entry.role}.log`,
            },

            onMessage(message) {
              if (message.type === 'result') partial.result = message.result;
              else if (message.type === 'phase') partial.phases.push(message.phase);
              if (Number.isFinite(message.created)) partial.created = message.created;
              console.log(
                JSON.stringify({
                  pair: pair + 1,
                  role: entry.role,
                  type: message.type,
                  name: message.name || message.phase?.name,
                  created: message.created,
                  saved: message.saved,
                  verified: message.verified,
                }),
              );
            },
          },
        );
        partial.guard = guard;
        if (partial.result?.status === 'completed') {
          assert.equal(
            partial.result.source.sha256,
            entry.source.sha256,
            'Native worker used a different source.',
          );
          assert.equal(
            partial.result.harness.sha256,
            report.harness.sha256,
            'Native worker used a different settlement harness.',
          );
          const runtime = {
            fixtureSha256: partial.result.fixture.sha256,
            firefox: partial.result.environment.firefox,
          };
          if (expectedRuntime)
            assert.deepEqual(
              runtime,
              expectedRuntime,
              'Native fixture or Firefox version changed between samples.',
            );
          else expectedRuntime = runtime;
        }
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
        if (guard.status !== 'completed' || partial.result?.status !== 'completed') {
          report.status = guard.status === 'aborted' ? 'aborted' : 'failed';
          break outer;
        }
      }
    report.harnessAfter = await fingerprintNativeHarness();
    assert.equal(
      report.harnessAfter.sha256,
      report.harness.sha256,
      'Native comparison harness changed between samples.',
    );
    if (report.status === 'running') report.status = 'completed';

    const resident = (phase) => {
      const values = Object.values(phase?.afterCollection?.reports || {})
        .map((process) => process.resident)
        .filter(Number.isFinite);
      return values.length ? values.reduce((sum, bytes) => sum + bytes, 0) : null;
    };

    report.summary = entries.map(({ role, root }) => {
      const runs = report.runs.filter((run) => run.role === role);
      const names = [...new Set(runs.flatMap((run) => run.phases.map((phase) => phase.name)))];
      return {
        role,
        sourceRoot: root,
        completeRuns: runs.filter((run) => run.result?.status === 'completed').length,
        peakOwnedRssBytes: sampleRange(runs.map((run) => run.guard.peakRssBytes)),
        phases: names.map((name) => {
          const phases = runs.map((run) => run.phases.find((phase) => phase.name === name));
          return {
            name,
            supportedRuns: phases.filter((phase) => phase && phase.supported !== false).length,
            unsupportedReasons: phases
              .filter((phase) => phase?.supported === false)
              .map((phase) => phase.reason || 'Requested native phase unsupported'),
            elapsedMs: sampleRange(
              phases.filter((phase) => phase?.supported !== false).map((phase) => phase?.elapsedMs),
            ),
            collectedResidentBytes: sampleRange(phases.map(resident)),
          };
        }),
      };
    });
    if (options.baselineRoot)
      report.comparison = report.summary[0].phases.map(({ name }) => {
        const values = (runs, metric) =>
          runs.map((run) => metric(run.phases.find((phase) => phase.name === name)));

        const compare = (metric) => {
          const baselineRuns = report.runs.filter((run) => run.role === 'baseline');
          const candidateRuns = report.runs.filter((run) => run.role === 'candidate');
          const aaRuns = variation?.runs || [];
          const result = compareSamples(
            values(baselineRuns, metric),
            values(candidateRuns, metric),
            values(aaRuns, metric),
          );
          if (
            !completeNativePhase(baselineRuns, name, pairs, metric) ||
            !completeNativePhase(candidateRuns, name, pairs, metric) ||
            !completeNativePhase(aaRuns, name, aaRuns.length, metric) ||
            aaRuns.length < 10
          )
            result.assessment =
              'Unavailable/inconclusive: complete supported phase samples and five A/A pairs are required; inspect raw samples.';
          return result;
        };

        return {
          name,
          elapsedMs: compare((phase) => phase?.elapsedMs),
          collectedResidentBytes: compare(resident),
        };
      });
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  if (report.status !== 'completed') process.exitCode = 1;
  console.log(`${report.status}: ${output}`);
}
