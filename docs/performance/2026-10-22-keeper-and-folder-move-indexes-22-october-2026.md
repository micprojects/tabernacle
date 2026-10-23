# Keeper and folder move indexes: 22 October 2026

Reviewed duplicate batches now index keeper candidates once by canonical HTTP URL
and container. Selected closing copies are excluded. Each target reads only its
matching reviewed candidates, while retaining fresh native keeper, target and scope
validation immediately before removal. No live tab result is cached across closes.
Folder move plans build a fresh folder index for descendant counts, cycle checks
and folder lookups. The index belongs to one plan, so in-place hierarchy changes
are reflected by the next preview and by controller validation. Tab move planning
does not build this index. Storage formats, identifiers and mutation paths are unchanged.

Deterministic checks with 500 distinct duplicate pairs reduced native tab reads
from 253,000 to 3,500. A folder plan with 1,000 tabs and 1,000 flat folders reduced
folder-ID reads from 502,520 to 9,005. The regression tests bound work at 100
duplicate pairs and 1,000 folders, and cover Reader View URLs, container boundaries,
stale/closed/moved keepers, failed reads, fallback keepers, partial close failures,
restart/retry, descendant counts, pins, Saved tabs and mutable folder hierarchies.

Baseline is `b0f87246db604efba282cdc0fca60efc94e6546a`, exported extension SHA-256
`085d8050e2f634a2580bffc7f20ce9052d86917e341953bfd52547ad9a928fca`.
Candidate extension SHA-256 is
`67c2ff26dd7465df87b6f257e46575f7a934582561084231f1c82eb823e71ad5`.
Measurements used Node 24.22.0 and Firefox 158.0.1 on the 16 GiB M1 Mac, with the
existing resource limits and no concurrent test loads.

The supplemental native fixture has 1,000 discarded tabs, 1,000 flat folders and
one sidebar. It measures 90 trusted folder drag destinations and three duplicate
close batches of 100 distinct URL pairs. Every preview and batch is checked;
surviving native identities, complete membership, opaque saved fields and sidebar
state are verified outside measurement. These are folder-heavy and many-distinct-pair
workloads, not evidence of equivalent gains with a small collection.

Three alternating screening pairs, five matching same-source A/A pairs and five
fresh confirmation pairs completed. All 59 targeted metrics were reviewed: seven
demonstrated improvements, 52 without a demonstrated change and zero regression
flags. The confirmed gains exceed 10% and three full A/A ranges, with the same
direction in every pair.

| Scenario                    | Metric                 | Baseline median | Candidate median | Change |
| :-------------------------- | :--------------------- | --------------: | ---------------: | -----: |
| Folder previews, 90 targets | Extension CPU          |    1,372.256 ms |       907.262 ms | -33.9% |
| Folder previews, 90 targets | Whole-browser CPU      |    2,531.049 ms |     2,091.824 ms | -17.4% |
| Duplicates, three batches   | Extension CPU          |    2,044.998 ms |       715.586 ms | -65.0% |
| Duplicates, three batches   | Whole-browser CPU      |   13,151.020 ms |     8,400.764 ms | -36.1% |
| Duplicates, three batches   | Completion             |        7,167 ms |         3,773 ms | -47.4% |
| Duplicates, three batches   | Per-batch p95 response |        2,528 ms |         1,488 ms | -41.1% |

The seventh improvement is duplicate maximum response, which equals p95 with only
three batches per run. Folder preview response and overall elapsed time did not
clear the calibrated improvement gate. Neither workload had a resource stop.

No memory improvement is claimed. After folder dragging, unforced resident-unique
memory rose from 222.63 to 266.49 MB in the medians, increasing in every pair;
the 43.86 MB difference was below three times the 27.61 MB full A/A range.
Other unforced folder-stage reporters also increased without crossing that gate.
Duplicate-stage explicit memory rose 25.8% in the medians but not in every pair.
Final collected heap was 18.57 versus 18.50 MB; sampled extension RSS peaks were
438.85 versus 474.12 MB. These observations do not establish leak freedom or
unchanged memory use in everyday Firefox profiles.

The standard `benchmark:optim` also completed three screening pairs, five matching
A/A pairs and five fresh confirmation pairs. Calibration and confirmation ran in
separate invocations taking 14.45 and 14.41 minutes. All 298 confirmation metrics
were reviewed: 226 without a demonstrated change, 72 with unchanged work and zero
regression flags. No standard memory median increased by more than 10%, and no
worker stopped on resources. The final working-tree export matches the measured
candidate; `source-equivalence.json` records that check in the scratch directory.

Final `npm run check` passed formatting, lint and all 686 unit tests. Ten affected
UI suites passed: tab collections, duplicate selection, drag, move
dialog, group actions, folder picker, pinned folders, tab close, domain filtering
and Later. Nine native Firefox suites passed: smoke, tab collections, drag, move
dialog, container picker, tab close, pinned folders, domain filtering and Later.
No release, upgrade or exceptional-capacity qualification is claimed.

Evidence is under `test-results/memory/indexed-actions-2026-10-22/`; the supplemental
harness, deterministic counts, audits and functional logs are under
`output/scratch/indexed-actions-2026-10-22/`.
