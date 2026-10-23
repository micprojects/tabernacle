# Independent action response experiment (2026-10-18)

Sidebar actions now negotiate optional snapshot protocol 2 and use the existing
reader base to receive changed tab records. The background remains authoritative;
full responses cover invalid bases, changed tab order, window/generation changes
and unsupported callers. The envelope has an explicit `snapshotProtocol` marker,
so ordinary action results such as folder-import previews keep their own tokens.
Receipts, errors and extra result fields survive decoding. Recovery requests a
fresh snapshot and never repeats the action. No stored formats, identifiers,
permissions, browser-tab unloading or upstream code are involved.

The baseline is the accepted audio commit
`e4fa2ffd1bc873f9f13bc8bda181a92e02d950b5`; the tested production fingerprint is
`8a6e1af740975e318223b9908437e2bdfc802da459cbac2efe26b5053617cb04`.
A fixed native Firefox 158.0 workload uses 100/1,000 tabs plus one seed tab, one
sidebar, three preloaded local pages, nine warmup actions and 90 `muteTab` actions.
An identical test-only hook calls each version's actual sidebar request function.
Each response, DOM convergence, final native state, identities and live-page
preservation are checked. The runner fingerprints original and instrumented
sources separately, plus diagnostics, fixtures, dependencies and runtime.

Five fresh alternating pairs at 1,000 tabs measured **action-response-and-decode
p95 of 76 ms → 32 ms (57.9% lower)**. Every pair improved. The 44 ms reduction
exceeds 10% and three times the matching five-pair A/A range of 4 ms. Extension
process CPU for the same sequence fell **5,982.189 ms → 1,935.012 ms (67.7%)**,
with improvement in every pair and a 265.448 ms A/A range. These are targeted
request/sequence measurements, not general browser speed or exact screen-paint
latency. The 100-tab response p95 and peak owned-process RSS did not clear the
acceptance gate; no Firefox RAM reduction is claimed.

The corrected candidate's standard three-pair screen and five-pair confirmation
covered 1,000 native tabs/two sidebars and 100/1,000/10,000 synthetic tabs, with
**no calibrated regression flags among 292 metrics**. The screen's consistent
uncollected closed-sidebar heap increase did not persist: confirmation medians
were 55.364 → 53.168 MB. Collected heap was 18,080 bytes higher (0.159%), within a
532,752-byte A/A range and not higher in every pair. Consistent Firefox adverse
observations remained only in the pre-install disabled baseline (browser CPU
+49.652 ms, resident +1 MiB and unique resident +688 KiB), all within A/A ranges.
These are preserved in the report and cannot be attributed to installed candidate
code. Synthetic cold-reader time increased by 0.073 ms at 100 tabs and 4.305 ms at
10,000 tabs (1.29%/1.79%, within A/A ranges). Small synthetic heap increases were
at most 40,984 bytes across the fixed sizes; the reader adds bounded functions
and validation, not another per-tab state store. Node heap is not Firefox RAM.

Formatting, lint and 587 unit tests passed, together with all 39 registered UI
and 16 native Firefox suites, including upgrade/recovery, multiple windows,
direct sidebar Finder, extension-page Find, dragging and lifecycle disposal.
The UI transport fixture now models negotiated action responses without weakening
its delta/row-identity assertions. The native collection fixture waits for a new
sidebar document before checking reload persistence; its old wait could match
rows before the scheduled reload. All existing data assertions remain in place.
Tests also cover a real lost move reply and durable receipt after restart,
non-snapshot import previews, malformed deltas and bounded response retention.

Evidence under `test-results/memory/independent-performance/` includes
`exp4-aa/`, `exp4-marked-screen/`, `exp4-marked-confirm/`,
`exp4-marked-standard-screen/`, `exp4-marked-standard-confirm/`,
`exp4-marked-functional*/`, `exp4-marked-check.log` and `exp4-precommit-proof.json`.
The earlier unmarked-envelope prototype was corrected before acceptance; its
`exp4-screen/`, `exp4-confirm/` and `exp4-standard-*/` samples are separate and do
not confirm this candidate. Matching A/A calibration was reusable because its
baseline, diagnostic, runtime and fixture remained identical and within 24 hours.
The reusable runner is `scripts/benchmarks/action-response/action-response-runner.mjs`
with the same bounded `screen|calibrate|confirm` interface as the audio runner.
The 3 GiB benchmark, pressure, progress and time limits remain unchanged.
