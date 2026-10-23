# Committed folder index: 19 October 2026

Controller folder lookups use an index published with each successfully committed
model; mutable transaction copies retain fresh scans. Stored formats and public
snapshots are unchanged. Against `3919309`, Node 24.19.0 / Firefox 158.0 native
confirmation measured **54.7% lower extension CPU** (3,171.9 to 1,437.5 ms) for
90 navigation actions after nine warmups in the explicitly folder-heavy fixture
of 1,000 folders and 1,000 tabs. All five pairs improved; the 1,734.4 ms reduction
exceeded three times the matching five-pair A/A range (662.5 ms). Correct-DOM p95
fell from 40 to 21 ms. The 100-folder CPU change did not meet the improvement gate.

The maintained benchmark completed three screening pairs, then five matching A/A
and five A/B pairs with 1,000 native tabs across two sidebars and the standard
100/1,000/10,000 synthetic cases. No calibrated regression was found among 292
metrics. Natural extension resident memory changed +0.03%, added collected
extension heap -0.09%, total Firefox resident memory +0.31%, and sampled extension
RSS peak +1.02%; none establishes a memory change. Reopening and lifecycle heap
also remained within calibration. Disable-phase extension CPU rose 5.2 ms (10.4%)
in the median, inconsistently across pairs and inside the 17.0 ms A/A range.

Validation passed `npm run check` (611 tests) and 23 affected UI/native suite runs,
including folders, containers, settings, backup, mixed pins, multiple windows,
Sidebar, Activity, New Tab, drag and native Find. Coverage includes failed reads
and writes, invalid data, recovery retries, retained/writable snapshots and cache
disposal. The published v0.2.0 upgrade and extension reload checks passed; these
are not complete browser-restart coverage. Tested extension fingerprint:
`a0ce133d0ae6536489aa3777f820d0181f1e852776a6100fa3bd99ba3ab133e5`.

Local evidence: `test-results/memory/performance-redesign/2a-confirm/`,
`2a-calibration/`, `2a-maintained-confirm/` and the `2a-*` functional reports.
Hypotheses, rejected drag prototypes and decisions remain under
`output/scratch/performance-redesign/`. Diagnostics and raw reports are not shipped.
