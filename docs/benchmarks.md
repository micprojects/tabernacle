# Benchmark procedures

## Benchmark reports for posting

Use the project skill **tabernacle-benchmark** (for example, “Generate a benchmark
table against the latest release”), or run:

```sh
# Node 24 from .nvmrc. Latest stable release tag versus committed HEAD.
npm run benchmark:report

# Either side can be a tag, commit or branch.
npm run benchmark:report -- --baseline v0.2.0 --candidate HEAD

# Include uncommitted extension changes only when explicitly requested.
npm run benchmark:report -- --baseline v0.2.0 --working-tree
```

`benchmark:report` uses the existing bounded optimisation harness with `--report`:
five alternating comparison pairs and matching five-pair A/A calibration (created
first if needed). It defaults to **committed HEAD**, excluding dirty files. The
ordinary `benchmark:optim` command keeps its existing HEAD-versus-working-tree,
three-pair screening defaults. `--candidate REF` selects a committed candidate for
either command; it cannot be combined with `--working-tree`.

The default old version, `latest-release`, means the highest numeric stable local
tag matching `vMAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH`. Prereleases and unrelated
tags are excluded; tag creation dates and ancestry do not determine selection.
There is no implicit network fetch. Fetch missing release tags without forcing
replacements, or pass `--baseline REF`. No matching stable tag is an error, not a
fallback to HEAD. Both sides are exported without changing the checkout. Resolved
commit IDs and extension content hashes identify exactly what ran, even if a branch
or tag later moves. The same current harness, dependencies and runtime measure both
versions; incompatible historical revisions fail visibly instead of being patched.

Each fresh `test-results/memory/iteration/run-*/` directory contains `report.md`,
`report.html`, `report.json`, logs and frozen sources. `--output DIRECTORY` requires
a new directory and never replaces previous evidence. All benchmark modes now emit
Markdown. A stopped or calibration-only run also leaves its report at the run root;
setup errors can occur before reports exist. Exit 1 is failure; exit 2 is inconclusive.

The Markdown has four columns: **Metric | Old: ref (commit) | New: ref (commit) |
Difference**. Values are medians across runs. Differences use positive, whole-number
percentages and explicit direction: for example, `Improved 93% (28 ms less time)`
for a demonstrated reduction, or `33% more time (1.429 ms more time); Investigate
regression`. Inconclusive reductions keep their existing assessment. Timing
reductions describe less time, not percentage increases in speed/throughput.
Rounding affects presentation only: 0% and 100% can represent small nonzero changes
or remaining values, and assessments still use unrounded measurements. Percentages
for zero/negative baselines and absent comparisons are N/A. Raw JSON and the full
diagnostic HTML retain signed differences.

A five-row **Headline results** table precedes the detailed tables in completed
native comparisons. Its fixed measures are idle extension-process memory, sampled
peak memory, warm tab-data reply p95, folder-action sequence time and processor
time for that sequence. These are chosen for relevance, not by the size or direction
of a change; regressions, inconclusive changes and missing values remain visible.
Headline values use compact precision and common units on both sides; percentages
and assessments still come from the unrounded results. A nearby note counts all
Firefox and synthetic regression flags, including those outside the five rows,
and explains the scope of the measurements. Synthetic-only, pilot, calibration or
incomplete runs do not produce a native headline comparison.

The detailed fixed selection covers Firefox memory, response latency, timed UI sequences,
CPU time, payloads, DOM counts and lifecycle retention, then separate Node tables
for each synthetic size with heap, timings and session API counts. Additional
regression flags outside that selection are included automatically. Full metric
sets, ranges, samples and provenance remain in the HTML/JSON. Fixture correctness
rows are not substitutes for release or upgrade tests.

Include the report's machine/runtime/workload context and measurement notes when
posting. Its relative evidence links require accompanying files or updated links
at the destination. `--pilot` is candidate-only and supplies no paired comparison;
`--synthetic-only` supplies no Firefox evidence. Neither is a substitute for a
complete comparison report. Read the measurement limits below before interpreting
numbers. This command generates local artifacts; it does not publish them.

The discoverable skill is maintained in
[.agents/skills/tabernacle-benchmark/SKILL.md](../.agents/skills/tabernacle-benchmark/SKILL.md).
Only that skill file is exempted from the agent-state Git ignore rules. Benchmark
tools live in `scripts/`; the skill delegates calculations and formatting to them.

## Optimisation benchmarks

**Use `npm run benchmark:optim` for routine performance and memory work.**
`benchmark:memory` and `benchmark:memory:firefox` are aliases for this same bounded
workflow. Larger native matrices and 60,000-tab runs are exceptions for a specific
capacity question, not the default way to assess an optimisation.

```sh
# Node 24 from .nvmrc; compare committed HEAD with the current working tree.
npm run benchmark:optim

# Establish five fresh A/A pairs once for the chosen baseline and harness.
npm run benchmark:optim -- --calibrate

# Confirm a promising change with five fresh alternating comparison pairs.
# This calibrates first if no matching recent A/A report exists.
npm run benchmark:optim -- --confirm

# An explicit older commit/tag can be the baseline.
npm run benchmark:optim -- --baseline v0.2.0 --confirm

# Fast controller-only screening. This produces NO Firefox memory evidence.
npm run benchmark:memory:synthetic

# One candidate smoke run: no comparison or performance verdict.
npm run benchmark:optim -- --pilot
```

The default screen uses **three alternating pairs**, each in a fresh process and
owned temporary Firefox profile. The workload is fixed, with no automatic ramp:

- Native Firefox: **1,000 discarded fixture tabs across two real sidebars**, plus
  the control/seed tab in each window. It measures enable/idle, warm messages,
  search, one live page generating six title changes, folder moves/nesting/folds,
  sidebar closure/reopening, three view cycles and final disable.
- Synthetic controller/transport: **100 / 1,000 / 10,000 tabs**, across 1 / 2 / 9
  windows, with two readers per window. These deterministic fixtures include
  hierarchy, folders, pins, containers, Saved for Later and opaque saved fields;
  phases cover cold/warm reads, metadata, creation/closure, readers and restart.
- Every real sidebar must match the complete authoritative IDs, titles, pins and
  row order, with three stable observations before memory collection and another
  verification afterwards. The observer uses one-shot frame messages and asserts
  that DevTools is detached; it does not depend on the old debugger startup path.
- Both legacy and incremental synthetic readers retain their displayed snapshot
  across collection. Comparing a retained incremental snapshot with a discarded
  legacy full reply would bias the memory result.

Reports live under `test-results/memory/iteration/run-*/`: `report.html` provides
charts and metric medians/ranges, `report.md` provides posting tables, and
`report.json` contains every sample, phase,
work count, source fingerprint, fixture fingerprint, runtime, machine and guard
observation. Native measurements include extension-process resident/unique memory,
heap allocation before and after GC/CC, the difference from the same profile with
Tabernacle disabled, process CPU time, reply latency/bytes, DOM counts and lifecycle
retention. One-second OS RSS samples capture an approximate extension-process peak;
the independent watchdog also records the aggregate owned-process peak.

Baseline and candidate sources are frozen before launch. `--baseline REF` defaults
to HEAD; the candidate includes tracked and non-ignored untracked extension files
from the working tree, including uncommitted changes. Ignored local files do not
enter the export. Fingerprints identify actual contents; a commit name alone does
not describe an uncommitted candidate. The harness is checked for changes during
measurement. Do not edit benchmark code or run other test loads concurrently.
`--output DIRECTORY` chooses a fresh evidence directory and refuses to overwrite an
existing directory. `--noise REPORT_JSON` supplies an explicit calibration.

A/A calibration contains **five complete same-source pairs**. It is cached for
24 hours only when baseline contents, harness/dependencies, fixture, Node/Firefox,
machine and native/synthetic mode match. Changing benchmark code invalidates the
cache. Screening without matching calibration still records useful raw measurements
and deterministic work counts, but labels timing/memory differences uncalibrated.
It never calls a three-pair screen a demonstrated improvement.

A promising timing/memory improvement must reduce the metric by more than 10% and
three times the full A/A range, with the same direction in every paired sample.
Five-pair confirmation is required before the report says “demonstrated improvement”.
Investigate regressions above both thresholds. Stable deterministic read/write/work
counts are assessed separately. Inspect all relevant metrics and run the affected
functional suites before keeping a change; an improvement in one metric does not
cancel a regression elsewhere. After five additional inconclusive pairs, record no
demonstrated improvement. There are no universal millisecond or RAM pass thresholds.

The iteration guard runs **outside the WebDriver queue**, requires normal macOS
pressure and at least 30% pressure-free memory, and stops at **4 GiB aggregate
owned-process RSS**, critical pressure, three readings below 20% pressure-free
memory, 60 seconds without progress or five minutes per worker. The entire command
has a 30-minute budget. One-second sampling permits a small overshoot. These limits
can only tighten the older 4 GiB/30-minute ceilings. Resource stops preserve partial
results, stop the batch and exit 2 (inconclusive); correctness failures exit 1. No
automatic retries, larger runs, app closures or raised limits are allowed.

The routine RSS cap was explicitly raised from 3 to 4 GiB following an operator-requested
review of the 16 GiB MacBook Air: approximately 7.9 GiB physically free, 80% reported
pressure-free memory and no swap in use. This matches, rather than raises, the existing
hard ceiling; pressure and time guards remain unchanged. Close unnecessary applications
before measurements and avoid memory-cleaning utilities during runs. This headroom does
not guarantee completion: resource stops remain inconclusive, not grounds for automatic
retries or further limit increases. The harness change invalidates previous A/A calibration.

Interpret the metrics separately. Node heap includes fixtures and readers and is
**not Firefox RAM**. The control extension keeps the shared extension process alive
for off/on/off attribution; its fixed overhead is included in absolute process RAM.
The first enabled idle memory sample precedes enabled GC/CC; later phases have
previous collections in their history. Collected heap measures retention, not
natural settled RAM. Whole-browser resident sums can double-count shared pages.
Neither sampled RSS peak is an exact allocation peak, and process CPU totals may
omit exited processes. UI settlement timings have a 200 ms stability-observation
floor. Mostly discarded tabs with fallback icons do not model heavy websites,
extensive favicons or an everyday profile full of other extensions.

The maintained native smoke suite `test-memory-benchmark-firefox` is registered in
the release QA catalogue (unsupported platforms report inconclusive, not passed); policy/report/watchdog/retention tests run in `npm test`.
This benchmark supplements the existing navigation, drag, Find, recovery, upgrade,
container and other regression suites. It does not replace them or prove capacity,
complete browser-restart persistence, hidden-window behaviour or leak freedom.

Historical validation: [18 October report](performance/2026-10-18-iteration-harness-validation.md).

## Exceptional stress testing

Use these commands only when investigating a specific high-capacity question or
when explicitly doing the broader stress/release checks. Routine optimisation uses
the iteration benchmark above. The low-level legacy scripts also require `--stress`
so directly invoking an old command cannot silently start 60,000 tabs.

```sh
# Synthetic capacity fixture: 60,000 tabs, 28 windows, two readers per window.
npm run benchmark:memory:stress

# Older extended native harness: starts at 100 tabs, never at 60,000.
npm run benchmark:memory:firefox:stress
npm run benchmark:memory:firefox:stress -- --tabs 1000 --windows 2
```

The legacy commands accept `--source-root PATH --baseline-root PATH --pairs 5` and
`--variation-baseline PATH`. Their different workload and debugger observer need
their own A/A evidence; never mix them with iteration results. Native capacity work
ramps through 100 / 1,000 / 5,000 / 10,000 before any larger run, stopping when a
guard fires. It retains the existing **4 GiB**, normal-pressure/30%-free preflight,
20%-free sustained stop, 60-second no-progress, ten-minute stage and thirty-minute
run limits. Larger runs are not evidence that Firefox supports 60,000 tabs. Keep
experiments under `output/scratch/optim/` and measurements under
`test-results/memory/`; record resource-limited stages as inconclusive.

`npm run test:stress` exercises 100, 500 and 1,000 real Firefox tabs, including search,
nested branches, live page updates, containers, folder closure and extension reload.
It records diagnostic timings in `test-results/firefox-stress.json`; timings are not
machine-dependent pass thresholds. Most tabs stay unloaded, with up to 20 local pages
generating title updates.

The command launches and cleans up its own headless Firefox process, temporary profile
and app-data directory. Your normal Firefox can stay open. `FIREFOX_BINARY` and
`GECKODRIVER_BINARY` override the installed binaries; GeckoDriver downloads on the first
run when needed. Set `FIREFOX_STRESS_SIZES=100,500,2000` to change the workload.

## Source layouts and diagnostic instrumentation

The current harness resolves tree indexing from `extension/src/tree/index.js` and row
instrumentation from `extension/src/sidebar/rows.js`. Frozen historical sources can still use
`extension/src/tree-index.js` and `extension/src/sidebar.js`. Resolution never rewrites the
source under comparison. Missing layouts and absent/ambiguous instrumentation anchors fail
explicitly instead of reporting uninstrumented measurements. Diagnostic variants modify only
frozen copies; ordinary optimisation runs do not inject row probes.

Shared resolution/instrumentation helpers are included in the iteration and affected native
harness fingerprints. Changing them invalidates previous A/A calibration. The viewport profiler
also fingerprints its diagnostic/variant code, and its reports identify the instrumented source.
