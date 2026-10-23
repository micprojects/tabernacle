# Native tab creation follow-up (2026-10-22)

The revised optimisation is retained after targeted CPU confirmation, standard
regression review and functional validation. It targets repeated full-window
native reads during inactive appends. The earlier child-count/sibling-slot
proposal remains removed.

The baseline is `027f4acdae0b3ce87c1ffc19efeb57e84fb70c73`, including the retained
folder indexing, with extension fingerprint
`42a3490569b3b2764e6d48f30b71d587575a97e6c1dd2cfc5c70f317c7cd5219`.
The final candidate fingerprint is
`c33697c2546b24299be81eb7fdf25da8e800acde0703730ba45f29c62e76e493`.
This is an incremental comparison against the accepted folder change.

A warm native-tab snapshot can now stage the IDs and expected positions of
inactive, unpinned tabs appended at the end of a known window. New records come
from authoritative `tabs.get` replies, including reuse of the controller's
existing required native check when the snapshot remains current. Earlier arrays
and position maps remain immutable. At most 32 pending additions are read at once;
larger bursts use the existing window query. Selections, middle insertions, active
or pinned tabs, navigation, moves, failed reads, cold snapshots and uncertain
native state retain the conservative invalidation/query path. Pending structures
are released after consumption or invalidation.

Creation queue boundaries, event delivery, serial membership writes, placement,
restored relationships and recovery remain unchanged. No persisted schema,
identifier, permission, public message or version changes are involved.

The investigation rejected an earlier variant that trusted creation-event records:
a real discarded-tab event reported width 729 while its authoritative native
record reported width 0. Complete native-field comparisons caught this difference.
The corrected design stages IDs and reads native records. An initial harness
pilot also exposed different optional fields between the control extension's MV2
permissions and the app's MV3 permissions; all valid comparisons query through the
same app permission context. Failed pilots are preserved and excluded.

Final review reproduced a disposal race in the initially confirmed prototype
`de5b23d4418797fb38af5a7896df841331d6ab1a855d94b02497fba9d99f12b6`:
an invalidated append refresh could expose its discarded empty placeholder if
disposal happened before the reader resumed. The new regression test failed before
the correction and passed afterwards. Discarded reads now carry a private sentinel
that triggers an authoritative retry even after disposal. The initial standard
confirmation was deliberately cancelled during its fourth pair after this finding;
it was not a resource stop. Its partial report is preserved and excluded from
qualification. The final CPU results below are fresh measurements of the corrected
source, not an extrapolation from that superseded prototype.

An independent append-tail index prototype passed 8,000 ordering queries and
5,309 commits over 40 deterministic fixtures, plus the existing controller
contracts. It was not timing-qualified or retained. Instrumentation showed only
three placement-context builds during 100 sequential native arrivals, while
repeated native window queries transferred tens of thousands of existing records.
That evidence directed the subsequent candidate towards native snapshot reuse.

Separate instrumented runs, outside timing, verified the final source's work:

| Creation scenario                    | Baseline window queries / returned rows | Candidate window queries / returned rows | Baseline / candidate single-tab reads | Membership writes, both |
| :----------------------------------- | --------------------------------------: | ---------------------------------------: | ------------------------------------: | ----------------------: |
| 100 root sequential                  |                             99 / 94,346 |                                    0 / 0 |                             100 / 199 |                     200 |
| 100 root parallel                    |                               1 / 1,001 |                                1 / 1,001 |                             100 / 100 |                     200 |
| Ten individually completed root tabs |                              10 / 9,065 |                                    0 / 0 |                               10 / 13 |                      20 |

The sequential root workload still makes 199 `tabs.query`/`tabs.get` calls; it
transfers far fewer unchanged records. Both revisions build three placement
contexts and read 100 tab memberships. Common-opener query/read/write counts remain
unchanged. Safe check reuse depends on event/read timing: the ten individual
creations used 13 single-tab reads in the final diagnostic, not necessarily one
per creation. These counts explain work removed, not whole-app speed estimates.

The targeted supplement uses 900 existing discarded tabs and at most 100 new tabs,
plus a control tab. Root and common-opener layouts each run 100 parallel creations,
100 sequential creations and ten individually completed creations, with cleanup
between scenarios. Completion requires committed placement beyond the existing
sibling tail. Full native fields, identities, membership, opaque saved records and
complete sidebar row order are verified outside timing. Volatile `lastAccessed`
values are excluded from exact native-field equality. Animation-frame gaps are
observations during the workload, not paint latency; a single batch has no p95.

The design passed three alternating screening pairs and five matching A/A pairs.
After correcting the disposal race and passing functional validation, five fresh
confirmation pairs measured the final source using that unchanged baseline,
harness, runtime and fixture calibration. All 201 comparative metrics were reviewed:
one demonstrated CPU improvement, 200 without demonstrated change and zero
calibrated regression flags.

| Root sequential, 100 creations | Baseline median | Candidate median |           Difference | Assessment                           |
| :----------------------------- | --------------: | ---------------: | -------------------: | :----------------------------------- |
| Extension-process CPU          |      454.290 ms |       308.506 ms | -145.783 ms (-32.1%) | Demonstrated improvement             |
| Committed completion           |        2,372 ms |         1,844 ms |     -528 ms (-22.3%) | Not demonstrated against calibration |
| Whole-browser CPU              |    4,707.116 ms |     4,276.645 ms |  -430.471 ms (-9.1%) | Not demonstrated against calibration |

Extension CPU improves in all five confirmation pairs, by 29.5–37.2% per pair.
Baseline samples span 438.950–487.406 ms and candidate samples 302.457–314.529 ms.
The 39.183 ms full A/A range gives a 117.548 ms three-range threshold, which the
145.783 ms reduction exceeds. Completion is faster in every pair but does not
exceed three times its 367 ms A/A range. Parallel and common-opener workloads have
no demonstrated gain. Root sequential frame-gap p95 is 17.24 versus 16.70 ms;
maximum gaps are 83.32 versus 66.70 ms, inconsistently across pairs and below the
calibrated improvement threshold. No responsiveness improvement is claimed.

No Firefox RAM saving is demonstrated. Final enabled collected allocated heap is
18.145 versus 17.969 MB, and after disabling it is 11.684 versus 11.519 MB. The
respective full A/A ranges are 0.533 and 0.545 MB. Enabled-minus-disabled collected
heap medians are 6.452 versus 6.441 MB; explicit-memory differences are 12.196
versus 12.191 MB. These lifecycle comparisons do not establish increased retained
memory or a memory saving, and do not prove leak freedom. Final resident/unique
memory is 301.941/115.032 versus 299.237/110.985 MB. Approximate sampled extension
RSS peaks are 475.693 versus 471.663 MB, against a 54.624 MB full A/A range. Final
ghost-window counts are zero and orphan DOM bytes are 157,872 in every enabled
final sample. The optional main-runtime GC-heap reporter is unavailable, not zero.

The review includes large uncollected fluctuations. Root sequential allocated
heap rises from 32.715 to 37.683 MB, inconsistently across pairs and within its
6.728 MB A/A range; after cleanup it is 28.070 versus 28.059 MB. Before opener
work, explicit-memory medians are 68.755 versus 186.803 MB, but the candidate is
higher in only two of five pairs and the difference is below the 155.489 MB full
A/A range. After opener-parallel cleanup the medians are 93.857 versus 85.125 MB,
and final collected explicit memory is 29.291 versus 29.087 MB. These variable
unforced readings do not support a natural settled-RAM benefit or a calibrated
regression; the raw ranges and all individual pairs remain in the report.

The standard `benchmark:optim` completed three screening pairs, five matching A/A
pairs and five fresh final confirmation pairs in separate bounded invocations.
It covers 1,000 native tabs across two real sidebars and 100/1,000/10,000 synthetic
tabs across 1/2/9 windows. All 298 metrics were reviewed: 221 without demonstrated
change, 72 unchanged work measures, four demonstrated synthetic improvements and
one synthetic sampled-heap review flag. There are zero Firefox regression flags.
Maximum aggregate owned RSS is 2.632 GB, with at least 65% pressure-free memory;
all final workers completed under the unchanged guards.

The synthetic creation/closure phase, including validation and message-copy work,
improves from 13.216 to 10.024 ms at 100 tabs, 36.544 to 21.636 ms at 1,000 tabs,
and 77.516 to 46.755 ms at 10,000 tabs. These are Node elapsed times, not Firefox
latency or CPU measurements. The fourth qualifying metric is the 10,000-tab
sampled Node heap maximum, 89.178 to 78.435 MB; sparse sampling has the limitation
below, so this is not treated as evidence of reduced actual peak or Firefox RAM.

The standard native retention review includes uncollected added heap after view
cycles, 3.480 to 7.134 MB. This increase is inconsistent across pairs and smaller
than its 5.624 MB full A/A range. Collected total heap at that point is 19.900
versus 19.909 MB and after final disable 11.253 versus 11.255 MB. Collected added
heap increases by 0.127 MB after cycles and 0.118 MB after disable, both
inconsistent and below their 0.188/0.190 MB A/A ranges. The similar disabled
difference does not establish added app retention. Synthetic collected heap after
disposal is 0.028–0.034 MB higher across the three collection sizes (under 0.5%).
That roughly constant overhead also persists after the controller and its caches
are disposed, consistent with extra code/runtime cost rather than retained state
growing with tab count. This small measured Node cost is not hidden by the CPU
gain, and no Firefox RAM saving is claimed.

The standard confirmation flags Node's 100-tab creation/closure sampled heap
maximum: 8.705 to 11.698 MB (+34.4%), with a 0.057 MB A/A range. Three separate instrumented
pairs on the final corrected source used the same 100-tab workload and V8
collection tracing. Including collection-boundary observations exposes baseline
maxima of 11.823–11.824 MB, which the ordinary checkpoints missed. Candidate
observed maxima are 11.747–11.817 MB. The baseline performs four young-generation
collections during the phase; the candidate performs three. Allocation totals
between collections, including fixed phase bookkeeping, are approximately 12.95
versus 12.24 MB. Collected heap is approximately 7.384 versus 7.411 MB.
This supports a collection-timing/sparse-sampling explanation for the apparent
3 MB increase, rather than increased peak or a large retained allocation. Raw
flags remain in the reports. These intrusive Node diagnostics do not establish
timing gains, exact allocation peaks or Firefox RAM benefits.

Validation passed `npm run check`: 714 unit tests, lint and formatting. The 28 new
cache tests cover immutable earlier snapshots, incomplete creation-event records,
concurrent windows, active/pinned/middle-insertion fallbacks, failed reads, metadata
and navigation during reads, selection/move/removal, native movement during awaited
membership writes, large bursts, bounded read counts and both disposal races.
Existing controller contracts cover saved identities, ordering exhaustion, pins,
Later, partial writes, retry, background restart and recovery.

All 20 affected UI suites passed: core, navigation, pane refresh, group actions,
indexed folder actions, move dialog, folder picker, group creation, folder clicks,
tab clicks, tree expansion, pinned tabs, pinned folders, Later, containers, tab
closing, new tab, drag, incremental pages and recently closed. All 13 native
Firefox suites passed: smoke, move dialog, drag, pinned folders, Later, container
picker, tab closing, new tab, domain filtering, tab collection, activity, Find and
published-version upgrade/reload. The upgrade suite verifies same-ID data from
`v0.2.0`, delayed restoration, interrupted move recovery, retry and opaque saved
fields. This does not claim whole-Firefox restart coverage.

Runtime: Node 24.19.0, Firefox 158.0.1, macOS 27.0.1 (26A434), Apple M1 with 16 GiB.
Measurements use owned temporary profiles, no concurrent test/profiling loads and
unchanged normal-pressure, 4 GiB RSS, five-minute worker and 30-minute command
limits. Normal macOS pressure readings are available after execution-sandbox
approval; no guard is bypassed. The final targeted confirmation peaks at 2.360 GB
aggregate owned RSS with at least 65% pressure-free memory. Node heap remains
separate from Firefox RAM. No version bump, signing or publishing is included.

The final 115-file extension export matches both final measured candidates exactly.
`source-equivalence.json` records the comparison.

Evidence is under `test-results/memory/creation-revisit-2026-10-22/`. Final targeted
results are in `targeted-final-confirm/`, calibrated by `targeted-calibration/`.
The standard results are in `standard-final-confirm/`, calibrated by
`standard-calibration/`.
Earlier screens, failed/superseded prototypes and the deliberately cancelled
`standard-confirm/` are preserved separately. Frozen sources, supplementary
harnesses, `corrected-gc-diagnostic/audit.json`, work-count diagnostics and
functional logs are under `output/scratch/creation-revisit-2026-10-22/`.
