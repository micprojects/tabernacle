# Local viewport geometry: 21 October 2026

At Michael's request, the viewport now uses local geometry and scroll observation instead
of TanStack Virtual Core. The vendored modules, maps, provenance, licence and production
environment shim are removed. `src/tree-geometry.js` calculates offsets and branch endpoints
in the existing row records. Two binary searches locate the visible range; unchanged ranges
reuse their result. Ancestor retention visits each retained row once, and scrolling within an
unchanged range does not query ownership or write DOM. A passive scroll listener and one
resize observer replace the general virtualiser's observation and scrolling machinery.

The nested renderer, adaptive overscan and painting, row pool, interaction ownership and full
rendering fallbacks retain their existing behaviour. Reveals and restores read the live native
scroll offset, including before a queued scroll event. Hidden updates resume through resize
observation. Persistence, identifiers, browser permissions and the supported Firefox version
are unchanged.

The retained extension fingerprint is
`94a1bc2729fc063b6b162fc15931d4127478a370f1a90964d7b35d7cd06a6acd`.
The standard benchmark against `7026b4bb7f7b` completed five alternating pairs with matching
five-pair A/A calibration on Firefox 158.0, Node 24.22.0 and the 16 GiB M1 Mac. All 298 metrics
were reviewed: **226 had no demonstrated change, 72 deterministic work measures were unchanged,
and there were zero calibrated regression flags**. No CPU or RAM improvement is claimed.

| Standard native measure               | TanStack median | Local median | Assessment             |
| ------------------------------------- | --------------: | -----------: | ---------------------- |
| Idle unforced extension-process RSS   |       301.96 MB |    291.47 MB | No demonstrated change |
| Sampled extension-process RSS peak    |       431.92 MB |    418.40 MB | No demonstrated change |
| Folder-action extension CPU           |     4,539.37 ms |  4,502.12 ms | No demonstrated change |
| View-cycle extension CPU              |     4,679.40 ms |  4,575.73 ms | No demonstrated change |
| Warm snapshot reply p95               |            2 ms |         2 ms | No demonstrated change |
| Added collected heap at final disable |        2.632 MB |     2.744 MB | No demonstrated change |

These are bounded workload results, not proof of leak freedom or universal responsiveness.
RSS includes the shared Firefox extension runtime and control extension. The initial
three-pair screen used Node 24.19.0 and was explicitly uncalibrated; its calibration was
correctly rejected because the Node patch version differed. Confirmation used the installed
24.22.0 runtime matching the cached calibration, with no harness or limit changes.

Standard evidence: `test-results/memory/own-viewport-2026-10-21/standard-confirm/`;
the initial screen remains in `standard-screen/`. Functional logs are under
`output/scratch/own-viewport-2026-10-21/`. The replacement passed 650 unit tests, all 40 UI
suites and all 16 native Firefox suites, including published-version same-ID upgrade/reload,
Find, drag, close and container checks. New coverage includes an independent geometry oracle,
logarithmic lookup at 10,000 rows, exact boundary/reveal behaviour, hidden updates and scrolls
without DOM writes. Existing light/dark/forced-colour pixel comparisons remain exact.

The supplemental scrolling screen completed three alternating pairs with the same source on
Node 24.22.0 and Firefox 158.0. Gradual and jump frame-interval p95 medians were 18 ms for both
versions. The replacement recorded no frame over 33 ms; one baseline jump frame reached 39 ms.
Gradual-scroll extension CPU
medians were 746.60 versus 677.70 ms, and jump CPU was 1,390.69 versus 1,393.69 ms. Peak sampled
extension RSS was 295.42 versus 294.67 MB. None of the 86 metrics increased by more than 10%.
This screen has **no matching scrolling A/A calibration**: these are descriptive observations,
not demonstrated CPU/RAM gains or a calibrated scrolling-regression verdict. The independently
calibrated standard confirmation above is the performance acceptance evidence for the removal.
Scrolling evidence: `test-results/memory/own-viewport-2026-10-21/scroll-screen/`.

The change removes approximately 246 kB (21%) of uncompressed extension source, including
vendored source maps. That is a file-size reduction, not a measured RAM saving. The retained
implementation is justified by the requested dependency removal, simpler ownership of geometry,
functional parity and the standard confirmation; it does not claim a general speed improvement.
