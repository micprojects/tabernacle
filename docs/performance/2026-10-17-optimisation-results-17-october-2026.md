# Optimisation results: 17 October 2026

The `optim` programme starts at `9aabf41`. The final production commit is `9b2bcbc`;
its 111-file extension fingerprint is
`091427df671e32eb8611588b36c52bad9d6d8cac9aec61387bcd8f78d781e0b6`.
The opening branch fingerprint is
`2ae1a37d49a66ab7d3082b0fb672f40f84e0b89843cb351c3a36f0ec82ade9d1`;
the separately extracted published `v0.2.0` (`7058ca6`) fingerprint is
`1987f5d8d1771564aeb2eee6af2819d00de209095329759360d63650c722c3d1`.
The version, add-on identity, permissions, storage keys and saved formats are
unchanged. These are local development results, not a capacity or release promise.
These raw-export fingerprints include the ignored `extension/.DS_Store` present
in the frozen local sources; a clean Git checkout need not reproduce the same
raw-directory hash. The file remains untracked and is not a shipped asset.

Measurements used Node 24.19.0, Firefox 158, an eight-core Apple M1 with 16 GiB RAM
and Darwin 27.0.0. Synthetic fixtures use seed 17. Reports record exact source,
fixture, runtime, machine and harness fingerprints. Five fresh alternating pairs
follow five fresh matching A/A pairs. Review thresholds remain both 10% and three
times the matching baseline range; an absence of flags does not mean zero cost.

### Synthetic results

The final matrix passed 17 scenarios spanning 100, 1,000, 5,000, 10,000 and 60,000
tabs; 1/2/8/9/28 windows or readers; multiple readers per window; flat, realistic,
deep-tab and deep-folder shapes; pins, containers and Saved for Later. Hard
assertions cover complete collection sets, durable model/membership preservation,
32 concurrent membership reads, zero warm reads, bounded transfer retention,
restart fallback and empty owned caches after disposal. Separate unit and browser
suites cover exact hierarchy/order, repair, recovery, concurrent events, rejected
operations and upgrade behaviour.

The five sizes each have a completed A/A and opening-branch comparison. A separate
1,000-tab published-tag A/A/comparison brings the total to 120 fresh measurement
workers, plus 17 matrix workers. No final opening-branch comparison from 1,000
through 60,000 tabs crossed both review thresholds. All individual samples,
ranges and flags remain in
`test-results/memory/final-synthetic-2026-10-17T16-51-56.817Z-ZqgOZ4/`.
Its `compact-results.json` contains every phase, and `summary.json` preserves
source/harness identities and guards. This directory and other raw reports are
local ignored evidence, not files distributed with the extension.

At 60,000 tabs across 28 windows, with two readers per window, median timings and
five-sample ranges were:

| Phase              | Opening branch, ms [min, max] | Final candidate, ms [min, max] |
| ------------------ | ----------------------------: | -----------------------------: |
| Initial readers    | 2,042.23 [2,029.46, 2,216.53] |  1,701.49 [1,688.82, 1,739.07] |
| Unchanged readers  |       772.73 [747.91, 803.44] |           49.28 [47.29, 53.01] |
| Metadata burst     |       799.36 [786.49, 814.02] |           54.46 [53.92, 63.83] |
| Create/close burst | 1,523.67 [1,505.62, 1,578.81] |      889.78 [830.43, 1,204.30] |
| Reopened readers   |       756.76 [751.81, 796.15] |        796.06 [775.96, 841.69] |
| Background restart | 1,928.72 [1,913.49, 1,949.48] |  1,733.70 [1,688.13, 1,756.01] |

These timings include fixture validation, JSON byte estimation and simulated
`structuredClone` messaging. They do not measure Firefox IPC or DOM rendering.
Peak concurrent membership reads fell from 60,000 to 32. All 56 unchanged second
replies were deltas, reducing estimated JSON bytes from 84,721,365 to 101,234 in
every pair. The matrix retained 56 bases/120,000 references, then 112/240,000 after
reader resets, within the unchanged 128/250,000 limits.

Whole-process retained Node heap after requested GC increased at this size:
initial readers 312.37 [312.29, 312.94] to 324.69 [324.64, 324.77] MiB (+3.94%);
closed readers 199.40 [199.33, 199.97] to 215.79 [215.75, 215.88] MiB (+8.22%).
Sharing resolved records removed roughly 18 MB from the preceding candidate and
resolved its three cumulative heap flags, but does not establish lower retained
heap than the opening branch. The cold-phase sampled maximum also increased,
434.14 [428.15, 442.04] to 450.21 [447.12, 450.37] MiB (+3.70%). The all-phase
sampled maximum fell from 962.57 [909.10, 962.66] to 649.19 [648.89, 649.71] MiB
(−32.56%). That last result is neither a startup reduction nor an exact peak.
`final-counters-and-peaks.json` preserves the separate measurements.

The initial 100-tab cold comparison flagged 5.1113 to 6.2936 ms (+23.13%) against
the A/A range of 0.349124 ms. Exactly five additional pairs using that same A/A
gave 5.5462 to 5.8623 ms (+5.70%), below both thresholds. All ten comparison pairs
and the original A/A remain in `cold-100-repeatability.json`; no outliers were
removed or replacement noise estimate used. The beyond-noise regression did not
consistently repeat. Small-session cold-start timing remains inconclusive, with
no claimed improvement.

Seven retained-heap flags remain in the published-tag comparison. Historical
attribution in `release-attribution.json` shows that most of the increase predates
this programme: at 1,000 tabs, cold retained heap is 9.13 MB for the published tag,
12.17 MB for the opening branch and 11.84 MB for the candidate. Closed-reader heap
is 9.51/10.64/10.76 MB respectively. This triangulates separate paired runs, not a
fresh direct published-to-opening measurement. The release flags are preserved;
the programme does not claim lower retained heap than the published extension.

### Native memory results at programme completion

Five A/A pairs and five alternating opening-branch/candidate pairs completed in
Firefox 158 at 100 fixture tabs across two actual sidebar windows (102 native tabs
including control tabs). The settlement harness fingerprint was
`25a744fba5589f3addf3bf7d3fa9b5ecfa07be2d27c0553da123039b8219bc37`.
All 260 recorded phases passed, including authoritative tab IDs, row order, titles
and pins, search, title bursts, visible unfocused and minimised windows, closing and
reopening sidebars, and membership preservation after extension reload. None of
the original elapsed/collected-resident metrics crossed both review thresholds;
no total Firefox resident-memory improvement was demonstrated. The follow-up below
also examines process heap and pre-collection costs in these preserved reports.

Selected collected Firefox resident sums, in decimal MB, were:

| Phase             | Opening branch median [min, max] | Final candidate median [min, max] | A/A range |
| ----------------- | -------------------------------: | --------------------------------: | --------: |
| Warm snapshots    |    1,532.43 [1,530.28, 1,534.49] |     1,534.28 [1,533.72, 1,582.50] |     90.06 |
| Live title burst  |    2,377.30 [2,340.65, 2,379.79] |     2,377.24 [2,343.50, 2,379.33] |    117.51 |
| Sidebars closed   |    1,546.45 [1,511.74, 1,551.07] |     1,546.50 [1,511.21, 1,549.89] |    119.78 |
| Sidebars reopened |    1,562.08 [1,522.19, 1,610.29] |     1,560.72 [1,525.47, 1,561.95] |    117.70 |

These sums cover isolated Firefox processes, not just extension ownership.
Maximum watchdog-owned process RSS across the completed runs was 3,140,780,032
bytes; minimum pressure-free memory was 46%. DevTools attachment also affects
natural background sleeping. All phase durations, resident samples, ranges,
original A/A variation and guard records are retained under
`test-results/memory/final-native-v2-nZDx0S/`; `compact-results.json` indexes them.

The 1,000-tab/two-window pilot stopped at DevTools connection during launch after
63.224 seconds, with 60 seconds without reported progress. It created **zero**
fixture tabs and produced no measurement phases. Peak owned RSS was 2,164,031,488
bytes and pressure-free memory 48%, so the 4 GiB cap was not responsible. The ramp
stopped without retry or changed limits. At programme completion, native memory at
1,000/5,000/10,000 and larger sizes remained unmeasured; this startup stall
establishes no tab capacity limit. Earlier startup stalls and partial reports remain
inconclusive. The separately requested follow-up resumed testing as described below.

### Native memory follow-up, 17 October 2026

**There is a repeatable reduction in retained extension-process heap after closing
sidebars and forcing collection, but no demonstrated reduction in total Firefox
resident memory.** The fresh 1,000-tab/two-window comparison completed. The next
5,000-tab/eight-window pilot reached the unchanged 4 GiB guard, stopping the ramp.
The extension source remains `091427df…`; this follow-up changed only test logging
and documentation.

Commit `8ee17dd` splits the existing `CommandsFactory.forAddon` and
`targetCommand.startListening` awaits with a completed-stage log. Inspection of the
installed Firefox 158 sources traced the first wait through local client creation,
the add-on descriptor, a hidden fallback browser and its navigation; the second
wait covers target/resource listeners. The old logs cannot identify which wait
stalled. The fallback listener is installed before navigation, so inspection did
not demonstrate a listener-after-navigation race. No root cause or fix is claimed.
All 32 fresh follow-up launches connected: ten launch-only probes, one 1,000-tab
pilot, twenty paired workers and the later resource-limited 5,000-tab pilot. No
retries, polling heartbeats, longer timeouts or replacement DevTools target were
introduced. A future recurrence can now distinguish the two waits. Source excerpts,
module hashes and a deeper diagnostic field map are retained under
`output/scratch/optim/devtools-startup/`.

The extra WebDriver round trip changes the harness fingerprint to
`c1c739cd66493949a798875cddb6f176d313b5faa6b60902c136acab99187e86`, so the 1,000-tab
comparison uses fresh five-pair A/A variation and five alternating
opening-branch/candidate pairs. All twenty workers completed all thirteen phases;
native IDs, titles, pin and row order, visibility, search, close/reopen and reload
checks passed. Maximum watchdog-owned RSS was 3,424,387,072 bytes (3.19 GiB), and
minimum pressure-free memory was 45%. Runtime, machine and fixture were Firefox
158.0, Node 24.19.0, Apple M1/eight cores/16 GiB, Darwin 27 and seed 17. The baseline
was the opening branch `9aabf41`, not the published tag.

Selected results use decimal MB and medians [minimum, maximum]. A/A variation is
the full observed range for the same phase, collection state and metric:

| Phase and metric                                          |                   Opening branch |                        Candidate | A/A range | Interpretation                                                   |
| --------------------------------------------------------- | -------------------------------: | -------------------------------: | --------: | ---------------------------------------------------------------- |
| Warm, collected total Firefox resident                    | 1,735.295 [1,705.181, 1,763.017] | 1,734.836 [1,704.002, 1,753.121] |    76.399 | No demonstrated improvement                                      |
| Warm, collected extension-process heap                    |       107.064 [106.829, 107.532] |       105.995 [105.777, 106.097] |     0.994 | Difference below 3× A/A range                                    |
| Closed, before current collection, extension-process heap |          50.570 [50.443, 50.619] |          54.371 [54.186, 54.786] |     0.457 | **+3.800 MB (+7.51%); higher in all five pairs**                 |
| Closed, collected extension-process heap                  |          32.464 [32.331, 32.510] |          18.451 [18.304, 18.525] |     0.524 | **−14.013 MB (−43.16%); lower in all five pairs, beyond 3× A/A** |
| Closed, collected partial DOM/style reporters             |          10.703 [10.703, 10.703] |             0.595 [0.595, 0.595] |     0.000 | −10.107 MB (−94.44%); lower in all five pairs                    |
| Closed, collected total Firefox resident                  | 1,645.937 [1,563.263, 1,686.209] | 1,636.696 [1,541.423, 1,664.418] |   122.716 | No demonstrated improvement                                      |

No new 1,000-tab metric crossed both regression thresholds (>10% and >3× A/A),
but the pre-collection heap cost is real and must not be hidden by that threshold.
Retrospective analysis of the preserved 100-tab reports found the same approximate
absolute cost: closed-sidebar pre-collection heap increased 20.151 → 24.005 MB
(+19.12%, A/A 0.463 MB); reported explicit categories increased 29.753 → 34.013 MB
(+14.32%, A/A 0.293 MB). Both cross the thresholds at that size and remain recorded.
This analysis does not establish their allocation source or resolve those flags.

The 5,000-tab/eight-window pilot connected DevTools in its 2.557-second launch and
created all 5,000 discarded fixture tabs. It stopped during membership seeding,
before populated-sidebar settlement or memory comparison, after 106.383 seconds.
The first over-limit sample was 4,373,463,040 bytes (4.07 GiB); minimum pressure-free
memory remained 42%. The one-second watchdog sampling explains the small cap
overshoot. Its teardown connection error followed the guard termination, not a
startup stall. The owned processes were cleaned up. This is a **resource-limited,
inconclusive run**, not a comparison or correctness failure. No further 5,000-tab
pairs or 10,000/20,000/40,000/60,000-tab native runs were attempted after that stop.

All reports, individual samples and the separately audited process summary are in
`test-results/memory/devtools-startup/`; `report.md` provides the evidence index.
The frozen offline analysis script SHA-256 is
`9cd108964f629eae3be28479aa8fa99878ba3bd331d2fd3120bc1b7ba32ca35f`.
It checks exact source/harness/runtime/fixture matches and one-to-one process PID
coverage before summing resident reporters. Partial DOM/style categories and heap
overlap; do not add them. Extension-process measurements include Firefox/DevTools
overhead and all extension documents, not exclusively Tabernacle-owned bytes.
Resident sums may include shared pages. Reported explicit categories omit the
computed `heap-unclassified` value and are not complete about:memory explicit usage.
Before-collection means before the current phase's collection, after any earlier
phase collections; these are not untouched natural-lifetime measurements. The
headless, discarded-tab/actual-sidebar fixture and attached DevTools do not prove
natural desktop background sleeping or loaded-page memory. Whole-run sampled RSS
includes Node/geckodriver and is neither an exact peak nor a startup-only measure.

`npm run check` passed all 529 tests after the logging change; the completed native
follow-up validates the same helper. Production bytes remain those of the passing
57/57 final release QA below. No new production change or publication was made.

### Main-versus-optim decision report

The subsequent branch comparison verified every tracked extension file on local
`main` (`9aabf41`) against the frozen opening baseline: all 106 matched byte for
byte. The assessed `optim` HEAD was `be10def`, with the unchanged `091427df…`
extension fingerprint. The earlier completed paired results therefore compare
these exact branches. They are reused with their original matching A/A sets,
runtime/source hashes and samples, not presented as newly completed runs.

The illustrated report is `test-results/memory/main-vs-optim/report.html`, with
standalone PNG/SVG charts and validated samples in `decision-data.json`. At 100
tabs/two open sidebars after collection, main/optim extension-process allocated
heap is 29.64/29.68 MB and unique resident memory 73.55/75.66 MB. At 1,000 tabs the
corresponding values are 107.06/105.99 MB and 181.49/177.70 MB. These are process
footprints including Firefox/DevTools overhead, not exclusive add-on allocations;
the metrics overlap and must not be added. No completed no-extension control
establishes the exact RAM cost of installing Tabernacle.

Per-run medians of the four subsequent native snapshot replies are 1 → 1 ms at
100 tabs and 3 → 1 ms at 1,000 tabs. First full replies are 6 → 6 ms and 34 → 33 ms.
The latter differences and search-with-settlement differences are within noise.
Native timers have coarse resolution. Synthetic warm work across all readers is
roughly 11–16 times faster at 5,000–60,000 tabs, but the 100-tab saving is only
0.42 ms. These ratios are not whole-browser speedups.

The new 100-tab A/A attempt completed seven workers, then stalled in
`CommandsFactory.forAddon` on main before target listeners or fixture creation.
The unchanged no-progress guard stopped it after 63.286 seconds; peak owned RSS
was 2,187,870,208 bytes, minimum pressure-free memory 44%. This incomplete batch
is preserved and not scored. A separate diagnostic, collecting UUID-matched
explicit reporter leaves in owned synthetic profiles, completed main/100 tabs:
17.41 MB after collection with sidebars open, including 15.85 MB in sidebar paths
and 1.14 MB in background paths. This is only a reported subset. Its optim/100
launch stalled at the same boundary and stopped after 63.272 seconds with zero
fixture tabs; no paired attribution or 1,000-tab attribution result is claimed.
No guard was changed, no incomplete batch was retried, and no larger native run
was restarted. Owned browser processes were verified to have exited.

The recommendation is to retain the branch as the base for focused investigation:
large-session repeated work and closed-view cleanup are useful improvements, while
open-view RAM is not demonstrably reduced. The approximately 3.8 MB pre-collection
closure cost remains unresolved, including its 100-tab regression flag. The next
memory target should follow measured live-sidebar and JavaScript allocation
ownership. The report's good/poor assessments concern these specific goals; no
competing extension or universal memory threshold was benchmarked. The production
source and prior functional QA remain unchanged.

### View and lifecycle evidence

Adjacent-source five-pair checks measured the intended work reductions. These
counts establish reduced ownership or work, not equivalent RAM savings:

| Change                                            | Before → after                                                       | Local evidence under `test-results/memory/`                 |
| ------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Coalesced metadata                                | 4,000 array copies → 1 on the next read                              | `metadata-before-{1..5}.json`, `metadata-after-{1..5}.json` |
| Inactive tree / closed pane                       | 9 → 0 / 3 → 0 retained rows; tree restores 9                         | `ui-lifecycle-counts/report.json`                           |
| Hidden notification reads                         | 1 → 0; exactly one catch-up; visible unfocused still refreshes       | `ui-visibility-counts/report.json`                          |
| Tree / Later / Domains row interaction listeners  | 81/21/6 → 0; persistent root additions 6 → 19 remain stable          | `ui-listener-counts/report.json`                            |
| Pointer disposal                                  | Pending frame, timer and 11 listeners → 0, no late callbacks         | `pointer-disposal-counts.json`                              |
| Closed dialog captured targets                    | 60,000 → 0 callable targets                                          | `dialog-retention-current.json`                             |
| Favourite hostname lookups, 60 links / 1,000 tabs | 116,460 → 1,060 for late matches; 120,000 → 1,060 for absent matches | `icon-index/step13-final-source-five-pairs.json`            |

Per-image fallback listeners and some specialised controls remain intentionally
local. Activity/New Tab keep hidden rows when native Find or user selection needs
connected text, then clear them on page disposal. Native Find checks preserve the
existing behaviour; an existing New Tab first-Find-Again ordering limitation was
reproduced in both sources and is not claimed fixed.

The complete logical projection retained full rendering. Its compact version
passed five renderer pairs and matching A/A checks at 1,000 rows without crossing
both thresholds: cold synchronous rendering 101.2 → 103.2 ms, collected Chromium
V8 isolate heap 3,529,648 → 3,830,588 bytes (+8.53%). This is accepted overhead for
the requested separation of actions from rendering, not a memory saving. The heap
measure excludes native DOM allocation. Full results and ranges are under
`renderer-step14-compact-2026-10-17T15-55-14.234Z/`; the earlier, more expensive
projection was discarded.

Viewport rendering was rejected at its compatibility prerequisite. In an actual
Firefox sidebar with 1,000 injected logical rows, mounting only 30 rows gave zero
native Find matches for the last row; full DOM gave one. The experiment did not
create 1,000 native tabs or establish a 5,000-row memory reduction. Full rendering
remains shipped, with no user-facing mode or cap. Evidence:
`native-viewport-find-1000.json`.

Lazy/async favicon hints were also rejected. Ready offscreen icons fell from 164
to 1–8, but after-scroll readiness rose from 9 to 33 ms, exceeding both thresholds
against the matching 3 ms A/A range. Existing supplied icons and fallback behaviour
remain; only the favourite hostname index shipped. `native-favicon-final.json`
and `native-favicon-aa-retry.json` preserve the samples. Data-URL fixtures establish
no network saving.

### Final regression gate

`TABERNACLE_MEMORY_GUARD=1 npm run qa:release -- --stress` passed **57/57** checks
on the final `091427df…` source: formatting/lint and 529 unit tests, all 39 UI
suites, all 15 native Firefox suites, the native stress workload and an unsigned
build. The report is
`test-results/release-qa/2026-10-17T17-06-48.888Z/results.json` with individual
logs and guards alongside it. The source fingerprint was unchanged afterwards.
All 16 guarded native/stress suites completed, with maximum owned-process RSS
3,709,485,056 bytes and minimum pressure-free memory 44%.

The stress suite passed at 100/500/1,000 real tabs, including a depth-30 branch,
20 live update-generating pages, search, containers, close operations and extension
reload. This functional stress gate does not replace the interrupted multi-window
native memory ramp or establish a supported 60,000-tab capacity.

The final upgrade suite verified installed published-tag and candidate resources,
same-ID/same-version replacement, organisation, opaque sentinels, delayed native
restore and interrupted recovery before and after further operations/reloads.
Its report is `test-results/memory/upgrade-2026-10-17T17-09-41.360Z/results.json`.
Temporary replacement and extension reload do **not** prove persistence across a
complete Firefox restart. No version bump, signing, publication, push or merge
was performed.

### Further allocation experiments

The follow-up starts from `a8d6451` (extension source `e8d7f504…`) and excludes
experimental New Tab work. Experiments and individual samples are retained under
`output/scratch/optim/fundamentals/` and `test-results/memory/fundamentals/`.

Metadata refresh now compares the saved layout and metadata values directly.
A single changed title allocates one new comparison array, instead of two arrays
per tab: 2,000 → 1 at 1,000 tabs and 10,000 → 1 at 5,000. Saved values remain
independent of incoming object mutation; layout changes still trigger full
rendering. The registered performance UI suite checks allocation counts, unchanged
refreshes, in-place changes, focus and parity with full rendering.

Five fresh A/A pairs and five alternating baseline/candidate pairs completed in
actual Firefox sidebars at 100, 1,000 and 5,000 injected logical rows. These isolate
rendering; they do **not** represent that many real Firefox tabs. Runtime was
Firefox 158.0, Node 24.19.0, Apple M1/eight cores/16 GiB and Darwin 27. The frozen
candidate source was `3185d945…`; the diagnostic harness was `1cbf3830…`.
Median per-run average title-update times were 0.5625 → 0.5000 ms,
5.4500 → 4.9875 ms and 26.5875 → 24.7875 ms. Their corresponding A/A ranges were
0.8125, 0.4625 and 1.1500 ms. None exceeds the conservative three-range threshold;
**the acceptance evidence is fewer allocations, not a demonstrated timing or
Firefox RAM reduction**. No measured ordinary-workload metric crossed both
regression thresholds. At 5,000 rows, collected extension-process heap was
183.846 → 183.649 MB and total Firefox resident sums 1,507.312 → 1,504.723 MB,
both within noise. Raw samples, medians and ranges are in
`metadata-native-summary.json`. Peak owned RSS across these twenty workers was
2.08 GiB; minimum pressure-free memory was 43%. Safety limits were unchanged.

A separate ten-launch startup trace decomposed the existing DevTools attachment
without changing its target or raising timeouts. Those launches and the twenty
paired workers completed. The intermittent startup stall has **no demonstrated
root cause or fix**; the ignored trace captures the blocked internal boundary if
it recurs. It does not send progress heartbeats. No Firefox instrumentation ships
in the extension.

Removing all unused row-cache entries was rejected: preliminary five-pair
Chromium comparisons reduced folded heap by 2.3%/10.3% at 100/1,000 rows, but
repeated unfolding slowed 73.1%/76.7%, beyond the ordinary-use regression gate.
The existing row cache remains. These preliminary reports lack an explicit
Chromium runtime version and are not native Firefox memory evidence.

Activity enrichment now modifies the fresh records created for that call, rather
than copying them all again. It removes one additional object per item and a
second result array; it still preserves source data and opaque fields. A frozen
source/independent-return regression test accompanies the existing activity,
filtering, ordering, restoration and reload coverage.

Five fresh Firefox A/A and five A/B pairs used the actual Activity page through
ordinary WebDriver, without DevTools, for pure data projection at 100, 1,000,
5,000, 10,000 and 60,000 synthetic records. Full output hashes matched at every
size. At 60,000 records, per-run median time fell 125.5 → 117.0 ms, but the A/A
range was 9.0 ms: no timing gain beyond the conservative threshold is claimed.
No ordinary-workload regression crossed both thresholds. The frozen candidate
was `99b6c891…`; `activity-webdriver-summary.json` records all samples and ranges.
The matching Node 24 five-pair experiment showed a sampled peak heap increment of
455.46 → 250.43 MB during repeated 60,000-record projections (−45.0%; A/A range
48.85 MB), and average projection time 43.98 → 34.59 ms. This is transient **Node
allocation evidence, not Firefox resident memory**. Final record contents and
count are unchanged. The object-copy reduction is the cross-runtime acceptance
criterion; `activity-node-summary.json` preserves the Node results.

The first DevTools-based Activity A/A attempt stopped on its second launch at the
unchanged 60-second watchdog. Its captured trace confirms client and descriptor
completion; the fallback browser was connected, fully loaded at the expected URL
and no longer loading, while watcher creation remained pending. This narrows the
wait but does not establish why the location listener failed to settle. That run
remains inconclusive in `activity-firefox-aa.json`; fresh WebDriver measurements
use a different harness and do not reuse its samples.

The Recent Activity popup now selects native references before producing its
existing 50-item preview. It copies and parses URLs only for the newest eligible
tabs and closures, then merges them with folder activity using the original
ordering. Full Activity, search, saved records and action targets are unchanged.
The registered history tests compare bounded and full results across filters,
tied/invalid timestamps, privacy and opaque fields; they assert that a
1,000-tab preview copies 50 records while full history still returns all 1,000.
The existing popup UI suite covers the 50-item order, scrolling, filtering, focus
and restore actions.

Five fresh A/A and five alternating A/B pairs completed in both Node and Firefox
at 100/1,000/5,000/10,000/60,000 synthetic records. In Firefox, medians of per-run
average projection time changed as follows (20 observations per run):

| Records |    Before |    After | Change | A/A range |
| ------: | --------: | -------: | -----: | --------: |
|     100 |   0.30 ms |  0.10 ms | −66.7% |   0.45 ms |
|   1,000 |   2.15 ms |  0.40 ms | −81.4% |   0.30 ms |
|   5,000 |  11.75 ms |  1.70 ms | −85.5% |   1.10 ms |
|  10,000 |  20.80 ms |  3.25 ms | −84.4% |   2.10 ms |
|  60,000 | 157.45 ms | 22.80 ms | −85.5% |   4.40 ms |

The improvement exceeds three times the full A/A range at every size from 1,000
upwards; the 100-record result is below noise. No metric crosses the ordinary-use
regression gate. These are **data-projection times, not complete popup-opening
latency or native-tab capacity**. Exact output hashes match across all Firefox
runs. The Node comparison also shows lower sampled temporary heap increments:
4.23 → 2.51 MB at 1,000 records and 119.73 → 47.22 MB at 60,000, both beyond the
noise threshold. It does not demonstrate lower settled Firefox RAM. Reports with
individual samples, medians, ranges and source hashes are
`preview-webdriver-summary.json` and `preview-node-summary.json`.

Repeated row icons are now shared CSS mask images: the 12px close glyph and the
16px fallback globe. Their original Acorn paths, view boxes and fill/clip rules
are preserved and checked against the canonical sprite. Firefox-supplied favicons
still use the existing image and tint behaviour. Failed icons switch to the same
globe; labels, button targets, focus and full row rendering remain intact. This
removes two DOM elements per close glyph and two per fallback globe, without
virtualising text or changing native Find.

Fresh actual-sidebar measurements compare the round's starting source `e8d7f504…`
with the frozen combined candidate `099210a2…`, including the three preceding improvements.
There are five A/A pairs and five A/B pairs for each icon workload, at 100, 1,000
and 5,000 logical rows. Every row remains mounted in the expanded samples.
Collected **extension-process heap**, in decimal MB, is:

| Icon workload       |  Rows |  Before |  After | Change | A/A range |
| :------------------ | ----: | ------: | -----: | -----: | --------: |
| Missing site icons  |   100 |  19.308 | 16.993 | −12.0% |     0.040 |
| Missing site icons  | 1,000 |  49.947 | 26.520 | −46.9% |     0.123 |
| Missing site icons  | 5,000 | 183.603 | 66.798 | −63.6% |     0.317 |
| Supplied site icons |   100 |  18.322 | 17.252 |  −5.8% |     0.511 |
| Supplied site icons | 1,000 |  39.970 | 28.848 | −27.8% |     0.594 |
| Supplied site icons | 5,000 | 133.054 | 77.469 | −41.8% |     0.671 |

All reductions exceed three times A/A variation except the 100-row supplied-icon
case. At 5,000 rows, repeated unfolding improved 224 → 70 ms with missing icons
and 219.5 → 153 ms with supplied icons, both beyond variation. No ordinary metric
crossed both regression thresholds. These fixtures isolate renderer overhead:
**they do not contain 5,000 real Firefox tabs or measure complete extension memory
for such a session**. Real sessions add background/controller state, native tabs,
web pages and their images. The supplied-icon fixture shares one small image;
it is not a model of every site's decoded-image cost.

Whole-Firefox collected resident sums while expanded decreased by about 105 MB
and 51 MB respectively, but remained within the conservative noise threshold.
After folding, their decreases of 52.6 MB and 28.8 MB did exceed that threshold
(A/A ranges 10.8 MB and 8.1 MB). A 64% extension-process heap reduction must not be
reported as a 64% reduction in Firefox's total RAM. All samples, medians, ranges,
latencies and source hashes are in `rows-final-summary.json` and
`supplied-icons-summary.json`; the watchdog peak across these forty workers was
below 2.1 GiB, with pressure-free memory at least 45%.

For these one-sidebar experiments the ignored diagnostic harness targets the
actual existing sidebar by its browser ID, avoiding the unrelated DevTools
fallback document. It asserts that the target does not change and closes the
owned profile after every worker. Both workloads have fresh matching A/A data;
they do not reuse measurements from the add-on-wide attachment harness. This is
an experimental measurement harness, not a claimed fix to the general DevTools
startup stall. Real native tab integration continues to use the registered QA
suites and their existing harness.

A close-only mask prototype already reduced 5,000-row extension heap by 30.4%.
An alternative using direct inline SVG paths for close/globe reduced it by about
16%, so it was not promoted. The combined masks provide the larger saving while
retaining complete rendered collections. The viewport-rendering decision remains
unchanged: keep full rendering and native Find compatibility.

The icon change passed 533 unit tests, 13 affected UI suites and five registered
native suites before commit. Native light, dark and forced-colour comparisons
checked supplied, missing and failed icons with container tint. Controls, icon
sizes and inherited colours matched. Actual 1× and Retina 2× rendering differed
only slightly in pixel values (maximum channel difference 7/255); an artificial
2× capture of a 1× surface was also retained but is not Retina rendering. The
registered tint test now checks painted fallback pixels and forced-colour
contrast, and the existing disclosure test still clicks the fallback to fold and
unfold its parent. Visual evidence is under `native-icons-visual-1x/` and
`native-icons-visual-retina/`.

### Native ramp after the follow-up

The committed candidate `0391890` has extension source fingerprint
`81a823682681decc2fc639a4a28366ca5d3531eacd6c616464ccdea5135c45e8`.
Its differences from the paired renderer candidate `099210a2…` are formatting
and the icon attribution notice; executable behaviour and icon geometry are
unchanged. Fresh real-tab pilots use the maintained native harness and the same
memory-pressure, RSS and time limits. These are **single candidate runs**, not
paired evidence of a performance change.

The 100- and 1,000-tab fixtures, each across two windows, completed all thirteen
stages. They verify authoritative sidebar contents, search, live title updates,
visible unfocused and minimised windows, closing/reopening sidebars and extension
reload. Warm-checkpoint measurements are below; MB is decimal and GiB is binary.
Fixture sizes exclude the initial blank tab in each window.

| Fixture tabs | Collected extension heap | Extension resident-unique | Whole-Firefox resident sum | Peak owned RSS |
| -----------: | -----------------------: | ------------------------: | -------------------------: | -------------: |
|          100 |                 27.45 MB |                  73.14 MB |                1,529.14 MB |      2.915 GiB |
|        1,000 |                 83.30 MB |                 150.73 MB |                1,724.33 MB |      3.145 GiB |

The extension process includes Firefox runtime and diagnostic overhead. Its heap
is not its total RAM, and its resident memory is not a measurement of the marginal
cost of Tabernacle alone. Process resident sums can count shared pages more than
once; they must not be added to heap or OS RSS. With both sidebars closed, collected
extension heap fell to 13.84 MB and 18.38 MB respectively. Minimum pressure-free
memory remained 47% in both pilots. The raw reports are `real-100.json` and
`real-1000.json` under `test-results/memory/fundamentals/`.

The 5,000-tab/eight-window pilot created all fixture tabs, then reached the 4 GiB
RSS guard at the beginning of membership seeding. The sampled peak was 4.113 GiB
and minimum pressure-free memory 43%; the external watchdog terminated its owned
processes. This remains **inconclusive**, with no settled 5,000-tab sample and no
10,000–60,000 native runs. No cap was raised, and this workload was not retried. The
renderer improvement has not demonstrated that the larger native fixture fits
this machine's safety budget. Evidence is preserved in `real-5000.json`.

Temporary-extension replacement and extension reload still do not establish
persistence through a complete Firefox restart.

The first final release-QA run, `2026-10-17T23-36-45.561Z`, passed 56 of 57 checks.
`test-later-firefox` stopped at the 60-second watchdog while attaching DevTools,
before its test assertions. Pressure remained normal (at least 46% pressure-free),
and peak owned RSS was 2.04 GiB. This check is retained as inconclusive, not passed.
The unchanged Saved for Later assertions subsequently passed in a single run with
the ignored startup trace: save, child promotion, containers, search, sidebar
reload, return and close. That diagnostic is recorded in `later-traced.json`;
it does not establish a root cause or general fix for the intermittent attachment
stall. The registered harness and safety limits remain unchanged.

The final registered confirmation, `2026-10-17T23-47-32.138Z`, passed **57/57**
checks with `TABERNACLE_MEMORY_GUARD=1 npm run qa:release -- --stress`: formatting,
lint, all 533 unit tests, 39 UI suites, 15 native suites, stress and build. The
report is `test-results/release-qa/2026-10-17T23-47-32.138Z/results.json`, tied to
the extension source fingerprint above. Native QA peak owned RSS was 3.757 GiB;
minimum pressure-free memory was 45%. Published-version upgrade and recovery
checks passed within the documented reload boundary. The earlier inconclusive
run remains available alongside this successful confirmation. No version,
identity, permissions or stored formats changed, and nothing was pushed, signed
or published.
