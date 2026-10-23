# Folder collection indexes: 21 October 2026

The next review candidate was repeated folder-array scanning in collection actions
and scoped Saved searches. `folderCollection` now uses the folder index already
built for its tree ordering, and search projection passes its existing index into
Saved matching. Duplicate review builds one index per refresh for scope checks and
folder labels. Folder batches build one index per operation inside the controller
queue; native target/keeper lookup and final validation still run before each write.
This adds no cross-snapshot cache. No storage, identifiers,
ordering, permissions or visible behaviour changes are intended.

The work-count test bounds collection and Saved-search folder reads linearly at
1,000 folders and checks root, missing, descendant and moved-folder scopes. Existing
partial-save and close/retry-after-restart tests now also run with a folder scope.

Baseline is `34b82c4` (the retained batch-close optimisation), exported extension
SHA-256 `8051a1adf0b70b0cbf2abaf913296af915e31f400ef20037a6701fd0e5929410`.
Candidate extension SHA-256 is
`bead957e8be52eebfed940fb261f543bb7dd31fd2e6184b36499e84b785f133e`.
The runtime is Node 24.22.0 and Firefox 158.0 on the 16 GiB M1 Mac.

The targeted native workload uses 1,000 discarded tabs and 1,000 folders in two
500-folder branches, with one sidebar. The first branch contains ordinary tabs;
the second is Saved for Later. Pairs share duplicate URLs. It opens the first
folder's menu forty times, its 500-copy duplicate review ten times, and cycles
between narrow and broad Saved searches twenty times in the second branch. Every
iteration checks counts or exact results; complete sidebar IDs, titles and order,
and unchanged native tabs, are checked outside measurement. This is a folder-heavy
workload, not evidence of the same gains with a small number of folders.

After three alternating screening pairs, five same-source A/A pairs and five fresh
confirmation pairs passed the existing gate: a reduction over 10%, larger than
three full A/A ranges, with the same direction in every comparison pair.

| Scenario                        | Extension CPU before | Extension CPU after | Change | Assessment               |
| :------------------------------ | -------------------: | ------------------: | -----: | :----------------------- |
| Folder menu, 40 opens           |           449.651 ms |          259.107 ms | -42.4% | Demonstrated improvement |
| Duplicate review, 10 opens      |           313.829 ms |          272.469 ms | -13.2% | Demonstrated improvement |
| Scoped Saved search, 40 queries |           599.015 ms |          370.278 ms | -38.2% | Demonstrated improvement |

Scoped-search whole-browser CPU also fell from 914.883 to 693.168 ms (-24.2%). All
75 targeted metrics were reviewed: four demonstrated improvements, 71 without a
demonstrated change and zero regression flags. Menu whole-browser CPU and some
unforced memory medians increased during screening but did not exceed the calibrated
regression gate in confirmation. No response-frame or memory improvement is claimed.
Peak owned-process RSS in confirmation was 2,228,011,008 bytes; no resource stop occurred.

The standard `benchmark:optim` completed five matching A/A pairs and five fresh
confirmation pairs in separate invocations (14.36 and 14.49 minutes). All 298 metrics
were reviewed: 226 without a demonstrated change, 72 with unchanged work and zero
regression flags. All workers completed within the existing resource limits. Together,
the two workloads support retaining this refactor.

Memory uncertainty remains explicit. Three unforced folder-menu memory medians rose
about 11% in all five targeted pairs, including a 15.5 MB resident-unique increase;
these did not exceed three A/A ranges. In the standard workload, sampled Node heap
medians rose 44.3% for the 1,000-tab create/close phase and 20.4% for the 10,000-tab
cold-reader phase. Matching high samples also occurred in the baseline A/A and
comparison runs (about 26.5 MB and 101.5–101.7 MB respectively); retained heaps stayed
near 12.72 MB and 62.85 MB. These observations do not meet the calibrated regression
gate and do not establish a Firefox RAM improvement or leak freedom.

`npm run check` passed formatting, lint and 662 unit tests. All forty registered
UI suites and the same nine native Firefox suites passed: smoke, domain, Later,
tab-collection, drag, tab-close, new-tab, Find and container picker. No release,
upgrade or exceptional-capacity qualification is claimed.

Evidence is under `test-results/memory/folder-collections-2026-10-21/`, with the
scratch harness, plan and logs in `output/scratch/folder-collections-2026-10-21/`.
Valid targeted runs are `targeted-screen-separated/`, `targeted-calibration/` and
`targeted-confirm/`; the standard evidence is in `standard-calibration/` and
`standard-confirm/`. Earlier failed fixture runs are preserved. They first exposed
privileged-frame event/selector errors, then a baseline traversal failure: both
the ordinary observer and a denser two-frame observer returned 499 of 500 expected
rows in mixed nested/Saved search, omitting tab 498. The final fixture separates
ordinary and Saved branches and retains complete assertions. Product rendering was
not changed to address that pre-existing failure; the results do not resolve it.
