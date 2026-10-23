# Independent performance programme decisions (2026-10-18)

The programme began at `e368761dfd9e83de71c9142b43094ce7d2962a64` on
`codex/independent-performance-experiments`. Implementations were written from
behavioural hypotheses and this repository's architecture. No Tree Style Tab or
Sidebery code, tests, templates or dependencies were incorporated. Accepted changes
were committed sequentially; every rejected production prototype was removed.
The retained optimisations are:

- `e4fa2ff` — audio-only sidebar refreshes: 39.7% lower Firefox extension CPU in the
  confirmed 1,000-tab mute sequence.
- `9e6f784` — incremental sidebar action responses: response-and-decode p95 fell
  from 76 to 32 ms (57.9%) in the confirmed 1,000-tab action sequence. CPU for that
  sequence fell 67.7%.

Both primary metrics exceeded 10% and three times the full matching five-pair A/A
range, with improvement in every confirmation pair. Their separate evidence and
regression reviews are above. These are workload-specific Firefox measurements,
not general browser speed, screen-paint latency, battery-life or RAM claims.
The retained extension fingerprint is
`8a6e1af740975e318223b9908437e2bdfc802da459cbac2efe26b5053617cb04`.

| Finding                                      | Decision                                             | Evidence and reason                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Individual row child patches              | No demonstrated improvement                          | CPU fell 15.7% in the screen, but the 119 ms reduction did not exceed the 142.9 ms noise gate. Find-compatible text edits and parity checks passed.                                                                                                           |
| 2a. Targeted activation                      | No demonstrated improvement under the retention gate | Confirmed DOM-highlight p95 improved 38%; the allowed five follow-up pairs did not resolve adverse click/closed-sidebar CPU observations. The latter remained within calibration noise, not a proven regression. Candidate discarded.                         |
| 2b. Targeted audio                           | Accepted                                             | `e4fa2ff`; confirmed Firefox CPU gain, relevant functional suites and standard regression gate passed.                                                                                                                                                        |
| 3. Changed IDs through refreshes             | No demonstrated improvement                          | Native sparse-title CPU fell 4.0% in the screen, with one adverse pair; below the primary gate. A native probe verified that the proposed deltas actually carried the eight changed IDs.                                                                      |
| 4. Incremental action responses              | Accepted                                             | `9e6f784`; confirmed response p95 gain, all registered UI/native suites and standard regression gate passed.                                                                                                                                                  |
| 5. Incremental search                        | No demonstrated improvement                          | Cached normalised text and narrowing of actual matches passed parity. Screened query-to-correct-DOM p95 was 33 → 36 ms at 1,000 tabs; no primary benefit.                                                                                                     |
| 6a. Completed-operation notification batches | Inconclusive                                         | Before production changes, the two-sidebar structural baseline reached the unchanged 3 GiB owned-process limit at 1,000 tabs. Batch stopped without retry or raised limits. Existing 16 ms notification coalescing and serialised reads remain.               |
| 6b. Structural transport deltas              | No demonstrated improvement                          | Optional protocol 3 passed targeted parity, but screened burst p95 improved only 4.5%, with one adverse pair. The 35.3% CPU reduction is an uncalibrated secondary observation, not a substitute for the declared metric.                                     |
| 7. Flat sibling rows                         | Incompatible prototype                               | Folding removed outgoing child rows immediately and left focus on the document body. The baseline retained inert outgoing rows and focused their parent. Nested animation cancellation also failed. No performance claim.                                     |
| 8. Full-text presentation pooling            | Incompatible prototype                               | All row text remained connected; 100-tab native Finder discovery, highlighting, Find Again and last-row scrolling passed. Complete controls did not: 24–25 close controls remained versus 101 in the baseline. No heap comparison.                            |
| 9. Validated cold-start cache                | Inconclusive; deferred                               | Installed Firefox 158 rejected persistent installation of the exact unsigned baseline with `ERROR_SIGNEDSTATE_REQUIRED`. Genuine browser-restart profiling and validation were unavailable. No cache was implemented; extension reloads were not substituted. |
| 10. Unused derived-state release             | No demonstrated improvement                          | Token-specific reader cleanup reduced retained response bases from nine to one after the final reopen, but collected closed-view Firefox heap fell only 1.6%, not in every screen pair. Faster screened reopening was secondary and uncalibrated.             |

The 1,000-tab pooling diagnostic initially consumed an interim zero match count.
A baseline-only follow-up reported a found result with `total: -1, limit: 1000`;
the diagnostic's exact-count assertion was unsuitable at Firefox's cap. No
1,000-tab pooling parity pass or baseline Finder defect is claimed. The separate
100-tab control-semantics failure was sufficient to reject the prototype. Direct
sidebar Finder and the normal extension-page Find bar remain distinct tests.

Previously implemented or disproven approaches were also audited: generic event
coalescing, unchanged-write suppression, bounded reads, hidden-view release,
shared SVG sprites and close/globe masks already exist. Wholesale row-cache
eviction, viewport-only rows and lazy favicon hints retain their earlier adverse
evidence; none was reintroduced. No live page was unloaded by retained code.

The local ledger, predeclared hypotheses and exact rejected prototypes are in
`output/scratch/independent-performance/`. Raw evidence is in
`test-results/memory/independent-performance/`: `exp5-*`, `exp6a-pilot/`,
`exp6b-*`, `exp7-*`, `exp8-*`, `exp9-persistent-prerequisite/` and `exp10-*`,
alongside the earlier experiment reports. These ignored artefacts are not shipped.
Screen-only differences are uncalibrated observations. Resource stops are
inconclusive. Node heap and work counts are kept separate from Firefox claims.

Final guarded `qa:release -- --stress` verification completed with **57 of 58
checks passed**, including all 39 UI suites, 15 native suites, the documented
100/500/1,000-tab functional stress workload and the unsigned local build. The
remaining native collection suite was **inconclusive**: its 60-second no-progress
guard stopped it while connecting DevTools, with peak owned RSS 2.02 GiB and
pressure-free memory at least 70%. It had passed against the same retained
production code before experiment 4 was committed. This final stop is neither a
functional pass nor evidence of a product regression. No automatic retry was run.
The full final regression gate therefore remains unconfirmed. Evidence:
`test-results/release-qa/2026-10-18T20-15-53.659Z/results.json` and its collection
log/guard report.

The old QA runner continued later suites after that inconclusive result. The
follow-up correction now stops the batch and records the remaining suites without
running them. Formatting, lint and all 589 unit tests passed, including explicit
guard-stop and ordinary-failure batch tests. No native suite was rerun for this
tooling-only correction. Extension sources and benchmark limits are unchanged.

The maintained `benchmark:report` workflow separately compares committed final
HEAD against `e368761` in five alternating pairs. This is the planned cumulative
workload, not a retry of the stopped collection suite.
The cumulative report is reserved under
`test-results/memory/independent-performance/cumulative-final/`; its generated
headline, detail and regression tables remain authoritative, including adverse
results. This programme makes no version, signing, publishing or support-policy
change and does not run the exceptional 60,000-tab matrix.
