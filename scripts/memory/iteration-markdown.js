// Keep the posting table stable across releases; raw samples and the full metric
// catalogue remain in report.json/report.html beside this summary.
// Select headlines by user relevance, never by the largest favourable delta.
const headlineRows = [
  ['Peak memory (sampled extension process)', 'Firefox/sampled-extension-RSS-peak.bytes'],
  ['Tab data reply time (p95)', 'Firefox/warm-snapshots/reply-p95.ms'],
  ['Folder action time (test sequence)', 'Firefox/folder-actions/elapsed.ms'],
  ['Processor time during folder actions', 'Firefox/folder-actions/extensionCPU.ms'],
];
const resourceRows = [
  ['Idle memory added (unorganised tabs)', 'Firefox/enabled-idle/unforced/added-resident.bytes'],
  ['Idle CPU time (five-second quiet sample)', 'Firefox/quiet-idle/extensionCPU.ms'],
  ['Total CPU time (fixed active workload)', 'Firefox/active-workload/extensionCPU.ms'],
  ['Total elapsed time (fixed active workload)', 'Firefox/active-workload/elapsed.ms'],
];
const nativeRows = [
  ['Idle extension-process resident memory', 'enabled-idle/unforced/resident.bytes'],
  ['Idle resident memory added versus disabled', 'enabled-idle/unforced/added-resident.bytes'],
  ['Idle extension-process heap after collection', 'enabled-idle/collected/heap-allocated.bytes'],
  ['Sampled extension-process RSS peak', 'sampled-extension-RSS-peak.bytes'],
  ['Heap after closing sidebars (collected)', 'sidebars-closed/collected/heap-allocated.bytes'],
  ['Heap after three view cycles (collected)', 'view-cycles/collected/heap-allocated.bytes'],
  ['Enable and initial sidebar settlement', 'enabled-initial/elapsed.ms'],
  ['Warm snapshot reply latency, median', 'warm-snapshots/reply-median.ms'],
  ['Warm snapshot reply latency, p95', 'warm-snapshots/reply-p95.ms'],
  ['Search sequence including settlement', 'search/elapsed.ms'],
  ['Folder operations including settlement', 'folder-actions/elapsed.ms'],
  ['Sidebar reopening including settlement', 'sidebars-reopened/elapsed.ms'],
  ['Idle phase extension CPU time', 'enabled-idle/extensionCPU.ms'],
  ['Quiet idle extension CPU time (five seconds)', 'quiet-idle/extensionCPU.ms'],
  ['Quiet idle measured duration', 'quiet-idle/elapsed.ms'],
  ['Fixed active workload extension CPU time', 'active-workload/extensionCPU.ms'],
  ['Fixed active workload elapsed time', 'active-workload/elapsed.ms'],
  ['Search sequence extension CPU time', 'search/extensionCPU.ms'],
  ['Folder operations extension CPU time', 'folder-actions/extensionCPU.ms'],
  ['Warm snapshot reply payload, total', 'warm-snapshots/payload.bytes'],
  ['Idle sidebar DOM elements', 'enabled-idle/DOM-elements.count'],
];
const syntheticRows = [
  ['Cold reader workload', 'cold-readers/elapsed.ms'],
  ['Warm reader workload', 'warm-readers/elapsed.ms'],
  ['Cold retained heap', 'cold-readers/retained-heap.bytes'],
  ['Create/close sampled heap peak', 'create-close-burst/sampled-peak-heap.bytes'],
  ['Heap after readers close', 'readers-closed/retained-heap.bytes'],
  ['Warm reply payload, total', 'warm-readers/payload.bytes'],
  ['Cold session API reads', 'cold-readers/reads.count'],
  ['Create/close session API writes', 'create-close-burst/writes.count'],
];

const escape = (value) =>
  String(value ?? 'Unavailable')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/([*_\[\]\\])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
const number = (value) => value.toLocaleString('en-GB', { maximumFractionDigits: 3 });

function unitFor(name) {
  if (name.endsWith('/payload.bytes')) return { scale: 1e3, unit: 'kB' };
  if (name.endsWith('.bytes')) return { scale: 1e6, unit: 'MB' };
  return { scale: 1, unit: name.endsWith('.ms') ? 'ms' : '' };
}

function value(name, amount) {
  if (!Number.isFinite(amount)) return 'N/A';
  const { scale, unit } = unitFor(name);
  return `${number(amount / scale)}${unit ? ` ${unit}` : ''}`;
}

function assessment(item) {
  // DOM/row counts describe the rendered workload, not an optimisation verdict.
  if (item.name.endsWith('.count') && !/\/(reads|writes|peakReads)\.count$/.test(item.name))
    return item.delta === 0 ? 'Unchanged count' : 'Descriptive count; review';
  return item.verdict;
}

function difference(item, { headline = false } = {}) {
  if (!item || !Number.isFinite(item.delta)) return 'N/A — comparable samples unavailable';
  const verdict = assessment(item);
  if (item.delta === 0) return `Unchanged (0%); ${escape(verdict)}`;
  const lower = item.delta < 0;
  const quantity = item.name.endsWith('/payload.bytes')
    ? 'data'
    : item.name.endsWith('.bytes')
      ? 'memory'
      : item.name.endsWith('CPU.ms')
        ? 'CPU time'
        : item.name.endsWith('.ms')
          ? 'time'
          : '';
  const direction = lower ? (quantity ? 'less' : 'fewer') : 'more';
  const description = `${direction}${quantity ? ` ${quantity}` : ''}`;
  const absolute = `${value(item.name, Math.abs(item.delta))} ${description}`;
  const percent = Number.isFinite(item.relativeDelta)
    ? `${Math.round(Math.abs(item.relativeDelta) * 100)}%`
    : null;
  if (percent && verdict === 'Demonstrated improvement')
    return `Improved ${percent}${headline ? '' : ` (${absolute})`}`;
  if (headline && percent) return `${percent} ${description}; ${escape(verdict)}`;
  return `${percent ? `${percent} ${description}` : 'Percentage N/A'} (${absolute}); ${escape(verdict)}`;
}

function headlineValue(name, amount, item) {
  if (!Number.isFinite(amount)) return 'N/A';
  // Use the same units on both sides; compact display never affects assessment.
  const seconds =
    name.endsWith('.ms') &&
    Math.max(item?.baseline.median ?? 0, item?.candidate.median ?? 0) >= 1000;
  const { scale, unit } = seconds ? { scale: 1000, unit: 's' } : unitFor(name);
  const rounded = (amount / scale).toLocaleString('en-GB', {
    maximumFractionDigits: seconds ? 2 : 1,
  });
  return `${rounded}${unit ? ` ${unit}` : ''}`;
}

function sourceLabel(source) {
  if (!source) return 'Unavailable';
  return `${source.ref?.replace(/^refs\/(tags|heads)\//, '')} (${source.commit?.slice(0, 12)})`;
}

function table(rows, metrics, headers, correctness, { headline = false } = {}) {
  const lines = [
    `| Metric | Old: ${escape(headers[0])} | New: ${escape(headers[1])} | Difference |`,
    '| :--- | ---: | ---: | :--- |',
    ...rows.map(([label, name]) => {
      const item = metrics.get(name);
      const format = (amount) =>
        headline ? headlineValue(name, amount, item) : value(name, amount);
      return `| ${escape(label)} | ${format(item?.baseline.median)} | ${format(item?.candidate.median)} | ${difference(item, { headline })} |`;
    }),
  ];
  if (correctness)
    lines.push(
      `| Fixture correctness checks | ${correctness[0]} | ${correctness[1]} | ${correctness.every((v) => v === 'Passed') ? 'Both passed' : 'N/A — incomplete verification'} |`,
    );
  return lines.join('\n');
}

function correct(report, role, kind, tabs) {
  if (report.kind !== 'optimisation-comparison') return 'Not verified';
  const runs = (report.runs || []).filter((run) => run.role === role);
  return runs.length === report.requestedPairs &&
    runs.length > 0 &&
    runs.every((run) => {
      const worker = run.workers?.find(
        (w) => w.kind === kind && (tabs === undefined || w.tabs === tabs),
      );
      return (
        run.sourceHash === report.sources?.[role]?.sha256 &&
        worker?.guard?.status === 'completed' &&
        worker.result?.status === 'completed'
      );
    })
    ? 'Passed'
    : 'Not verified';
}

export function iterationMarkdown(report) {
  const idleOnly = Boolean(report.idleOnly);
  const complete = report.status === 'completed' && report.kind === 'optimisation-comparison';
  const metrics = new Map(
    (complete ? report.comparison || [] : []).map((item) => [item.name, item]),
  );
  const sources = report.sources || {};
  const headers = [sourceLabel(sources.baseline), sourceLabel(sources.candidate)];
  const env = report.environment || {};
  const native = report.fixture?.native;
  const lines = [
    '# Tabernacle benchmark comparison',
    '',
    `Status: **${escape(report.status)}** · Mode: ${escape(report.mode)} · Requested pairs: ${report.requestedPairs ?? 'N/A'}.`,
    `Recorded: ${escape(report.finishedAt || report.startedAt)}. Values are medians across runs; p95 rows are medians of each run’s p95.`,
    '',
    `Old: ${escape(headers[0])}. New: ${escape(headers[1])}.`,
    `Runtime: ${escape(env.firefox || 'No Firefox measurements')} · Node ${escape(env.node)}.`,
    `Machine: ${escape(env.cpu)} · ${env.logicalCpus ?? 'N/A'} logical CPUs · ${Number.isFinite(env.physicalMemoryBytes) ? number(env.physicalMemoryBytes / 1024 ** 3) : 'N/A'} GiB RAM · ${escape(env.platform)} ${escape(env.osRelease)} ${escape(env.arch)}.`,
    '',
    report.noisePath
      ? 'Matched five-pair A/A calibration applied. Timing/memory improvements require five comparison pairs, >10% reduction, >3× the full A/A range and agreement in every pair.'
      : 'No matching A/A calibration applied. Timing/memory differences do not establish an improvement.',
    'Differences describe the reduction or increase relative to the old version, with unsigned percentages rounded to whole numbers. “Improved” means a demonstrated reduction in time/memory/data, not an increase in throughput. Rounded 0% and 100% can represent small nonzero changes or remaining values; assessments use unrounded measurements. Percentages are N/A for zero or negative baselines. Counts can describe workload rather than quality.',
  ];
  if (report.error) lines.push('', `Run issue: ${escape(report.error)}`);
  if (!complete || !metrics.size)
    lines.push(
      '',
      '**No complete paired comparison is available. N/A does not mean zero or unchanged. Partial samples remain in the raw evidence.**',
    );
  if (sources.candidate?.ref === 'working tree')
    lines.push(
      '',
      '**The new version includes the frozen working tree, including uncommitted extension changes. Its source hash, not HEAD alone, identifies the measured code.**',
    );

  if (!report.syntheticOnly && [...metrics.keys()].some((name) => name.startsWith('Firefox/'))) {
    const flags = [...metrics.values()].filter((item) =>
      /Investigate regression|More work/.test(assessment(item)),
    );
    const nativeFlags = flags.filter((item) => item.name.startsWith('Firefox/')).length;
    const syntheticFlags = flags.filter((item) => item.name.startsWith('Node-')).length;
    lines.push(
      '',
      '## Headline results',
      '',
      `Firefox workload: ${idleOnly ? number(report.fixture.idle.sizes[0].tabs) : (native?.tabs ?? 'N/A')} mostly discarded tabs across ${idleOnly ? report.fixture.idle.windows : (native?.windows ?? 'N/A')} sidebars. The idle rows use populated folder fixtures; their sizes are shown below. These measures stay fixed for the selected workload, including when they worsen or show no demonstrated change.`,
      '',
      table(
        [
          ...(report.fixture?.idle?.sizes || [{ tabs: 1000, folders: 100 }]).map(
            ({ tabs, folders }) => [
              `Idle RAM added (${number(tabs)} tabs / ${number(folders)} folders)`,
              `Firefox/idle-${tabs}/enabled-idle/settled-added-resident.bytes`,
            ],
          ),
          ...(idleOnly ? [] : headlineRows),
        ],
        metrics,
        headers,
        undefined,
        { headline: true },
      ),
      '',
      'Idle RAM is the added resident memory after natural settlement with all folders expanded, compared with Tabernacle disabled in the same profile. Setup and verification finish before a 30–60 second quiet period, with no forced GC/CC. It is not total browser RAM.' +
        (idleOnly
          ? ''
          : ' Peak memory includes Firefox runtime and the control extension. The p95 reply time describes the slower end of warm tab-data requests, not a complete click-to-screen response. Folder timings include test settlement overhead; processor time is not a battery-life measurement.'),
      '',
      `Regression review flags across the full comparison: **${nativeFlags} Firefox metrics; ${syntheticFlags} synthetic controller metrics**. See the detailed tables for every flag. Synthetic heap is not Firefox RAM; multiple flags can describe related effects.`,
    );
    if (!idleOnly)
      lines.push(
        '',
        '## CPU and memory overview',
        '',
        table(resourceRows, metrics, headers),
        '',
        'Read these alongside the settled folder-idle memory in the headlines. Added memory subtracts the same profile with Tabernacle disabled; it is an estimate of the extension’s additional process cost.',
        '',
        'Quiet idle waits five seconds with both sidebars open and no snapshot requests or DOM traversal inside the CPU window. It follows forced collection and includes CPU-sampling boundary overhead; it is not a long-term idle or battery test. For scale, 50 ms of CPU over five seconds is about 1% of one core, not 1% of the whole machine.',
        '',
        'The fixed active workload totals startup, warm requests, search, title updates, folder actions, reopening and three view cycles. CPU and elapsed times are summed within each run before comparing medians. They include verification/settlement work, exclude idle/closed/disable phases and explicit memory collection, and do not measure all work performed by Firefox on the extension’s behalf. Lower CPU time means less processor work for this fixture; it is not an instantaneous CPU percentage.',
      );
  }

  const selected = new Set();
  if (!report.syntheticOnly) {
    const rows = (report.fixture?.idle?.sizes || [{ tabs: 1000, folders: 100 }]).flatMap(
      ({ tabs, folders }) => {
        const label = `${number(tabs)} tabs / ${number(folders)} folders`,
          prefix = `Firefox/idle-${tabs}`;
        return [
          [
            `${label}: resident memory added`,
            `${prefix}/enabled-idle/settled-added-resident.bytes`,
          ],
          [
            `${label}: enabled process resident memory`,
            `${prefix}/enabled-idle/settled-resident.bytes`,
          ],
          [
            `${label}: disabled process resident memory`,
            `${prefix}/disabled-final/settled-resident.bytes`,
          ],
          [`${label}: time allowed to settle`, `${prefix}/enabled-idle/elapsed.ms`],
        ];
      },
    );
    rows.forEach(([, key]) => selected.add(key));
    lines.push(
      '',
      '## Settled idle memory',
      '',
      table(
        rows,
        metrics,
        headers,
        ['baseline', 'candidate'].map((role) => correct(report, role, 'idle-native')),
      ),
      '',
      'Each size runs in a fresh isolated Firefox profile. All folders are expanded and populated in both sidebars, with three levels of folders and unloaded native tabs. After setup and complete sidebar verification, the extension gets at least 30 seconds to release startup memory naturally. OS RSS is sampled every two seconds; the final ten-second window must span no more than 1 MiB or 1% of resident memory, whichever is larger. If it has not settled within 60 seconds, the run is inconclusive.',
      '',
      'No forced GC/CC, snapshot requests, DOM traversal or tab/folder actions occur during the quiet period. The headline uses median OS RSS from the final stable window, before diagnostic memory reporters run. It subtracts the settled disabled sample from the settled enabled sample of the same extension process. Both retain the same native tabs and saved organisation. Negative estimates are retained, not clamped; memory retained by the allocator after disabling can make this estimate conservative. These are estimates of added extension-process RAM, not exact ownership or whole-browser RAM.',
    );
  }
  if (!report.syntheticOnly && !idleOnly) {
    const rows = nativeRows.map(([label, key]) => [label, `Firefox/${key}`]);
    rows.forEach(([, key]) => selected.add(key));
    lines.push(
      '',
      '## Firefox',
      '',
      `Workload: ${native?.tabs ?? 'N/A'} mostly discarded fixture tabs, ${native?.windows ?? 'N/A'} real sidebars, ${native?.livePages ?? 'N/A'} live page; seed ${report.fixture?.seed ?? 'N/A'}. Control tabs are additional.`,
      '',
      table(
        rows,
        metrics,
        headers,
        ['baseline', 'candidate'].map((role) => correct(report, role, 'native')),
      ),
    );
  } else lines.push('', '**Synthetic-only run: no Firefox RAM, CPU or user-interface evidence.**');

  for (const fixture of report.fixture?.synthetic || []) {
    const rows = syntheticRows.map(([label, key]) => [label, `Node-${fixture.tabs}/${key}`]);
    rows.forEach(([, key]) => selected.add(key));
    lines.push(
      '',
      `## Synthetic controller — ${number(fixture.tabs)} tabs`,
      '',
      `${fixture.windows} simulated windows, ${report.fixture.readers} retained readers per window. Node heap includes fixtures and readers; it is not Firefox RAM.`,
      '',
      table(
        rows,
        metrics,
        headers,
        ['baseline', 'candidate'].map((role) => correct(report, role, 'synthetic', fixture.tabs)),
      ),
    );
  }
  const otherRegressions = [...metrics.values()].filter(
    (item) => !selected.has(item.name) && /Investigate regression|More work/.test(assessment(item)),
  );
  if (otherRegressions.length)
    lines.push(
      '',
      '## Other metrics needing review',
      '',
      table(
        otherRegressions.map((item) => [item.name, item.name]),
        metrics,
        headers,
      ),
    );
  lines.push(
    '',
    '## Measurement notes',
    '',
    '- The extension process includes Firefox runtime and a fixed control extension. “Added” memory subtracts the disabled sample in the same profile; absolute process memory is not Tabernacle alone.',
    '- Collected heap measures retention after GC/CC, not ordinary settled RAM. Later lifecycle samples have earlier collections in their history. RSS peaks are sampled once per second, not exact peaks.',
    '- Search, enable, folder and reopening times include harness/settlement overhead and a 200 ms stability-observation floor. They are workload timings, not pure interaction latency. CPU rows measure process CPU time during those phases, not CPU percentage. The older enabled-idle CPU phase also includes sidebar verification; use the separate quiet-idle row for the controlled five-second sample.',
    '- Discarded tabs with fallback icons do not represent heavy websites, extensive favicons or other installed extensions. Fixture checks do not replace functional, upgrade or high-capacity suites.',
    '- The tables use a fixed metric selection and include additional regression flags from the full comparison. Missing metrics are N/A; an incompatible revision or failed worker prevents a successful comparison.',
    '',
    '## Evidence',
    '',
    '[Raw samples, ranges and all metrics](report.json) · [Full comparison](report.html)',
    '',
    `Old commit: ${escape(sources.baseline?.commit)}; extension SHA-256: ${escape(sources.baseline?.sha256)}.`,
    `New commit: ${escape(sources.candidate?.commit)}; extension SHA-256: ${escape(sources.candidate?.sha256)}.`,
    `Harness SHA-256: ${escape(report.harness?.sha256)}. Context: ${escape(report.contextKey)}.`,
    '',
    'Relative evidence links refer to sibling files; include those files or update the links when posting elsewhere.',
    '',
  );
  return lines.join('\n');
}
