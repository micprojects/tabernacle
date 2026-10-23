# Unified filtered tab rows: 21 October 2026

Search and domain lists now use the same viewport threshold and fixed tab heights as the
main tree. A matching Saved tab or empty folder no longer forces every result into the DOM.
Saved search results keep their labelled section, with its 34 px heading represented in
geometry but excluded from keyboard navigation. Section siblings have their own ARIA positions;
focused and pressed rows retain their existing ownership. Dormant Saved rows remain subject
to the cache budget and closed tabs are evicted.

Tab titles use a single-line ellipsis in domain results, Saved searches, the Later pane,
new-tab lists and duplicate review. Full titles remain available to assistive technology and
in tooltips. Folder locations and last-viewed timestamps remain in result tooltips and accessible
descriptions. Empty search folders use compact folder rows without a drop placeholder, because
dragging is disabled during filtering. The optional website line remains available in the tree
and filtered results. No persistent format, identifiers, permissions or version changes are involved.

The bounded targeted benchmark compared `8a790c381939c6717b4a066336d05a2acc8269b2` with
extension fingerprint `296103fa6faaa8b936afdf345e3374a4626b7b3e10320d4a1a520590aaf4a901` on
Firefox 158.0 and Node 24.22.0. Each fresh profile contained 1,000 discarded fixture tabs and
one sidebar. Each scenario performed 20 narrow/broad search cycles, followed by complete
physical result traversal. Extension CPU was the predeclared primary measure; frame response,
natural memory, collected memory and DOM counts were reported separately. It reused the normal
resource guards and did not run concurrent test loads or escalate to a stress workload.

After a promising three-pair screen, five A/A calibration pairs and five alternating comparison
pairs demonstrated the following reductions. Every paired CPU result improved, exceeded 10%
and exceeded three times the full A/A range. The targeted comparison had zero calibrated
regression flags.

| Targeted extension CPU per 20 cycles | Baseline median | Candidate median | Reduction |
| ------------------------------------ | --------------: | ---------------: | --------: |
| Empty matching folder                |       738.30 ms |        308.01 ms |     58.3% |
| Matching Saved result                |       729.53 ms |        331.37 ms |     54.6% |
| Domain results                       |       879.29 ms |        433.87 ms |     50.7% |

The broad-query samples mounted 33 of 1,000 tab rows in the first two scenarios and 29 of
999 domain rows. This reduced DOM elements by about 93%. Input-to-following-frame p95 and
ordinary resident memory did not demonstrate improvements; CPU reductions must not be described
as equivalent visible-latency or whole-browser RAM savings. The lower final collected heap is a
separate post-collection observation.

Targeted evidence: `test-results/memory/search-viewport-2026-10-21/confirm/`; the successful screen
is in `screen-fixed/`. The earlier `screen/` stopped on a benchmark domain-navigation setup error
and provides no comparison. The supplementary harness and functional logs are under
`output/scratch/search-viewport-2026-10-21/`.

The standard `benchmark:optim -- --confirm` also completed five alternating pairs with
matching five-pair A/A calibration. All 298 metrics were reviewed: 226 had no demonstrated
change, 72 deterministic work measures were unchanged, and there were **zero calibrated
regression flags**. It used the unchanged bounded two-sidebar native workload and the
100 / 1,000 / 10,000-tab controller fixtures. Evidence is in
`test-results/memory/search-viewport-2026-10-21/standard/`.

Functional validation passed `npm run check` (651 unit tests), all 40 registered UI suites,
and the native Firefox smoke, domain, Later, collection, drag, tab-close, new-tab and Find
suites. New checks cover empty matching folders, mixed and all-Saved results, domain results,
full-render geometry parity, section ARIA, focus retention, keyboard boundaries and physical
traversal before bulk save/undo. Native Find retains the viewport limitation described above;
no manual assistive-technology, touch, stress or release/upgrade qualification is claimed.

After measurement, diff review restored the Later pane's header close glyph to its original
26 px size. This is the only extension difference from the frozen benchmark candidate;
search rendering, row styles and benchmarked execution paths are unchanged. Final exported extension
fingerprint: `28777597b742145bcc33c2e1f8a0968ed1d56acaf3605ea637961cad186df125`.
