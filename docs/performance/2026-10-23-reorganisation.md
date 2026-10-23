# Behaviour-preserving reorganisation: 23 October 2026

The reorganisation passed the complete functional gate, equivalent visual fixtures,
three screening pairs and five confirmation pairs with fresh five-pair A/A calibration.
No functional, visual or calibrated performance regression was detected in the exercised
workloads. No timing or memory improvement was demonstrated either.

## Scope and provenance

Implementation started from a clean working tree at
`e0b370d94318fe90d2e6e6654c81e9773a67536a`. That exact commit remained the benchmark
baseline throughout. The candidate was the frozen working tree, not committed HEAD.
No commit, version bump, signing or publication was performed.

The [current architecture](../architecture.md#module-ownership) documents the resulting
boundaries: four sidebar factories, two controller helpers, tree and new-tab module
families, and four ordered sidebar stylesheet sections. UI and native suites now live
under `test/ui/` and `test/firefox/`; their stable identifiers resolve through the QA catalogue.
Source instrumentation uses exact match counts and supports historical/current layouts.

The shared model, persistence, browser/presentation caches and snapshot transfer retain
their existing ownership. The add-on manifest and dependency lockfile are unchanged.
There is no stored-format change or migration. The entry points still own application
state, queues, publication and recovery; extracted modules do not copy that state.

Frozen extension source hashes used by both comparison runs:

| Source                   | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Starting revision        | `c33697c2546b24299be81eb7fdf25da8e800acde0703730ba45f29c62e76e493` |
| Reorganised working tree | `2cace0e14f5657b413ee0ea2e673b3aff7c8d0bb13775831f860a7d981f6f8c5` |
| Final iteration harness  | `1dcee74665483385be91347f0374f1252d51ba72d61724083215a3fe24c0b4d7` |

The initial local inventory also included ignored Finder metadata. Its fingerprint
is recorded separately; frozen comparison sources exclude ignored local files.
Evidence directories below are local ignored outputs, like the other historical reports.

## Functional and structural validation

| Check                                | Result                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Starting `npm run check`             | 714 tests passed, formatting and lint passed                                                                                         |
| Final `npm run check`                | 718 tests passed, formatting and lint passed                                                                                         |
| Final `npm run qa:release`           | 61/61 checks passed: check, 43 UI suites, 16 native Firefox suites and unsigned build                                                |
| Equivalent Sidebar/Settings fixtures | All 18 captures matched the starting pixels exactly                                                                                  |
| Rendering boundary                   | 99, 100 and 101 filtered rows, crossing the threshold in both directions at 220 px width                                             |
| Static module graph                  | 73 production JS modules; no missing relative imports or dependency cycles                                                           |
| Mechanical tree/new-tab moves        | Function bodies unchanged apart from imports/module-relative URLs; full renderer body preserved                                      |
| CSS split                            | Concatenated rules and their order match the starting stylesheet, ignoring whitespace                                                |
| Package inspection                   | 126 packaged files match source bytes; production imports/assets resolve; test tooling, documentation and platform metadata excluded |

The visual fixtures cover Sidebar and Settings at 220, 320 and 480 px, in light,
dark and forced-colour modes with reduced motion. The browser suites also exercise
animations, keyboard/focus, click/double-click, dragging, menus, optimistic actions,
stale responses, hidden-view disposal, metadata/audio updates, pooled rows, search,
domains, Saved for Later and pins. Existing visual assertions were retained.
The exact stylesheet-file expectation was updated to include the three new links.

New unit coverage checks absent/ambiguous instrumentation anchors, suite registration
and historical/current source resolution. The rejected wrapper-pool diagnostic remains
available against both supported layouts, confined to frozen diagnostic copies.

The native upgrade suite installs published `v0.2.0` source and replaces it with the
same-ID, same-version candidate. It passes checks for hierarchy, ordering, durable
identities, membership, containers, mixed pins, settings, opaque fields, interrupted
moves, reloads, delayed native restoration and retry stability. Existing controller
failure, partial completion, lost-response, restart and multi-window coverage passed.

The first complete QA attempt exposed a lint spacing issue and the old stylesheet-file
list expectation. Both were corrected, the affected checks passed, and the full gate
was rerun successfully. No functional assertion or visual expectation was relaxed.

Evidence:

- [Final release QA](../../test-results/release-qa/2026-10-23T09-11-47.977Z/results.json)
- [Published-source upgrade/reload](../../test-results/memory/upgrade-2026-10-23T09-15-01.495Z/results.json)
- [Final visual comparison](../../output/scratch/reorganisation-2026-10-23/verified-layout-comparison.json)
- [Structural review](../../output/scratch/reorganisation-2026-10-23/structure-review.json)
- [Sidebar extraction review](../../output/scratch/reorganisation-2026-10-23/extraction-review.json)
- [Package inspection](../../output/scratch/reorganisation-2026-10-23/package-review.json)

## Performance validation

Commands used the Node 24 runtime from `.nvmrc`, the fixed starting revision and the
final harness. No source or harness changes occurred during the measurements.

```sh
npm run benchmark:optim -- --baseline e0b370d94318fe90d2e6e6654c81e9773a67536a --output test-results/memory/iteration/reorganisation-screen-20261023
npm run benchmark:optim -- --baseline e0b370d94318fe90d2e6e6654c81e9773a67536a --confirm --output test-results/memory/iteration/reorganisation-confirm-20261023
```

Screening completed three alternating pairs. Confirmation generated fresh five-pair
A/A calibration, then completed five alternating comparison pairs. All resource guards
and workload limits remained unchanged; there were no resource stops or incomplete runs.
The same valid calibration was subsequently applied to the screening measurements,
without rewriting their original uncalibrated report.

All **298 metrics** were reviewed in both comparisons: **226 showed no demonstrated
change**, and **72 deterministic API work counts were unchanged**. There were zero
Firefox or synthetic regression flags and no demonstrated improvement. This includes
latencies, processor time, payloads, DOM counts and the separate memory measures.

Selected confirmation medians, including increases:

| Metric                                  | Starting revision | Reorganised | Assessment                                    |
| --------------------------------------- | ----------------: | ----------: | --------------------------------------------- |
| Idle extension-process resident memory  |        299.385 MB |  297.501 MB | No demonstrated change                        |
| Sampled extension-process RSS peak      |        416.465 MB |  419.660 MB | No demonstrated change                        |
| Warm tab-data reply p95                 |              2 ms |        2 ms | No demonstrated change                        |
| Folder action test sequence             |          13.575 s |    13.543 s | No demonstrated change                        |
| Extension CPU during folder actions     |           3.782 s |     3.817 s | No demonstrated change                        |
| Idle sidebar DOM elements, two sidebars |               714 |         720 | Three additional stylesheet links per sidebar |

The extra six DOM elements match the three direct stylesheet links added to each of
two sidebar documents. Row reuse, stable identities and interaction ownership continue
to pass their existing checks.

- [Screening report](../../test-results/memory/iteration/reorganisation-screen-20261023/report.md)
- [Calibrated screening assessment, all metrics](../../output/scratch/reorganisation-2026-10-23/calibrated-screen.json)
- [A/A calibration](../../test-results/memory/iteration/reorganisation-confirm-20261023/calibration/report.json)
- [Confirmation report](../../test-results/memory/iteration/reorganisation-confirm-20261023/report.md)
- [Confirmation raw measurements, all metrics](../../test-results/memory/iteration/reorganisation-confirm-20261023/report.json)

## Measurement limits

These results apply to Firefox 158.0.1 and Node 24.22.0 on Apple M1, 16 GiB RAM,
Darwin 27.0.0. The bounded native fixture uses 1,000 mostly discarded tabs across
two windows/sidebars and one live page. Synthetic Node fixtures use 100, 1,000 and
10,000 tabs with two readers per window. No exceptional stress workload was run.

The calibrated policy requires agreement in every pair, a change exceeding 10% and
more than three times the full A/A range to flag a timing/memory regression. Passing
that policy does not establish universal equivalence or leak freedom. Raw increases
remain visible in the full report. Node heap is not Firefox RAM; extension-process
memory includes Firefox runtime/control-extension overhead, and folder sequence times
include settlement. Reply p95 is not complete click-to-screen latency, and CPU time
is not battery consumption.

The published-source upgrade/reload check does not establish preservation across a
complete Firefox process restart or every possible installed data set. Visual equality
is limited to the captured fixtures and the browser/OS/fonts used for this run.
