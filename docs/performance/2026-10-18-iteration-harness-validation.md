# Iteration harness validation, 18 October 2026

The first confirmation compared `v0.2.0` (`7058ca6`) with the unchanged `optim`
production source (`cd4ec8d`; extension fingerprint
`a01406a00c6e1f7ccdcf809c4577cd1b778db2646bed63ae6362bbbfb7d5668d`).
Ten A/A and ten A/B native samples all completed, alongside their synthetic cases.
Native workers took 30.7–33.3 seconds; the full calibration plus confirmation took
11 minutes 25 seconds. Aggregate owned RSS peaked at **2.44 GiB**, below the new
3 GiB limit, with pressure-free memory at least **53%**. This gives an expected
three-pair screen of roughly three to four minutes, or a much shorter synthetic-only
screen; calibration is reusable when its context matches.

The smaller fixture still detected meaningful differences: median added unforced
extension resident memory **99.04 → 58.03 MB**, added collected extension heap
**48.56 → 17.80 MB**, and warm snapshot replies **25 → 1 ms**. It also flagged
tradeoffs: closed-sidebar added collected heap **2.38 → 2.85 MB**, 100-record Node
cold reads **4.17 → 5.65 ms**, and 10,000-record retained Node heap **55.05 → 63.15 MB**.
These validate that the harness exposes both gains and costs; they are not new
production changes or a blanket regression pass for the branch. MB here is decimal.

Evidence: `test-results/memory/iteration/run-rlC803/report.html` and `report.json`,
with all five A/A pairs under `calibration/`. Harness fingerprint:
`b7d184b6ab9231ee0d2a18b6a365ef58b12dc4a5e2e57205e2cb69c39ee4fa95`.
The registered native smoke suite also passed in 32.6 seconds, and the default
three-pair synthetic-only screen completed in 8.9 seconds. `npm run check` passed
542 tests plus formatting and lint. The generated report passed desktop/mobile
layout and data-label checks. No 60,000-tab benchmark or native capacity ramp was
needed for this validation.

### Allocation and retention follow-up, 18 October 2026

Three small changes were retained independently on `optim`, using Node 24.19.0,
Firefox 158.0, fresh matching five-pair A/A calibration and five comparison pairs
for each immediate baseline. The established iteration workload and guards were
unchanged. Counts below come from five alternating targeted probe pairs; they do
not describe all allocations or Firefox RAM.

| Change (baseline → retained commit)                      | Supported benefit                                                                                                                                                                                                                   | Limits and regression review                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity comparison shortcut (`60213f4` → `4a1fb1f`)     | Presenting 1,000 unchanged containerless rows in a fresh array: 2,000 comparison WeakMaps → 0.                                                                                                                                      | No demonstrated native timing/memory change. Closed-sidebar CPU 9.62 → 12.63 ms remained within the 4.22 ms A/A range.                                                                |
| Share native position indexes (`4a1fb1f` → `f664bb1`)    | Two cold window reads with 1,000 tabs: four duplicate controller maps / 2,000 inserted entries → zero. Node create/close sampled heap 27.03 → 18.09 MB met confirmation thresholds.                                                 | Native RAM/timing unchanged within calibration. Node 10k retained cold heap 63.15 → 62.63 MB and reader-closed heap 44.00 → 43.48 MB were smaller but below the 10% memory criterion. |
| Release obsolete close snapshots (`f664bb1` → `a64f02e`) | After a fresh state and completed correction, one obsolete transition snapshot and its N-entry tab array → zero, at 100/1,000/10,000 tabs; WeakRef collection confirmed release in both close event orders and ordinary activation. | No demonstrated Firefox RAM/timing change. An initial warm-reply p95 review flag (1 → 2 ms) did not repeat in five additional pairs: every baseline/candidate p95 was 2 ms.           |

All relevant metrics were reviewed, including reader closure, view cycles, final
disable and controller disposal. No material regression remained after the bounded
follow-up. Close cleanup's closed-sidebar collected added heap was 2.863 → 2.877 MB
initially and 2.849 → 2.848 MB in the follow-up, illustrating why the targeted retention
benefit must not be presented as demonstrated native RAM savings. Small-session cold
reads remained around 5.6–5.8 ms. These changes do not resolve or fully explain the
earlier published-to-branch tradeoffs; index sharing only trims part of the synthetic
retained-heap increase. MB is decimal; sampled Node heap is not an exact peak.

Each retained change passed `npm run check` (543, 545 and 548 tests respectively)
and its affected registered UI/native suites. Coverage included metadata refresh,
ordering/filtering, dragging, containers, disposal, close/undo, keyboard navigation,
native Find and published-version upgrade with interrupted move/retry and delayed
restore. Upgrade/reload coverage does not prove a complete Firefox restart. An
initial core QA run mistakenly used the scratch runner's 3 GiB benchmark cap and
stopped inconclusively; the user authorised the documented 4 GiB functional QA guard,
and core QA passed at that limit. Iteration benchmarks stayed at 3 GiB throughout.

Rejected after inspection, without new benchmark claims: sharing writable reader
arrays would alias older snapshots; clearing all close-selection state when a
sidebar closes would lose state needed by native close behaviour. Broader snapshot
ownership changes need a separate design. Do not repeat the earlier discarded
viewport, lazy-favicon or eager-projection experiments without new evidence.

Evidence is under `test-results/memory/optim-2026-10-18/`: `identity-resume-confirm/`,
`index-confirm/`, `close-confirm/` and `close-followup/` contain reports; their matching
calibrations are recorded in each report. `identity-counts.json`, `index-counts.json`
and `close-counts.json` contain targeted probes. The `identity-*`, `index-*` and
`close-*` check logs and suite reports preserve functional results. Investigation
notes and probe sources remain in `output/scratch/optim/iteration-2026-10-18/`.
