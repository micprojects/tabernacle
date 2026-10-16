import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { uiSuites, firefoxSuites } from './qa-suites.js';

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
  suites: [],
};
const reportPath = join(directory, 'results.json');
const suites = [
  { name: 'check', command: 'npm', args: ['run', 'check'] },
  ...[...uiSuites, ...firefoxSuites, ...(report.stress ? ['stress-firefox'] : [])].map((name) => ({
    name,
    command: process.execPath,
    args: [`scripts/${name}.js`],
  })),
  { name: 'build', command: 'npm', args: ['run', 'build'] },
];
console.log(`Release QA for ${version}. Logs: ${directory}`);
for (const suite of suites) {
  const logPath = join(directory, `${suite.name}.log`);
  const start = performance.now();
  console.log(`\nRunning ${suite.name}…`);
  const log = createWriteStream(logPath);
  const outcome = await new Promise((resolve) => {
    const child = spawn(suite.command, suite.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => {
      log.write(data);
      process.stdout.write(data);
    });
    child.stderr.on('data', (data) => {
      log.write(data);
      process.stderr.write(data);
    });
    child.once('error', (error) => resolve({ status: 'failed', error: error.message }));
    child.once('close', (code, signal) =>
      resolve({ status: code === 0 ? 'passed' : 'failed', code, signal }),
    );
  });
  await new Promise((resolve) => log.end(resolve));
  report.suites.push({
    name: suite.name,
    ...outcome,
    durationMs: Math.round(performance.now() - start),
    log: logPath,
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
report.finishedAt = new Date().toISOString();
report.passed = report.suites.every((suite) => suite.status === 'passed');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(
  `\n${report.passed ? 'Passed' : 'Failed'}: ${report.suites.filter((suite) => suite.status === 'passed').length}/${report.suites.length} checks. Report: ${reportPath}`,
);
process.exitCode = report.passed ? 0 : 1;
