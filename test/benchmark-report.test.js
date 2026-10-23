import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exec, repositoryRoot } from '../scripts/memory/common.js';
import { iterationOptions } from '../scripts/memory/iteration-policy.js';
import { freezeSource, resolveBenchmarkRef } from '../scripts/memory/iteration-source.js';
import { comparisons } from '../scripts/memory/iteration-report.js';
import { iterationMarkdown } from '../scripts/memory/iteration-markdown.js';

test('posting defaults are committed HEAD against the latest release without changing optimisation defaults', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(scripts['benchmark:report'], 'node scripts/benchmark-optimisation.js --report');
  const report = iterationOptions(['--report']);
  assert.equal(report.baseline, 'latest-release');
  assert.equal(report.candidate, 'HEAD');
  assert.equal(report.mode, 'confirm');
  assert.equal(report.pairs, 5);
  const optim = iterationOptions([]);
  assert.equal(optim.baseline, 'HEAD');
  assert.equal(optim.candidate, undefined);
  assert.equal(optim.mode, 'screen');
  assert.equal(optim.pairs, 3);
  for (const args of [
    ['--report', '--baseline', 'v0.1.8', '--candidate', 'feature/report'],
    ['--candidate', 'feature/report', '--baseline', 'v0.1.8', '--report'],
  ]) {
    const options = iterationOptions(args);
    assert.equal(options.baseline, 'v0.1.8');
    assert.equal(options.candidate, 'feature/report');
  }
  assert.equal(iterationOptions(['--report', '--working-tree']).candidate, undefined);
  assert.equal(iterationOptions(['--candidate', 'HEAD~2']).candidate, 'HEAD~2');
  assert.equal(iterationOptions(['--report', '--pilot']).pairs, 1);
  assert.throws(() => iterationOptions(['--candidate', 'HEAD', '--working-tree']), /Choose/);
  assert.throws(() => iterationOptions(['--candidate']), /Missing/);
  assert.throws(() => iterationOptions(['--report', '--tabs', '60000']), /Unknown/);
});

async function repository(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'tabernacle-report-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(directory, 'repo');
  await mkdir(resolve(root, 'extension'), { recursive: true });
  const git = (...args) =>
    exec('git', [
      '-C',
      root,
      '-c',
      'user.name=Benchmark test',
      '-c',
      'user.email=benchmark@example.invalid',
      ...args,
    ]);
  await git('init', '-q');
  await writeFile(resolve(root, 'extension/manifest.json'), '{"version":"0.1.0"}');
  await writeFile(resolve(root, 'extension/code.js'), 'old\n');
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
  await writeFile(resolve(root, '.gitignore'), '*.local.js\n');
  await git('add', '.');
  await git('commit', '-qm', 'Old source');
  return { root, directory, git };
}

test('stable tag selection uses numeric versions and freezes tags, commits and explicit dirty sources independently', async (t) => {
  const { root, directory, git } = await repository(t);
  await git('tag', 'v0.9.0');
  const old = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(resolve(root, 'extension/code.js'), 'committed\n');
  await git('add', 'extension/code.js');
  await git('commit', '-qm', 'New source');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('tag', '-am', 'Stable release', 'v0.10.0');
  await git('tag', 'v0.2.0');
  await git('tag', 'v90.0.0-rc.1');
  await git('tag', 'unrelated-2026');
  await git('branch', 'v0.10.0', old);
  const latest = await resolveBenchmarkRef('latest-release', root);
  assert.equal(latest.ref, 'refs/tags/v0.10.0');
  assert.equal(latest.commit, head);
  assert.equal((await resolveBenchmarkRef('HEAD~1', root)).commit, old);
  await writeFile(resolve(root, 'extension/code.js'), 'dirty\n');
  await writeFile(resolve(root, 'extension/untracked.js'), 'untracked\n');
  await writeFile(resolve(root, 'extension/ignored.local.js'), 'ignored\n');
  const status = (await git('status', '--porcelain')).stdout;
  const oldSource = await freezeSource(resolve(directory, 'old'), 'v0.9.0', root);
  const newSource = await freezeSource(resolve(directory, 'new'), 'HEAD', root);
  const work = await freezeSource(resolve(directory, 'work'), undefined, root);
  assert.equal(oldSource.commit, old);
  assert.equal(newSource.commit, head);
  assert.equal(work.commit, head);
  assert.equal(await readFile(resolve(newSource.root, 'extension/code.js'), 'utf8'), 'committed\n');
  assert.equal(await readFile(resolve(oldSource.root, 'extension/code.js'), 'utf8'), 'old\n');
  assert.equal(await readFile(resolve(work.root, 'extension/code.js'), 'utf8'), 'dirty\n');
  assert.equal(await readFile(resolve(work.root, 'extension/untracked.js'), 'utf8'), 'untracked\n');
  await assert.rejects(readFile(resolve(work.root, 'extension/ignored.local.js')), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(resolve(newSource.root, 'extension/untracked.js')), {
    code: 'ENOENT',
  });
  assert.notEqual(newSource.sha256, work.sha256);
  assert.equal(work.ref, 'working tree');
  assert.equal(newSource.changes, '');
  assert(work.changes.includes('code.js'));
  assert.equal((await git('status', '--porcelain')).stdout, status);
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), head);
});

test('missing stable tags and invalid revisions never fall back to HEAD', async (t) => {
  const { root, directory, git } = await repository(t);
  await git('tag', 'v3.0.0-beta.1');
  await assert.rejects(resolveBenchmarkRef('latest-release', root), /No local stable release tag/);
  await assert.rejects(freezeSource(resolve(directory, 'missing'), 'no-such-version', root));
  await assert.rejects(freezeSource(resolve(directory, 'option'), '--help', root));
  await git('tag', '1.2.0');
  assert.equal((await resolveBenchmarkRef('latest-release', root)).ref, 'refs/tags/1.2.0');
});

function pairedReport() {
  const keys = {
    'Firefox/enabled-idle/unforced/resident.bytes': [80e6, 60e6, 1e6],
    'Firefox/warm-snapshots/reply-p95.ms': [20, 15, 0.1],
    'Firefox/enabled-idle/DOM-elements.count': [1000, 500, 0],
    'Node-100/cold-readers/reads.count': [100, 0, 0],
    'Node-100/create-close-burst/writes.count': [0, 2, 0],
    'Node-100/metadata-burst/elapsed.ms': [100, 150, 1],
    'Firefox/enabled-idle/unforced/added-resident.bytes': [-2e6, -1e6, 0],
  };
  const report = {
    status: 'completed',
    kind: 'optimisation-comparison',
    mode: 'confirm',
    requestedPairs: 5,
    noisePath: 'noise.json',
    sources: {
      baseline: { ref: 'refs/tags/v0.2.0', commit: 'a'.repeat(40), sha256: 'old' },
      candidate: { ref: 'HEAD', commit: 'b'.repeat(40), sha256: 'new' },
    },
    environment: {
      firefox: 'Firefox test',
      node: 'v24',
      cpu: 'Test CPU',
      logicalCpus: 8,
      physicalMemoryBytes: 16 * 1024 ** 3,
    },
    fixture: {
      seed: 17,
      native: { tabs: 1000, windows: 2, livePages: 1 },
      synthetic: [{ tabs: 100, windows: 1 }],
      readers: 2,
    },
    runs: [],
  };
  const noise = { runs: [] };
  for (let pair = 1; pair <= 5; pair++) {
    for (const [index, role] of ['baseline', 'candidate'].entries()) {
      report.runs.push({
        pair,
        role,
        status: 'completed',
        sourceHash: index ? 'new' : 'old',
        metrics: Object.fromEntries(
          Object.entries(keys).map(([key, values]) => [key, values[index]]),
        ),
        workers: ['native', 'synthetic'].map((kind) => ({
          kind,
          tabs: kind === 'native' ? 1000 : 100,
          guard: { status: 'completed' },
          result: { status: 'completed' },
        })),
      });
      noise.runs.push({
        metrics: Object.fromEntries(
          Object.entries(keys).map(([key, values]) => [
            key,
            values[0] + (index ? 1 : -1) * values[2],
          ]),
        ),
      });
    }
  }
  report.comparison = comparisons(report, noise);
  return report;
}

test('Markdown frames reductions positively while preserving units, assessments, N/A and regression flags', () => {
  const report = pairedReport();
  const markdown = iterationMarkdown(report);
  assert.match(
    markdown,
    /\| Metric \| Old: v0.2.0 \(aaaaaaaaaaaa\) \| New: HEAD \(bbbbbbbbbbbb\) \| Difference \|/,
  );
  assert.match(markdown, /80 MB \| 60 MB \| Improved 25% \(20 MB less memory\)/);
  assert.match(markdown, /20 ms \| 15 ms \| Improved 25% \(5 ms less time\)/);
  assert.match(markdown, /0 \| 2 \| Percentage N\/A \(2 more\); More work; review/);
  assert.match(markdown, /50% fewer \(500 fewer\); Descriptive count; review/);
  assert.match(markdown, /-2 MB \| -1 MB \| Percentage N\/A \(1 MB more memory\)/);
  assert.match(markdown, /Other metrics needing review/);
  assert.match(
    markdown,
    /Node-100\/metadata-burst\/elapsed.ms \| 100 ms \| 150 ms \| 50% more time \(50 ms more time\); Investigate regression/,
  );
  assert.match(markdown, /Fixture correctness checks \| Passed \| Passed \| Both passed/);
  assert.match(markdown, /Sampled extension-process RSS peak \| N\/A \| N\/A \| N\/A/);
  assert.match(markdown, /p95 rows are medians of each run’s p95/);
  const uncalibrated = structuredClone(report);
  delete uncalibrated.noisePath;
  uncalibrated.comparison = comparisons(uncalibrated);
  const raw = iterationMarkdown(uncalibrated);
  assert.match(raw, /No matching A\/A/);
  assert.match(raw, /Uncalibrated/);
  assert(!raw.includes('| Improved '));
});

test('whole-number percentages do not change noise verdicts or imply unchanged work after rounding', () => {
  const report = pairedReport();
  const metric = (name, old, next, verdict) => ({
    name,
    baseline: { median: old },
    candidate: { median: next },
    delta: next - old,
    relativeDelta: (next - old) / old,
    verdict,
  });
  report.comparison = [
    metric('Firefox/warm-snapshots/reply-p95.ms', 30, 2, 'Demonstrated improvement'),
    metric('Firefox/enabled-idle/unforced/resident.bytes', 1e6, 1004000, 'No demonstrated change'),
    metric('Firefox/warm-snapshots/payload.bytes', 1e6, 1000, 'Demonstrated improvement'),
    metric('Firefox/search/extensionCPU.ms', 100, 79.6, 'No demonstrated change'),
    metric('Node-100/cold-readers/reads.count', 100, 100, 'Unchanged work'),
    metric('Node-100/metadata-burst/elapsed.ms', 100, 133.5, 'Investigate regression'),
  ];
  const before = structuredClone(report);
  const markdown = iterationMarkdown(report);
  assert.match(markdown, /Improved 93% \(28 ms less time\)/);
  assert.match(markdown, /0% more memory \(0.004 MB more memory\); No demonstrated change/);
  assert.match(markdown, /Improved 100% \(999 kB less data\)/);
  assert.match(markdown, /20% less CPU time \(20.4 ms less CPU time\); No demonstrated change/);
  assert.match(markdown, /Unchanged \(0%\); Unchanged work/);
  assert.match(markdown, /34% more time \(33.5 ms more time\); Investigate regression/);
  assert(!/[+−-]\d+(?:\.\d+)?%/.test(markdown));
  assert(!/\d+\.\d+%/.test(markdown));
  assert.deepEqual(
    report,
    before,
    'Display rounding must not mutate stored measurements or verdicts',
  );
});

test('headlines keep five relevant measures, compact units and adverse or uncertain results', () => {
  const report = pairedReport();
  const headline = (markdown) =>
    markdown.split('## Headline results\n')[1].split('## CPU and memory overview\n')[0];
  const rows = (markdown) =>
    headline(markdown)
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .slice(2);
  const originalLabels = rows(iterationMarkdown(report)).map((line) => line.split('|')[1]);
  assert.equal(originalLabels.length, 5);
  const metric = (name, old, next, verdict) => ({
    name,
    baseline: { median: old },
    candidate: { median: next },
    delta: next - old,
    relativeDelta: (next - old) / old,
    verdict,
  });
  report.comparison.push(
    metric('Firefox/folder-actions/elapsed.ms', 1000, 1200, 'Investigate regression'),
    metric('Firefox/search/elapsed.ms', 100, 150, 'Investigate regression'),
    metric('Firefox/warm-snapshots/payload.bytes', 1e6, 1, 'Demonstrated improvement'),
  );
  report.comparison.find((item) => item.name.endsWith('/reply-p95.ms')).verdict =
    'Uncalibrated; run --calibrate';
  const before = structuredClone(report);
  const markdown = iterationMarkdown(report);
  const summary = headline(markdown);
  assert(markdown.indexOf('## Headline results') < markdown.indexOf('## Firefox'));
  assert.deepEqual(
    rows(markdown).map((line) => line.split('|')[1]),
    originalLabels,
  );
  assert.match(
    summary,
    /Memory while idle \(extension process\) \| 80 MB \| 60 MB \| Improved 25%/,
  );
  assert.match(
    summary,
    /Folder action time \(test sequence\) \| 1 s \| 1.2 s \| 20% more time; Investigate regression/,
  );
  assert.match(
    summary,
    /Tab data reply time \(p95\) \| 20 ms \| 15 ms \| 25% less time; Uncalibrated/,
  );
  assert.match(summary, /Peak memory \(sampled extension process\) \| N\/A \| N\/A/);
  assert(!summary.includes('payload'));
  assert.match(summary, /2 Firefox metrics; 2 synthetic controller metrics/);
  assert.match(summary, /not total browser RAM/);
  assert.match(summary, /not a complete click-to-screen response/);
  assert.match(summary, /not a battery-life measurement/);
  assert.deepEqual(report, before);
});

test('resource overview follows fixed headlines and keeps scoped CPU and memory assessments', () => {
  const report = pairedReport();
  report.comparison.push({
    name: 'Firefox/active-workload/extensionCPU.ms',
    baseline: { median: 1000 },
    candidate: { median: 1300 },
    delta: 300,
    relativeDelta: 0.3,
    verdict: 'Investigate regression',
  });
  const markdown = iterationMarkdown(report);
  assert(markdown.indexOf('## Headline results') < markdown.indexOf('## CPU and memory overview'));
  assert(markdown.indexOf('## CPU and memory overview') < markdown.indexOf('## Firefox'));
  assert.match(
    markdown,
    /Total CPU time \(fixed active workload\) \| 1,000 ms \| 1,300 ms \| 30% more CPU time \(300 ms more CPU time\); Investigate regression/,
  );
  assert.match(markdown, /Idle CPU time \(five-second quiet sample\) \| N\/A \| N\/A/);
  assert.match(markdown, /summed within each run before comparing medians/);
  assert.match(markdown, /not an instantaneous CPU percentage/);
  assert.match(markdown, /1 Firefox metrics; 2 synthetic controller metrics/);
  report.status = 'inconclusive';
  assert(!iterationMarkdown(report).includes('## CPU and memory overview'));
  report.status = 'completed';
  report.syntheticOnly = true;
  assert(!iterationMarkdown(report).includes('## CPU and memory overview'));
});

test('synthetic-only or absent native measurements do not produce Firefox headlines', () => {
  const report = pairedReport();
  report.syntheticOnly = true;
  assert(!iterationMarkdown(report).includes('## Headline results'));
  report.syntheticOnly = false;
  report.comparison = report.comparison.filter((item) => item.name.startsWith('Node-'));
  assert(!iterationMarkdown(report).includes('## Headline results'));
});

test('failed, partial, calibration and pilot reports cannot masquerade as paired evidence', () => {
  for (const status of ['running', 'failed', 'inconclusive']) {
    const report = pairedReport();
    report.status = status;
    report.runs.pop();
    const markdown = iterationMarkdown(report);
    assert(!markdown.includes('| Improved '));
    assert(!markdown.includes('## Headline results'));
    assert.match(markdown, /No complete paired comparison/);
    assert.match(markdown, /Passed \| Not verified/);
    assert.deepEqual(comparisons(report), []);
  }
  const report = pairedReport();
  report.kind = 'optimisation-noise';
  assert(!iterationMarkdown(report).includes('Both passed'));
  assert(!iterationMarkdown(report).includes('## Headline results'));
  report.kind = 'optimisation-comparison';
  report.mode = 'pilot';
  report.requestedPairs = 1;
  report.runs = report.runs.filter((r) => r.pair === 1 && r.role === 'candidate');
  report.comparison = comparisons(report);
  assert.deepEqual(report.comparison, []);
  assert.match(iterationMarkdown(report), /No complete paired comparison/);
  assert(!iterationMarkdown(report).includes('## Headline results'));
  const incomplete = pairedReport();
  incomplete.runs[0].status = 'failed';
  assert.deepEqual(comparisons(incomplete), []);
  const duplicate = pairedReport();
  duplicate.runs[0].pair = 2;
  assert.deepEqual(comparisons(duplicate), []);
});

test('Markdown escapes refs and failure text and labels working-tree and synthetic-only reports', () => {
  const report = pairedReport();
  report.sources.baseline.ref = 'tag|<script>\n**bold**`';
  report.sources.candidate.ref = 'working tree';
  report.error = '<img src=x> | error\nnext line';
  report.syntheticOnly = true;
  const markdown = iterationMarkdown(report);
  assert(!markdown.includes('<script>'));
  assert(!markdown.includes('<img'));
  assert.match(markdown, /&#124;/);
  assert.match(markdown, /&#96;/);
  assert.match(markdown, /includes the frozen working tree/);
  assert.match(markdown, /Synthetic-only run: no Firefox RAM/);
  assert(!markdown.includes('## Firefox'));
});

test('CLI help describes reporting without launching Firefox and refuses existing evidence directories', async (t) => {
  const { directory } = await repository(t);
  const script = resolve(repositoryRoot, 'scripts/benchmark-optimisation.js');
  const help = await exec(process.execPath, [script, '--report', '--help']);
  assert.match(help.stdout, /committed HEAD/);
  assert.match(help.stdout, /report.md/);
  const destination = resolve(directory, 'evidence');
  await mkdir(destination);
  await writeFile(resolve(destination, 'report.md'), 'preserve me');
  await assert.rejects(
    exec(process.execPath, [script, '--report', '--output', destination]),
    /EEXIST/,
  );
  assert.equal(await readFile(resolve(destination, 'report.md'), 'utf8'), 'preserve me');
});
