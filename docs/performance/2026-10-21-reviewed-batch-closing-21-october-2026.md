# Reviewed batch closing: 21 October 2026

The search refactor above was committed as `0a4576e` before this experiment. Reviewed
inactive closes now avoid building the full selection state before each removal.
The controller checks live native selection for each target, retains the existing
final target/keeper/scope validation, and uses the existing serialised removal and
invalidation path. Active targets still use the full selection/fallback path. No new
cache, stored format, durable identity or persisted organisation change is involved.

In a warmed controller, twenty inactive closes now require **one final native tab
query and one view read**, compared with twenty queries and twenty-one view reads.
Each target adds one direct native lookup; native removals and validation remain
serialised. Tests cover selection after earlier removals, activation between targets,
partial completion, a lost removal response, restart/retry, failed live lookups and
failed fallback queries, while preserving surviving placement and another window.

The frozen baseline extension fingerprint is
`28777597b742145bcc33c2e1f8a0968ed1d56acaf3605ea637961cad186df125`; the retained candidate is
`8051a1adf0b70b0cbf2abaf913296af915e31f400ef20037a6701fd0e5929410`.
Measurements used Firefox 158.0 and Node 24.22.0 on the 16 GiB M1 Mac, with unchanged
resource guards and no concurrent test loads.

The supplemental native fixture has 1,000 discarded tabs and one sidebar. Inactive
and duplicate scenarios each close three batches of twenty reviewed tabs; the mixed
scenario closes twenty tabs with its final target active. Every batch checks its
result and removed IDs; each scenario verifies surviving native IDs and complete
sidebar row order/titles. Setup gives targets explicit root placement through
ordinary controller moves, and the active target has a live seed successor.

Three-pair screening was followed by five matching A/A pairs and five fresh
alternating comparison pairs. Gains below exceed 10% and three full A/A ranges,
with the same direction in every pair.

| Scenario                   | Metric        | Baseline median | Candidate median | Change | Assessment               |
| -------------------------- | ------------- | --------------: | ---------------: | -----: | ------------------------ |
| Inactive, three × twenty   | Extension CPU |      963.687 ms |       382.246 ms | −60.3% | Demonstrated improvement |
| Inactive, three × twenty   | Completion    |        2,124 ms |         1,066 ms | −49.8% | Demonstrated improvement |
| Duplicates, three × twenty | Extension CPU |      815.160 ms |       364.498 ms | −55.3% | Demonstrated improvement |
| Duplicates, three × twenty | Completion    |        1,909 ms |         1,045 ms | −45.3% | Demonstrated improvement |
| Mixed active, twenty       | Completion    |          656 ms |           291 ms | −55.6% | Demonstrated improvement |

All 75 targeted metrics were reviewed: fourteen demonstrated improvements and no
regression flags. Mixed-active extension CPU fell descriptively from 251.552 to
116.990 ms, but did not exceed three times its A/A range. No memory improvement is
demonstrated. Mixed-active unforced heap had a 26.8% higher median, but increased in
only two of five pairs and remained within the measured A/A range.

The standard `benchmark:optim` also completed five A/A pairs and five confirmation
pairs, using separate invocations within the normal 30-minute limit. All 298 metrics
were reviewed: 226 showed no demonstrated change, 72 showed unchanged work, and none
flagged a regression. Neither workload stopped on resources. These results support
keeping the inactive-close refactor; they do not establish a gain for batches where
every successive close is active, or for larger native workloads.

Evidence is under `test-results/memory/batch-close-2026-10-21/`: `targeted-screen-final/`,
`targeted-confirm/`, `standard-calibration/` and `standard-confirm/`. The scratch
harness, plan and logs are in `output/scratch/batch-close-2026-10-21/`. Earlier failed
fixture runs are preserved: the unchanged baseline skipped unplaced records because
Firefox's native `groupId` can override an absent saved group during validation;
another baseline run loaded and renamed a discarded successor. Explicit placement
and a live successor correct the fixture equally for both sources. The pre-existing
unplaced-record validation issue remains outside this optimisation.

Validation: `npm run check`, all forty registered UI suites, and native Firefox
smoke, domain, Later, tab-collection, drag, tab-close, new-tab, Find and container-picker
suites. No release, upgrade or exceptional-capacity qualification is claimed.
