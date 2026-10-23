# TanStack buffered ranges and lazy measurements: 19 October 2026

The selected change retains buffered range updates, lazy measurement access and an empty-folder
search fallback on `optim-tanstack`. It is retained for meaningful, repeatable reductions in
counted work, **not a demonstrated CPU or RAM improvement**. The current TanStack baseline is
`a361fca`; the comparison branch is `optim` at `b773d42`. The selected executable fingerprint is
`77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`. No new production library,
vendor bytes, build pipeline, permissions or storage format changes are involved. The remaining
experimental variants are not enabled.

`viewport-range.js` starts with 12 overscan rows on each side. It refills when fewer than six
spare rows remain at the moving edge, leaving up to 18 ahead and six behind. The normal total
overscan budget stays at 24 rows, plus ancestors and existing interaction/width owners. Stable
buffered ranges reuse their index array and avoid repeated draw/reconciliation batches.
Geometry, viewport-height, fallback and suspension changes reset the buffer; owner changes still
refresh it. `draw()` reads offsets only for mounted entries and required ancestor endpoints. The
complete logical projection and geometry are still built; lazy measurement objects accumulate as
rows are visited rather than remaining permanently capped.

Matching expanded folders with no visible children have an intrinsic-height drop placeholder
absent from the fixed-height projection. Such searches now use the full renderer, alongside
Domain views and Saved-result searches. Clearing search returns safely to viewport rows when
eligible. Tabernacle search still covers the complete logical tree; native Firefox Find remains
outside the requirements. Existing row identities, nested layout and interaction ownership are
preserved.

### Targeted scrolling and memory-lifetime benchmark

This supplements `npm run benchmark:optim`; it does not replace the standard workload or
functional suites. Use Node 24 and fresh output directories:

```sh
# Three alternating pairs: HEAD versus the frozen working tree.
node scripts/benchmarks/viewport/scroll-runner.mjs
# Five A/A pairs, or five comparison pairs (calibrates first if needed).
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline a361fca --calibrate
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline a361fca --confirm
# Explicit baseline, or one candidate diagnostic without a comparison.
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline optim
node scripts/benchmarks/viewport/scroll-runner.mjs --pilot
```

`--candidate REF` selects committed source; the default or `--working-tree` freezes the working
tree. `--noise REPORT_JSON` supplies matching calibration; `--output DIRECTORY` selects new
evidence storage. Defaults are under `test-results/memory/viewport-scroll/`. Reports retain
sources, fingerprints, individual samples, frame intervals, guard observations and correctness
results.

Each fresh Firefox profile has 1,000 discarded fixture tabs and one real sidebar. Slow scrolling
advances 24 pixels per animation frame for 240 steps each way; viewport-sized jumps traverse the
full tree six times. Memory is sampled before installation, after initial idle, after each
workload, after 10 seconds following the slow-scroll memory report, at 10/30 seconds from
full-traversal completion, and after final explicit GC/CC. Complete ID/title/order verification
runs last. No profiler, production instrumentation, retries or workload escalation is used; the
normal resource guard and 30-minute batch limit apply.

CPU excludes memory reporting and final correctness traversal, but includes the common frame
tail and invocation overhead. Whole-browser CPU excludes processes absent from either snapshot.
Frame intervals include scheduling, not exact paint or input latency. Reporting can affect
collection timing. RSS includes Firefox's extension runtime and the control extension; it is not
marginal Tabernacle RAM. Footprint and RSS are different measures, not additive. Peaks are
one-second samples; DOM/style/image/orphan categories are partial. Missing optional values are
unavailable, not zero. Timing/RAM acceptance still requires five-pair A/A and confirmation, >10%
reduction, >3× the full A/A range and agreement in every pair.

### Completed comparison and counted-work results

The targeted five-pair confirmation and matching five-pair A/A completed. No required timing or
memory metric cleared the project acceptance gate. No metric received a qualifying regression
flag either; that is not proof of equivalence. Representative medians [full observed ranges]
follow; MB is decimal:

| Metric                      |                    `a361fca` |                     Selected | Change |
| --------------------------- | ---------------------------: | ---------------------------: | -----: |
| Slow-scroll extension CPU   | 2,070.9 [1,975.5–2,200.7] ms | 1,167.7 [1,087.1–1,261.2] ms | -43.6% |
| Jump extension CPU          | 1,433.9 [1,319.7–1,496.3] ms | 1,496.3 [1,375.7–1,510.0] ms |  +4.4% |
| Slow-scroll frame p95       |                19 [19–19] ms |                19 [18–19] ms |     0% |
| RSS immediately after jumps |    305.71 [303.07–307.89] MB |    299.97 [298.11–301.33] MB |  -1.9% |
| RSS after 30 seconds idle   |    256.51 [256.28–259.33] MB |    257.72 [255.64–258.20] MB |  +0.5% |
| Final collected heap        |    15.654 [15.635–15.660] MB |    15.716 [15.702–15.720] MB |  +0.4% |
| Sampled extension RSS peak  |    306.76 [304.01–308.90] MB |    301.12 [298.78–302.28] MB |  -1.8% |

Slow CPU fell in every pair, but its 903.2 ms median reduction missed the 1,160.0 ms noise
threshold (3×386.7 ms A/A range). Whole-browser slow CPU fell 17.4%; whole-browser jump CPU rose
4.3% in every pair, also below the gate. Two candidate slow runs each had two frames over
33 ms: pair 3 had 49/67 ms, and pair 5 had 78/45 ms; all five comparison baseline runs had
none. The same-source A/A runs also had spikes, reaching 94 ms. These observations do not
establish a new timing regression under the calibrated gate. The transient orphan-DOM
backlog remained about 17 MB after jumps/10-second idle and about 0.33 MB after 30 seconds.

A separate instrumented diagnostic repeated each version three times. Every reported operation
count repeated exactly; all six runs checked 480 scroll steps, 1,001 authoritative tab
IDs/titles/order and 1,002 logical geometry rows:

| Counted operation              | Baseline | Selected | Change |
| ------------------------------ | -------: | -------: | -----: |
| Initial measurement objects    |    1,002 |       34 | -96.6% |
| Scrolling draw batches         |      384 |       30 | -92.2% |
| Scrolling reconciliation calls |    1,140 |      438 | -61.6% |
| Scrolling tab builds           |      276 |      283 |  +2.5% |
| Scrolling wrapper builds       |      372 |      378 |  +1.6% |

Both versions mounted at most 46 rows against the same 47-row bound, with identical 30,072-pixel
extent. Range extractions/draw attempts were unchanged. The candidate materialised another 195
measurements during scrolling: initial plus bounded-scroll creation was 229 versus 1,002; full
traversal can materialise the remainder. Geometry still scans all 1,002 logical rows initially.
Reconciliation child-reference counts fell 90.3%, but these are submitted references, not actual
DOM mutations. This diagnostic synchronises explicit offsets through the existing refresh API;
its work counts do not convert to CPU/RAM percentages or rescue the timing gate.

An earlier three-pair standard screen against `a361fca` recorded view-cycle CPU 4,813.8→4,645.3
ms (-3.5%), idle RSS 338.95→340.79 MB (+0.5%) and sampled peak 603.08→605.39 MB (+0.4%). It was
uncalibrated and preceded the empty-folder fix; its candidate fingerprint was
`fa5700c4056b4753f8d41e505b9d9b6994655c335ecfa6cf99dc96ce682534cf`. It must not be presented as
a paired standard comparison of the final source.

### Additional trials

All following variants are rejected or deferred, with sources/patches preserved. Except the
stated cache screen, native figures are single unpaired pilots compared with earlier buffered
screen medians; they are not acceptance evidence. MB is decimal.

| Trial                           | Evidence and remaining limitation                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Evicted-subtree teardown        | Relevant UI checks passed. Slow/jump CPU 1,332/1,491 ms; 30-second RSS 259.05 MB. Lower orphan reporting did not deliver corresponding resident-memory savings.                                                                                                                                                    |
| Complete leaf-row reuse         | Dedicated ownership/shape/motion checks passed; UI row builds fell 1,029→51. Pilot slow/jump CPU 1,291/1,346 ms; 30-second RSS 281.12 MB. Lower construction did not establish an overall win; collection timing changed.                                                                                          |
| Positioned nested layout        | Removed flow/spacer dependencies while keeping nested wrappers. A 6-pixel root-gap defect was corrected in scratch. Sibling fold motion still jumps; pilot slow/jump CPU 1,402/1,811 ms. Rejected for regression and no encouraging overall result.                                                                |
| Positioned layout plus reuse    | Passed preceding geometry checks after the gap fix, then failed sibling motion (0 pixels versus 1,115.83 required). Pilot slow/jump CPU 1,243/1,720 ms; 30-second RSS 267.85 MB. Not qualified.                                                                                                                    |
| Stable TanStack key callback    | Still rebuilt `treeLayout`. The three-pair screen of buffered/lazy plus cache reuse versus `a361fca` gave folder CPU -1.5%, view CPU -3.9% and peak RSS +0.1%; uncalibrated and not an isolated cache-versus-buffered comparison. No significant additional benefit established; removed.                          |
| Full geometry-object reuse      | Guarded topology/dimensions, reused entries/maps, refreshed row references and independently invalidated presentation. UI passed. Standard pilot folder/view CPU 4,543/4,617 ms; peak RSS 574.69 MB. No sufficient evidence to justify the extra checks/state; removed. Ordinary metadata already bypasses layout. |
| True flat sibling list, no pool | Separate from positioned nesting: removes wrappers/branches and keeps existing keyed builders. Pilot slow/jump CPU 1,163.7/1,285.9 ms; post-jump/30-second RSS 287.47/250.00 MB, peak 288.11 MB. Possible jump-cost upside remains unrefuted, but required rendering/interaction work is missing. Not retained.    |

The true-flat candidate's cached new-tab fallback positioning was repaired. The maintained UI
suite passed geometry, slow scrolling, resize and reorder checks before failing pixel parity
because rails are absent. A limited Chromium smoke passed 1,000-ID traversal, focus/title
updates, search and fallback transitions. It does not qualify branch animation, drag insertion
markers, hierarchy/accessibility or reordered-owner attachment. Those costs are absent from the
pilot: this is a structural diagnostic, not a feature-equivalent production speed/RAM result.

FAST/lit were separate isolated content-page experiments with a shared pool and protected
focused control. Three rotated rounds gave plain/FAST/lit median content CPU 1,585/1,667/1,661
ms, step p95 4/5/5 ms and 10-second RSS 200.11/205.69/202.69 MiB. All fixture checks passed; no
A/A calibration was run. Both libraries had higher RSS at every stage in every pair. FAST 3.1.2 loaded
119,776 readable bytes/26 modules; lit-html 3.3.3 loaded 64,198 bytes/one development module. The
common pool/ownership code remains, fixed-slot DOM order is not production qualified, and
shorter adapters do not establish lower maintenance. Neither warrants migration for CPU/RAM; no
extra production dependency was added.

### Evidence and final validation

Native reports are under `test-results/memory/tanstack-buffered-2026-10-19/`: `scroll-confirm/`
(including `calibration/`), `standard-screen/`, cache screens and individual `*-pilot/`
directories. Scratch source, patches and limited smoke records remain under
`output/scratch/tanstack-buffered-2026-10-19/`, including `work-count-results/report.json`,
`final-targeted-summary.{json,txt}` and `renderers/libraries-summary.{json,txt}`. Reports retain
every sample and source/harness identity; the targeted harness was
`0a839cc6e9966d26b8ef662fa6c75955e7b3a414e4f0576c50c16959561ed639`.

### Standard comparison against optim

The three alternating standard pairs in `vs-optim/report.json` completed with 1,000 native tabs
across two sidebars and the usual 100/1,000/10,000-tab synthetic cases. The baseline was `optim`
at `b773d42be64bb069779e4b8e85a96c86c05b07b5`, source fingerprint
`a0ce133d0ae6536489aa3777f820d0181f1e852776a6100fa3bd99ba3ab133e5`. The frozen candidate was the
selected source `77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`, including its
uncommitted extension changes. It is not identified by the checkout's `a361fca` commit alone.
No matching A/A calibration applied: all timing/memory differences below are **uncalibrated**.
These fixed five headlines show medians [full ranges], with decimal MB:

| Metric                             |                           optim |                        Selected |  Change |
| ---------------------------------- | ------------------------------: | ------------------------------: | ------: |
| Idle extension-process RSS         |       307.72 [307.59–308.30] MB |       335.99 [334.53–339.77] MB |   +9.2% |
| Sampled extension-process RSS peak |       429.77 [422.61–432.44] MB |       585.30 [545.08–600.57] MB |  +36.2% |
| Warm tab-data reply p95            |                      2 [2–2] ms |                      2 [1–2] ms |      0% |
| Folder-action elapsed time         | 13,991.8 [13,973.8–14,140.1] ms | 13,995.3 [13,941.3–14,061.1] ms | +0.025% |
| Folder-action extension CPU        |    4,203.8 [4,194.3–4,216.7] ms |    4,424.4 [4,266.1–4,600.0] ms |   +5.2% |

Idle RSS, peak RSS and folder CPU were higher in all three pairs. Folder elapsed time changed
direction; reply p95 was equal in two pairs and lower in one. The report lists **0 Firefox and
0 synthetic regression-review flags**, but without calibration this is not evidence of no
regressions or a demonstrated overall improvement. Fixture correctness passed for both sources.

Idle DOM counts were 6,440→738 (-88.5%) in every pair. Added collected idle heap was
18.675 [18.657–18.748]→10.669 [10.668–10.685] MB (-42.9%), lower in every pair. This subtracts the
same-profile disabled baseline after collection; it is not ordinary resident memory. View-cycle
extension CPU was 4,086.5 [4,075.5–4,155.9]→4,521.3 [4,214.9–4,541.9] ms (+10.6%), higher in every
pair. Smaller DOM/retained heap coexist with an unresolved resident-memory/CPU premium over
optim in this workload. These paired observations use only this batch, not earlier candidates.

### Targeted scrolling comparison against optim

The separate `scroll-vs-optim/report.json` completed three alternating pairs on the one-sidebar
fixture. It used the exact baseline/candidate fingerprints recorded above (`a0ce133d…` and
`77579a0f…`) and targeted harness `0a839cc6…`. All six guarded runs and complete native
ID/title/order checks passed. There is **no matching optim A/A calibration**; the calibration
against `a361fca` cannot qualify this different baseline. Medians [full ranges] are descriptive:

| Metric                      |                        optim |                     Selected | Change |
| --------------------------- | ---------------------------: | ---------------------------: | -----: |
| Slow-scroll extension CPU   | 1,472.4 [1,286.2–1,487.3] ms |     995.8 [963.8–1,106.2] ms | -32.4% |
| Jump extension CPU          |   1,018.6 [823.9–1,038.6] ms | 1,366.8 [1,328.2–1,396.5] ms | +34.2% |
| RSS immediately after jumps |    259.42 [249.94–264.27] MB |    297.65 [283.25–298.27] MB | +14.7% |
| RSS after 10 seconds idle   |    258.15 [248.66–263.31] MB |    278.77 [273.12–296.78] MB |  +8.0% |
| RSS after 30 seconds idle   |    245.84 [239.39–247.22] MB |    243.71 [234.80–255.62] MB |  -0.9% |
| Final collected RSS         |    238.93 [238.31–244.86] MB |    241.55 [234.44–251.13] MB |  +1.1% |
| Final collected heap        |    23.507 [23.221–23.513] MB |    15.681 [15.121–15.682] MB | -33.3% |
| Sampled extension RSS peak  |    293.04 [291.36–295.85] MB |    297.09 [295.47–300.73] MB |  +1.4% |

Slow extension CPU was lower and jump extension CPU higher in all three pairs. Whole-browser
slow/jump CPU medians were 5,524.8→4,403.7 ms (-20.3%) and 4,192.8→4,609.2 ms (+9.9%), with the
same respective direction in every pair. RSS after jumps/10-second idle was higher in every
pair; 30-second RSS and final collected RSS changed direction. Collected heap was lower in
every pair; the peak-RSS direction was higher/higher/lower.

Slow-frame p95 was 18 [17–18]→18 [18–19] ms; jump p95 was 18 [18–18] ms for both.
In pair order, slow maximum frames were
19/19/23→25/52/121 ms and counts over 33 ms were 0/0/0→0/2/5. Jump maxima were
18/18/29→82/20/19 ms, with counts over 33 ms 0/0/0→2/0/0. This does not establish a
responsiveness gain; the adverse outliers remain visible rather than being averaged away.

Before-install RSS already differed: 226.46→237.21 MB, higher for all candidate profiles, so
absolute resident differences cannot be exclusively attributed to installed candidate code.
Optional physical footprint after jumps was 94.41→121.69 MB; at 30 seconds it was
76.19→76.06 MB with mixed directions. The optional orphan-DOM reporter was about 0.037 MB for
optim versus 17.14 MB after candidate jumps/10-second idle, returning to 0.333 MB after
30 seconds. These reporters are descriptive and reporting can influence collection timing.
The lower retained heap and promising slow CPU do not establish an overall improvement over
optim: jump CPU, transient retention and occasional long frames remain concerns.
Full individual values and pair directions are preserved in
`output/scratch/tanstack-buffered-2026-10-19/scroll-vs-optim-summary.{json,txt}`. This comparison
is separate from both the two-sidebar standard screen and the calibrated TanStack comparison.

### Final functional validation

`npm run check` passed (622 unit tests), and all 40 registered UI suites passed on the selected
production source. An additional owner-only regression was then added: mounting successive
offscreen rows at the same scroll offset must update retained rows and ancestors while releasing
the previous temporary owner. The complete viewport suite passed again with that assertion.
Coverage includes offscreen search and metadata, empty-folder search placeholders, slow scrolls,
reversals, jumps, native resize observation, same-count reorder, list shrinkage, focused/pressed
controls, menu owners, nested geometry, pixel parity, horizontal extent and sibling fold motion.

Native Firefox drag and tab-close suites passed in isolated profiles. The additional
`test-memory-benchmark-firefox` smoke exited 2 before launching its native worker because macOS
memory pressure was not normal. It is **inconclusive**, not passed; no automatic retry, limit
increase or user-app closure was attempted. Its report is
`test-results/memory/iteration/run-KqOy1j/report.json`. The earlier completed comparison batches
and their fixture correctness checks remain distinct evidence for the same selected source.

Final logs are in `output/scratch/tanstack-buffered-2026-10-19/`:
`check-final.log`, `ui-final.log`, `viewport-owner-final.log` and `native-final.log`.
Optional prototypes have only the limited checks described above. No release, upgrade, manual
screen-reader, touch, full-native-suite or exceptional-capacity qualification is claimed.
