import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, freezeSource, iterationHarness } from '../../memory/iteration-source.js';
import { runGuarded } from '../../memory/guard.js';
import { iterationLimits } from '../../memory/iteration-policy.js';
import { fingerprintSource } from '../../memory/common.js';
import { withWrapperPool } from './variants.mjs';

const [outputArg, ref, variant] = process.argv.slice(2);
assert(
  outputArg,
  'Usage: node scripts/benchmarks/viewport/profile-runner.mjs OUTPUT [REF|-] [--visible-rows|--wrapper-pool]',
);
assert(
  !variant || ['--visible-rows', '--wrapper-pool'].includes(variant),
  'Unknown diagnostic variant',
);
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
const source = await freezeSource(resolve(output, 'source'), ref === '-' ? undefined : ref);
const file = resolve(source.root, 'extension/src/sidebar.js');
let code = await readFile(file, 'utf8');
if (variant === '--wrapper-pool') code = withWrapperPool(code);
for (const text of [
  'function createTabRow(tab, expanded, stats) {',
  "const node = el('div', `${kind}-node`);",
])
  assert(code.includes(text), `Missing instrumentation point: ${text}`);
code =
  'globalThis.__viewportWork = { tabBuilds: 0, wrapperBuilds: 0 };\n' +
  code
    .replace(
      'function createTabRow(tab, expanded, stats) {',
      'function createTabRow(tab, expanded, stats) { globalThis.__viewportWork.tabBuilds++;',
    )
    .replace(
      "const node = el('div', `${kind}-node`);",
      "globalThis.__viewportWork.wrapperBuilds++; const node = el('div', `${kind}-node`);",
    );
await writeFile(file, code);
if (variant === '--visible-rows') {
  const css = resolve(source.root, 'extension/tree.css');
  await writeFile(
    css,
    (await readFile(css, 'utf8')) + '\n.viewport-tree .tab-row { content-visibility: visible; }\n',
  );
}
const report = {
  kind: 'viewport-allocation-diagnostic',
  note: 'Instrumentation/profiling overhead: counts and sampled stacks diagnose work; timings and memory are not benchmark verdicts.',
  source,
  variant: variant || 'default',
  instrumented: await fingerprintSource(source.root),
  harness: await iterationHarness(),
  profilerToolHash: digest(
    await Promise.all(
      ['profile-runner.mjs', 'profile-worker.mjs', 'summarise-profile.mjs', 'variants.mjs'].map(
        async (name) => [name, await readFile(resolve(import.meta.dirname, name), 'utf8')],
      ),
    ),
  ),
};
report.guard = await runGuarded(
  process.execPath,
  [resolve(import.meta.dirname, 'profile-worker.mjs'), source.root, output],
  {
    cwd: resolve(import.meta.dirname, '../../..'),
    limits: iterationLimits,

    onMessage(message) {
      if (message.type === 'stage') console.log(message.name);
      if (message.type === 'result') report.result = message.result;
    },
  },
);
report.status =
  report.guard.status === 'aborted'
    ? 'inconclusive'
    : report.guard.status === 'completed' && report.result?.status === 'completed'
      ? 'completed'
      : 'failed';
await writeFile(resolve(output, 'diagnostic.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: report.status,
    reason: report.guard.reason,
    scroll: report.result?.scroll,
    error: report.result?.error,
  }),
);
if (report.status !== 'completed') process.exitCode = report.status === 'inconclusive' ? 2 : 1;
