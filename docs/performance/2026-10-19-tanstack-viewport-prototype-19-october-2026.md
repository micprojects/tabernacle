# TanStack viewport prototype: 19 October 2026

The `optim-tanstack` branch retains this experiment at Michael's request even
though it has **not demonstrated an overall performance improvement**. Its base
is `optim` at `b773d42`. It is a development foundation, not a release-qualified
replacement for that branch. No storage format, controller, extension identity,
permission, version or build pipeline changes are involved.

`extension/src/tree-viewport.js` adapts TanStack Virtual Core 3.19.6 to the existing
nested tree. TanStack owns offsets, visible ranges, overscan, scroll observation
and indexed scrolling. Tabernacle still owns row construction, nested branches,
guide spacers, keyboard navigation, search, animation and interaction retention.
Rows keep their own stable item identity; they are not reassigned to unrelated
tabs. Focused controls and owners of presses, menus, drags and outgoing animations
stay attached. Deep representative rows preserve horizontal scroll extent.

Virtualisation applies above 100 logically visible rows. Small trees, Domain
views and searches containing Saved results use the existing full renderer;
those latter layouts need separate variable-height work. Tabernacle search still
uses the complete logical projection. Native Firefox Find cannot discover
unmounted rows and is deliberately outside this experiment's requirements.

The five upstream ESM files, their source maps and MIT licence are vendored
unchanged under `extension/vendor/tanstack-virtual-core/`. `provenance.json`
records the official archive, integrity, release source and file hashes, verified
by `test/vendor.test.js`. Our build does not bundle, minify or transpile them.
The upstream JavaScript is compiled from TypeScript; its maps retain that source.
`virtual-environment.js` supplies the upstream production diagnostics flag.
Review the included notice and Mozilla's third-party-library requirements before
any submission; this experiment does not establish the appropriate AMO form
answer or guarantee review approval.

The standard three alternating screening pairs completed with Firefox 158,
Node 24.19.0, 1,000 native tabs across two real sidebars and the usual
100/1,000/10,000-tab synthetic cases. Median observations were:

| Native metric                          |   `optim` | Prototype | Change |
| -------------------------------------- | --------: | --------: | -----: |
| Idle DOM elements across both sidebars |     6,440 |       810 | -87.4% |
| Added collected extension heap         |  18.70 MB |  10.70 MB | -42.8% |
| Added idle extension resident memory   |  70.30 MB | 110.46 MB | +57.1% |
| View-and-scroll extension CPU          |  3,900 ms |  4,461 ms | +14.4% |
| Sampled extension-process RSS peak     | 429.46 MB | 613.78 MB | +42.9% |
| Exact-search next-frame response       |     14 ms |      6 ms | -57.1% |
| Broad-search next-frame response       |     19 ms |     12 ms | -36.8% |
| Search-clear next-frame response       |     12 ms |     11 ms |  -8.3% |

These are **uncalibrated screening observations**, not confirmed timing or RAM
improvements/regressions. All three pairs had the same direction for the DOM,
heap, resident, view CPU and exact/broad search observations. Collected heap is
retained allocation after forced collection, not ordinary RAM. Search response
times observe animation-frame callbacks and forced tree layout; they are not
screen-paint measurements. Both revisions receive identical complete physical
scroll traversal to verify row order and titles. Phase CPU therefore includes
that workload and its correctness observations; initial-phase CPU is not cold
first-paint latency. Resident measurements also reflect that traversal history.
The synthetic fixture tests the unchanged controller, not viewport rendering.

No five-pair A/A calibration or confirmation was run: the screen does not support
promoting this prototype as an overall optimisation. Retaining the code is an
explicit exception to the normal keep/discard gate, not a relaxed performance
standard. Raw reports, all samples and frozen sources are in
`test-results/memory/tanstack-2026-10-19/screen/`. The tested candidate extension
fingerprint is
`ee3dcfd0bceafc36fcac4f2e17e906e149b30c38cba0b5833f024d6c595fa1ae`;
the subsequent source-provenance URL correction does not change executable code.

Regression coverage includes complete 1,000-row traversal, offscreen search and
metadata, close identity, Home/End/arrows/Tab, focused-control attachment,
fold-animation ownership, narrow/wide sidebar geometry, light/dark/forced colours,
deep horizontal scrolling, listener counts, hidden views and pane restoration.
Final validation passed `npm run check` (613 unit tests), all 40 registered UI
suites, and the native Firefox drag and tab-close suites. An unsigned archive was
also built with the existing packaging method into the local scratch directory;
all packaged JavaScript and vendor files matched their source bytes.
The new suite is `node scripts/test-viewport-ui.js`. Native Firefox drag and
tab-close suites cover real sidebar scrolling, focused controls, closing, parent
promotion and undo. Manual screen-reader testing, touch, the full native suite,
upgrade/restart qualification and exceptional capacity tests remain outstanding.
Native Find tests remain available for the full renderer; their large-tree
expectations are deliberately incompatible with this prototype.

The adapter is about 485 lines, with roughly 606 net additional authored
production/CSS lines overall. It also relies on TanStack's adapter lifecycle
methods and measurements array; upgrades need parity tests. The full renderer
remains necessary for the fallbacks, so this is not yet a maintenance reduction.
Further work should profile allocation and garbage collection during scrolling,
then reduce repeated reconciliation and projection work. Re-run the bounded
screen and a matching calibration/confirmation before claiming an improvement.
