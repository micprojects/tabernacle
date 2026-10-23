# Independent audio refresh experiment (2026-10-18)

The independent performance programme started from
`e368761dfd9e83de71c9142b43094ce7d2962a64`. The retained audio candidate was written
from Tabernacle's existing view/index architecture; no Tree Style Tab or Sidebery
source, tests or dependencies were copied.

Audio-only refreshes update affected tab/folder ancestor summaries and rows instead
of rebuilding the whole tree. All paths/counts are validated before publishing a
summary change. Topology, activation, search, domain views and active gestures or
motion retain the full-render fallback. No storage format, transport, browser-cache
or live-page lifecycle changes are included.

Five fresh alternating Firefox 158.0 pairs at 1,000 native tabs measured extension
process CPU for 90 mute transitions: **838.375 ms → 505.586 ms (39.7% less CPU)**,
with improvement in every pair. The matching five-pair A/A range was 35.725 ms;
the 332.789 ms reduction exceeds both 10% and three times that range (107.174 ms).
The fixture uses one real sidebar, three preloaded local pages, discarded fixture
tabs and one control/seed tab. It checks mute/DOM agreement, identities, ordering,
active state and no live-page reloads. Audible ancestor counts are covered by
functional parity tests; this workload does not measure media decoding. The
100-tab CPU result and DOM/next-frame timings did not clear the noise gate.

The standard three-pair screen and five-pair confirmation covered 1,000 native tabs
across two sidebars and the existing 100/1,000/10,000 synthetic cases: no calibrated
regression flags among 292 metrics. Sparse metadata screening also had no flags.
A small consistent adverse observation remains visible: collected Firefox heap
after view cycles was 28,864 bytes higher (0.107%), within its 426,512-byte A/A range.
The source adds no retained per-record collection; this is not a demonstrated
memory regression or benefit. Small synthetic heap increases are separate Node
measurements, not Firefox RAM. DOM/next-frame observations are not exact paint.

Formatting, lint and 568 unit tests passed, plus 18 affected UI and seven native
Firefox suites, including direct sidebar Finder and the extension-page Find bar.
The tested production fingerprint is
`a5a8659f07324138e6c5e6cf988db671813ce1a41f1034373cdcdd7364e0180b`.
The unchanged 3 GiB benchmark and existing functional guards were retained.

Evidence is under `test-results/memory/independent-performance/`: `exp2b-final-aa/`,
`exp2b-final-confirm/`, `exp2b-standard-screen/`, `exp2b-standard-confirm/`,
`exp2b-metadata-screen/`, `exp2b-functional/`, `exp2b-check-final.log` and
`exp2b-precommit-proof.json`. Earlier diagnostic reports remain separate; two
whitespace-only lint fixes prompted fresh matching targeted calibration and
confirmation. The production candidate did not change between those runs.

The reusable targeted runner is `scripts/benchmarks/audio/audio-runner.mjs`, with
`screen|calibrate|confirm OUTPUT [BASELINE=HEAD] [NOISE_REPORT]`. Confirmation needs
a matching, complete five-pair A/A report no older than 24 hours. It freezes and
fingerprints sources, diagnostics, fixture, dependencies and runtime, fixes native
workloads at 100/1,000 tabs, and stops the batch on resource limits or failures.
Routine regression measurements still use `npm run benchmark:optim`.
