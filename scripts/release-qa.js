import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { uiSuites, firefoxSuites, suiteFile } from './qa-suites.js';
import { fingerprintSource } from './memory/common.js';
import { runQaSuite, runQaBatch } from './qa-suite-runner.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--stress'))
  throw new Error('Usage: npm run qa:release -- [--stress]');
const startedAt = new Date().toISOString();
const directory = resolve('test-results', 'release-qa', startedAt.replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (version !== manifest.version) throw new Error('Package and manifest versions must match.');
const report = {
  version,
  startedAt,
  node: process.version,
  stress: args.includes('--stress'),
  memoryGuard: process.env.TABERNACLE_MEMORY_GUARD === '1',
  source: await fingerprintSource(process.cwd()),
  suites: [],
};
const reportPath = join(directory, 'results.json');
const suites = [
  { name: 'check', command: 'npm', args: ['run', 'check'] },
  ...[...uiSuites, ...firefoxSuites, ...(report.stress ? ['stress-firefox'] : [])].map((name) => ({
    name,
    command: process.execPath,
    args: [suiteFile(name)],
  })),
  { name: 'build', command: 'npm', args: ['run', 'build'] },
];
console.log(`Release QA for ${version}. Logs: ${directory}`);
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

async function checkSuite(suite) {
  const logPath = join(directory, `${suite.name}.log`);
  const start = performance.now();
  report.currentSuite = suite.name;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nRunning ${suite.name}…`);
  process.send?.({ type: 'stage', name: suite.name });
  const log = createWriteStream(logPath);
  const outcome = await runQaSuite(suite, {
    onOutput(data, stream) {
      log.write(data);
      process[stream].write(data);
    },

    onMessage(message) {
      if (message?.type === 'stage')
        process.send?.({ type: 'stage', name: `${suite.name}/${message.name || 'stage'}` });
    },
  });
  if (outcome.reason) log.write(`[${outcome.status}] ${outcome.reason}\n`);
  await new Promise((resolve) => log.end(resolve));
  if (outcome.preflightWait || outcome.watchdog) {
    const guardPath = join(directory, `${suite.name}.guard.json`);
    await writeFile(guardPath, JSON.stringify(outcome, null, 2) + '\n');
    outcome.guard = guardPath;
    delete outcome.preflightWait;
    delete outcome.watchdog;
  }
  report.suites.push({
    name: suite.name,
    ...outcome,
    durationMs: Math.round(performance.now() - start),
    log: logPath,
  });
  delete report.currentSuite;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return outcome;
}

for await (const { suite, outcome } of runQaBatch(suites, checkSuite)) {
  if (outcome.status === 'inconclusive') {
    report.stoppedAfter = suite.name;
    report.notRun = suites.slice(report.suites.length).map((item) => item.name);
    console.log(`\nStopped after ${suite.name}: ${outcome.reason || 'inconclusive result'}.`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}
report.finishedAt = new Date().toISOString();
report.passed =
  report.suites.length === suites.length &&
  report.suites.every((suite) => suite.status === 'passed');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(
  `\n${report.passed ? 'Passed' : 'Failed'}: ${report.suites.filter((suite) => suite.status === 'passed').length}/${report.suites.length} checks. Report: ${reportPath}`,
);
process.exitCode = report.passed ? 0 : 1;
