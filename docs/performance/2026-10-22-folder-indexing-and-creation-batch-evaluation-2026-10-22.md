# Folder indexing and creation batch evaluation (2026-10-22)

Folder indexing is retained after the targeted response, standard regression and
functional checks below. The creation batch proposal is not retained.

The baseline is `600aeb0746f8a301f3b12bcac61cf36c7cc1981a`, extension fingerprint
`67c2ff26dd7465df87b6f257e46575f7a934582561084231f1c82eb823e71ad5`.
Both proposals were implemented as independent frozen candidates. The creation
candidate was rejected after screening; only folder indexing passed
final qualification. No storage, message, permission, identifier or version changes
are involved.

Folder actions build fresh, local indexes. Copy URLs and close confirmation use
indexed membership; Move contents traverses indexed children iteratively; the menu
reuses its existing unsaved collection when enabling Close all tabs. Ordering,
duplicate URLs, pins, Saved exclusion, Home and indentation remain unchanged.
Controller validation and writes are unchanged. There is no persistent index cache.

The folder candidate is
`42a3490569b3b2764e6d48f30b71d587575a97e6c1dd2cfc5c70f317c7cd5219`.
Its native supplement uses 1,000 discarded tabs plus a control tab, separately with
1,000 flat folders and 481 folders in depth-12 branches. Each run performs 30 menu
opens, copies, close confirmations and Move contents preparations per layout.
Menu and Move contents measurements use an empty root folder; copying and close
confirmation use the first populated root and its descendants. This isolates
destination preparation and the worst case for the redundant empty-folder scan.
Clipboard writes go to an identical test-only substitute and dialogs are cancelled.
Full membership, opaque saved records, native identities and complete sidebar row
order are checked outside timing.

Input is injected through DOM events inside the isolated Firefox sidebar. Response
means handler entry to the correct result/DOM and the next animation frame; it is
not hardware input latency or proof of paint. Earlier pilots failed because of
test-bridge input and cross-realm observer errors. Those reports are preserved but
excluded from comparisons. The corrected pilot is `folder-dom-pilot4/`; all screen,
calibration and confirmation results below use the same corrected harness.

Three alternating screening pairs, five same-source A/A pairs and five fresh
confirmation pairs completed. Calibration and confirmation were separate bounded
invocations. All 218 metrics were reviewed: four demonstrated response improvements,
214 without demonstrated change and zero calibrated regression flags.

| Scenario                  | Metric       | Baseline median | Candidate median | Change |
| :------------------------ | :----------- | --------------: | ---------------: | -----: |
| Flat Move contents        | Response p95 |           15 ms |             4 ms | -73.3% |
| Nested close confirmation | Response p95 |            7 ms |             3 ms | -57.1% |
| Nested Move contents      | Response p95 |            8 ms |             3 ms | -62.5% |

The fourth qualifying metric is flat Move contents maximum response, 15 to 5 ms.
Each exceeds 10% and three times its 1 ms full A/A range, improving in every
confirmation pair. These are bounded folder-heavy workloads, not whole-app speed
claims. Native CPU reductions did not clear the full A/A range requirement, so no
CPU improvement is established. Flat Move contents sequence CPU was mixed, with
medians of 1,038.428 and 1,087.505 ms (+4.7%); this did not establish a regression.

No RAM improvement is established. Final collected allocated heap was 18.224 versus
18.213 MB, resident memory 297.435 versus 289.096 MB, and resident-unique memory
109.724 versus 101.794 MB. Explicit memory was 31.083 versus 31.012 MB. Approximate
sampled extension RSS peaks were 755.565 versus 618.349 MB. None qualified as a
memory gain; no memory median increased by more than 10%. These process figures
include Firefox runtime and the control extension. Final ghost-window counts were
zero, and reported orphan DOM bytes were 80,144 in every final sample. The optional
main-runtime GC-heap reporter was unavailable; it is not treated as zero. Maximum
aggregate owned RSS was 2.703 GB, below the unchanged 4 GiB guard.

The rejected creation candidate
`a897149da678e0505fed09dceca76b1c4853f002306cbfa1f57b7710c67ae108`
added batch-local child counts, pinned-parent membership and sibling slots. Its
three-pair native screen used 900 existing tabs, root/common-opener layouts and
100 parallel, 100 sequential and ten individually completed creations, cleaning
up between scenarios. CPU medians ranged from 4.9% lower to 3.0% higher; no targeted
CPU or completion improvement exceeded 10%. Root parallel completion was 1,184
versus 1,327 ms (+12.1%, uncalibrated). Collected heap was 17.627 versus 17.865 MB
(+1.3%, uncalibrated). No five-pair confirmation was justified. The controller
change was removed, with its source and patch preserved locally; there is no
combined two-change performance claim.

The standard `benchmark:optim` completed three screening pairs, five matching A/A
pairs and five fresh confirmation pairs, with calibration and confirmation in
separate invocations. It covered 1,000 native tabs across two real sidebars and
the 100/1,000/10,000-tab synthetic cases. All 298 confirmation metrics were reviewed:
226 without demonstrated change, 72 unchanged work measures and zero calibrated
regression flags. An exact-search slowdown in the screen did not reproduce as a
calibrated regression. Maximum aggregate owned RSS was 2.690 GB; no worker stopped
on resources.

The standard memory review investigated the uncollected added-heap median after
view cycles: 3.098 to 4.871 MB (+1.773 MB). The increase was not consistent across
pairs and was smaller than the 6.087 MB full A/A range. Collected total heap at
that stage was 19.901 versus 19.769 MB, and after final disable it was 11.255 versus
11.122 MB. Collected added-heap differences of +22 KB after cycles and +20 KB after
disable were also inconsistent and below their 134/133 KB A/A ranges. The review
did not establish increased retained memory. Native process memory and Node heap
remain separate measures.

Separate instrumented functional fixtures counted hierarchy `id`/`parentId` reads
without timing. With 1,000 tabs and 1,000 flat folders, Copy URLs fell from 473,236
to 9,000 reads, Move contents from 1,505,501 to 12,000, and the empty-folder menu
from 483,287 to 10,990. A separate 400-folder deep-chain fixture reduced Move
contents reads from 11,067,204 to 5,596. These are work counts, not Firefox CPU or
RAM estimates. The rejected creation prototype reduced record-field reads from
205,400 to 6,200 for 900 existing plus 100 created tabs, with identical native and
session API counts; that did not establish a native performance benefit.

Validation passed `npm run check` with 686 unit tests and all 15 affected UI suites:
core, group actions, indexed folder actions, move dialog, folder picker, group
creation, folder clicks, tab clicks, tree expansion, pinned tabs, pinned folders,
Later, containers, tab closing and new tab. The new indexed-action suite verifies
exact copied URL order and duplicates, pins, Saved exclusion, empty and Saved-only
menus, stale copy/close IDs, collapsed descendants, duplicate names, destination
ordering/indentation and hierarchy mutation between actions. Existing controller
tests retain fresh-state confirmation checks, partial failures and retry coverage.

Nine native Firefox checks passed: smoke, move dialog, drag, pinned folders, Later,
container picker, tab closing, new tab and published-version upgrade/reload. The
upgrade suite initially captured a restored tab's transient `about:blank` as its
expected URL. It now waits, within 15 seconds, for the known original URL in both
native and controller state before capturing the expectation; the complete URL and
organisation assertions remain. The corrected test passed same-ID upgrade from
`v0.2.0`, reload, delayed restoration, interrupted move recovery, retry and opaque
saved-field preservation. This does not claim whole-Firefox restart coverage.

The final 115-file extension export matches the measured folder candidate exactly;
`source-equivalence.json` records the comparison. No version bump, signing or
publishing was performed.

Runtime: Node 24.19.0, Firefox 158.0.1, macOS 27.0.1 (26A434), Apple M1 with 16 GiB.
Normal macOS pressure readings were available after execution-sandbox approval;
the guard was not bypassed. Measurements used owned temporary profiles, no concurrent
test/profiling loads and unchanged pressure, RSS and timeout limits. No valid
targeted run stopped on resources. Node heap remains separate from Firefox RAM.

Evidence is under `test-results/memory/folder-creation-2026-10-22/`. Valid targeted
runs are `creation-screen/`, `folder-dom-screen/`, `folder-dom-calibration/` and
`folder-dom-confirm/`. Frozen sources, the supplemental harness, rejected patch,
metric audit and investigation logs are under
`output/scratch/folder-creation-2026-10-22/`.
