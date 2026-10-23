# Bounded row reuse and leaf layout: 20 October 2026

This follow-up keeps TanStack Virtual Core and the existing nested tree. It combines
reuse of ordinary leaf views, direct presentation updates, a leaf visibility override
and an adaptive buffered range. The reference is `488e77d7`; the selected executable
fingerprint is `5f7e5b718838001ac1495072e94b1c18fb8bbffe9294534764ce5b985b9cb1ea`.
No dependency, vendor code, persistence format, add-on identity or release version changes.

### View lifetime and layout

Ordinary one-line leaf tabs can reuse a complete wrapper, row, label text node and close
button. Supplied favicons and container colours are supported. The pool excludes parent
rows, audio controls, Saved results and Domain views. Overlapping logical keys retain their
existing views. Departing idle views become available before entering rows are rendered;
free views are rebound to the new logical ID, including accessible names and transient state.

The free pool has a 64-view cap and shares the existing **96 dormant views per sidebar** with
the identity cache. Mounted rows and interaction owners remain separate. Full and two-line
views release unused pooled rows. Suspension and disposal clear the pool. The complete tab
model, projection and lazy geometry still scale with the logical collection; this change
bounds view reuse, not all extension memory.

Focus, selection, menus, drag/motion ownership and every active pointer protect views from
reassignment. Pointer ownership lasts through the queued click; a later press using the same
pointer ID cannot be cleared by an earlier release task. Owners missing from a new projection
also stay ineligible for pooling, so closing a tab externally cannot redirect its outstanding
control to another tab. New integration checks cover overlapping-pointer reassignment and removal between pointer
release and click. The overlapping-press check reproduced a reassigned control before the fix.

Compatible title, URL, activation and discard changes update existing presentation fields.
Shape changes use the established builder and focus-preserving replacement. Loaded favicons
survive unrelated updates and same-URL reuse. Replaced icons keep their error handlers on the
old span, isolating late failures; an already failed image gets a fresh attempt for a new owner.

Mounted leaf rows use `content-visibility: visible` with explicit `contain: layout style paint`.
TanStack already limits mounted rows, so this avoids a second visibility calculation while
preserving the previous containment and transparent-image rendering. Parent rows keep their
existing visibility behaviour. The existing deep-row overflow exception explicitly retains
`contain: none`. Removing containment indiscriminately failed the richer pixel checks and was
not kept.

The range policy requests **12 overscan rows at startup and after large jumps**, and **24
during gradual scrolling**. A jump moves the first visible index by more than half the visible
range. The existing buffer can remain in place while it covers the requested range; refills
use the selected budget. At most 48 spare rows are buffered, plus existing ancestor and
interaction/width owners. Owner-only invalidation preserves the selected policy, while
viewport-height changes, suspension and resets restart the initial policy.

A fixed 24-row buffer reduced refill CPU but raised the measured jump-frame p95 from 18 to
20 ms in every confirmation pair. Fixed buffers of 18 and 20 were also tried: 18 restored
18 ms p95 but increased jump CPU; 20 retained the 20 ms p95. Two adaptive pilots retained
18 ms p95 for both gradual scrolling and jumps, with no additional startup rows. These
parameter trials informed selection; they are not independently calibrated performance claims.

### Alternatives investigated

The investigation compared reference clearing, a larger identity cache, field patches,
bounded reuse, flat positioning, nested positioning, containment/visibility changes and
combinations of these, including supplied-icon fixtures and different scroll buffers.
Reference clearing and larger identity retention did not justify their additional work or
retention. Flat positioning produced mixed CPU results against the nested combination, with
no clear memory advantage. The existing nested ownership was retained. Native layout and DOM
work were prominent in the baseline profile; replacing the virtualizer or introducing a
rendering/scheduling library was not justified by that evidence.

Frozen variants, diagnostic profiles and guard results are under
`output/scratch/resource-optim-2026-10-20/`. The exploratory runs are not substitutes for the
maintained calibrated comparisons. In particular, row-construction counts, collected heap,
ordinary RSS and CPU time remain distinct measures.

### Functional validation

The selected extension files passed `npm run check` (644 unit tests, lint and formatting),
all 40 registered UI suites and all 15 native Firefox functional suites. The separate native
memory-benchmark smoke is covered by the maintained comparison workload. Native checks include
same-ID upgrade/reload preservation from `v0.2.0`, pointer dragging, newly mounted close targets,
containers, Saved for Later, mixed pins and native Find in the full-renderer/page fixtures.
They are not full release qualification or exceptional-capacity testing.

Additional viewport checks cover pool budgets, identity-correct actions, focus and menu
ownership, simultaneous presses, removal before click, row shape changes, loaded-image
preservation, late favicon failures and retry on reassignment. Adaptive-buffer checks cover
startup, gradual movement, jumps, owner-only invalidation, resumption and resets. Geometry and pixel comparisons
cover narrow views, light/dark/forced colours and transparent tinted icons with audio controls.
A separate native Firefox diagnostic matched the full renderer's pixels exactly in light and
dark mode after the fading scrollbar settled, with identical scroll geometry.

The native Find suite still depended on a DevTools bridge removed from its shared browser
fixture. Its evaluation helper now uses one-shot, document-bound frame calls; the existing
Find, selection, highlight, resume and navigation assertions are unchanged and pass. The
shared browser and benchmark helpers were left unchanged. This is a test connection repair,
not a product Find change.

Validation evidence is in `output/scratch/resource-optim-2026-10-20/adaptive-validation.json`.
The QA helper also fingerprints the workspace's ignored `.DS_Store`; the benchmark export
excludes it. All 128 exported extension files were compared byte-for-byte with the tested
working tree, so that metadata-only hash difference does not represent different app code.

### Fixed-buffer comparison and review findings

The fixed-24 predecessor, fingerprint `dbd9c146…`, completed both maintained five-pair
comparisons with matching A/A. Its standard sampled RSS peak fell 25.8% (601.03 to
446.04 MB). In the scrolling workload, extension CPU fell 44.2% during gradual movement
and 12.6% during jumps; whole-browser slow-scroll CPU fell 35.4%. Its jump-frame p95,
however, increased 11.1% (18 to 20 ms), clearing the regression gate. This prompted the
adaptive policy above. These figures describe the predecessor, not the retained source.

The standard predecessor comparison also flagged an additional 1.352 MB of collected
heap after disable and a Node-100 sampled-heap increase. Five synthetic follow-up pairs
with their own A/A did not reproduce the Node flag: medians were 10.475096 versus
10.475072 MB, with no regression flags across 168 metrics. All 27 application modules in
the synthetic workload's import closure were byte-identical between sources. Both results
are retained; Node heap is not Firefox RAM.

Separate full-path native diagnostics on the 12- and 24-buffer predecessors reproduced
small post-disable heap differences. Neither grew during an extra 15-second idle interval;
selected DOM/style totals remained 108,128 bytes, ghost windows were zero, and the optional
orphan-DOM category was absent. An absent category is not a measured zero. In the 24-buffer
diagnostic, non-window cross-compartment wrapper tables accounted for 0.213 MB of the added
difference. The complete heap difference was not attributed. Runtime/allocator retention is
a possible explanation, not a proven cause; these short checks do not establish leak freedom.

Predecessor evidence is under `test-results/memory/resource-optim-2026-10-20/` in
`final-confirm/`, `final-scroll-confirm/` and `final-synthetic-followup/`. The raw reports retain
all findings, including the larger mounted-row counts from the fixed buffer. Full-path
lifecycle diagnostics are in `output/scratch/resource-optim-2026-10-20/lifecycle-diagnostic/`
and `lifecycle-final/`. They have reporting overhead and do not replace the maintained results.

### Retained candidate: measurement scope

The retained-source comparisons use Firefox 158.0 and Node 24.19.0 on the 16 GiB M1 Mac.
Each compares five alternating A/B pairs against `488e77d7`, with matching five-pair A/A
calibration. The standard workload has 1,000 native tabs across two sidebars and the
100/1,000/10,000 synthetic cases. The separate scrolling workload has 1,000 tabs in one
sidebar, gradual movement, six complete jump traversals and fixed idle intervals.

A demonstrated improvement must exceed 10% and three times the full A/A range, with
the same direction in every pair. MB means decimal megabytes. RSS includes Firefox's
extension runtime and the control extension; it is not the memory of loaded web pages.
Peaks are sampled, and overlapping memory reporters must not be added together.
Whole-browser CPU omits processes absent from either snapshot. Frame intervals include
animation-frame scheduling and are not direct measurements of paint or input latency.

The retained source's standard confirmation completed with **12 demonstrated memory
improvements, 214 metrics without demonstrated change, 72 unchanged deterministic work
measures and zero calibrated regression flags**.

| Standard native measure                  | Baseline median | Retained median |    Change | Assessment                |
| :--------------------------------------- | --------------: | --------------: | --------: | :------------------------ |
| Sampled extension-process RSS peak       |       603.95 MB |       445.38 MB |    −26.3% | Demonstrated improvement  |
| Unforced RSS after closing both sidebars |       592.66 MB |       434.86 MB |    −26.6% | Demonstrated improvement  |
| Initial idle unforced heap allocation    |        52.94 MB |        33.10 MB |    −37.5% | Demonstrated improvement  |
| Initial idle unforced RSS                |       339.23 MB |       307.56 MB |     −9.3% | Below the acceptance gate |
| Folder-action extension CPU              |     4,336.33 ms |     4,296.30 ms |     −0.9% | No demonstrated change    |
| View-cycle extension CPU                 |     4,406.44 ms |     4,443.82 ms |     +0.8% | No demonstrated change    |
| Warm snapshot reply p95                  |            2 ms |            2 ms |        0% | No demonstrated change    |
| Added collected heap after final disable |        1.927 MB |        2.207 MB | +0.280 MB | Below the variation gate  |

The post-disable heap difference remains an observation, not a demonstrated regression:
0.280 MB is below three times the matched A/A range (0.494 MB). Absolute collected heap
medians were 10.409 and 10.661 MB. All ten final-disable samples had the same selected
DOM/style total, zero ghost windows and an absent optional orphan-DOM category. There is
no claim that every memory measure improves or that these bounded tests prove leak freedom.

Standard retained-source evidence: `test-results/memory/resource-optim-2026-10-20/adaptive-confirm/`,
with matching A/A under `baseline-calibration/calibration/`. The final source was not profiled
or instrumented during either maintained comparison.

The retained scrolling comparison completed with **18 demonstrated improvements** (two CPU
and 16 memory reporters), 64 metrics without demonstrated change and four count-review flags.
There were **no calibrated timing or RAM regression flags**.

| Scrolling measure                      | Baseline median | Retained median |  Change | Assessment                |
| :------------------------------------- | --------------: | --------------: | ------: | :------------------------ |
| Gradual-scroll extension CPU           |     1,187.23 ms |       671.25 ms |  −43.5% | Demonstrated improvement  |
| Gradual-scroll whole-browser CPU       |     5,287.38 ms |     3,405.17 ms |  −35.6% | Demonstrated improvement  |
| Jump extension CPU                     |     1,391.70 ms |     1,317.23 ms |   −5.4% | Below the acceptance gate |
| Gradual-scroll frame p95               |           19 ms |           18 ms |   −5.3% | Below the acceptance gate |
| Jump frame p95                         |           18 ms |           18 ms |      0% | No demonstrated change    |
| Unforced RSS after jumps               |       296.47 MB |       266.75 MB | −10.02% | Demonstrated improvement  |
| Unforced RSS at 10 seconds after jumps |       294.65 MB |       264.19 MB |  −10.3% | Demonstrated improvement  |
| Sampled scrolling RSS peak             |       297.14 MB |       295.67 MB |   −0.5% | No demonstrated change    |
| Unforced RSS at 30 seconds after jumps |       256.29 MB |       263.88 MB |   +3.0% | No demonstrated change    |
| Final collected RSS                    |       251.35 MB |       244.48 MB |   −2.7% | No demonstrated change    |

The four count flags are the expected larger mounted buffer after gradual scrolling and at
its 10-second idle sample: 34 to 59 tab rows and 414 to 564 elements. This remains within the
48-spare-row bound and the separate 96-dormant-view budget. Selected DOM/style memory at those
same stages fell 54.7%, from 1.449 to 0.656 MB. Startup tab-row counts matched at 34, and
post-jump counts matched at 35. The increased gradual-scroll buffer is retained because the
CPU saving is demonstrated while startup, jump timing and bounded ownership are preserved.

The 30-second unforced candidate RSS ranged from 248.09 to 266.31 MB, versus 256.25 to
259.78 MB for the baseline. Its higher median was not consistent in every pair and did not
clear the gate; final collected values are a separate measure. There is no demonstrated
lower settled RSS floor. Candidate frame outliers still reached 40 ms during gradual
scrolling and 78 ms during jumps; neither maximum showed a calibrated regression. The
work does not claim universally lower RAM, uniformly faster frames or absence of pauses.

Scrolling evidence: `test-results/memory/resource-optim-2026-10-20/adaptive-scroll-confirm/`,
with matching A/A under `final-scroll-calibration/calibration/`. All ordinary guards remained
in place, with no resource stops or exceptional-capacity runs. The retained choice is the
best tested balance here: bounded view reuse and direct patches, nested layout with explicit
leaf containment, and a buffer that expands for gradual movement without the fixed-large-buffer
jump-frame regression.
