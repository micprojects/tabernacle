# TanStack allocation investigation: 19 October 2026

This follow-up starts from `70fe951` on `optim-tanstack`. Michael again requested
that the work be retained and committed regardless of its performance result.
The existing build, upstream library bytes and persistent data remain unchanged.

The guarded native profiling tool is:

```sh
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-before 70fe951
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-after
node scripts/benchmarks/viewport/summarise-profile.mjs output/scratch/profile-after/profile.json output/scratch/profile-after/summary.json
```

Choose fresh output directories; their parent must exist. The tool freezes source,
instruments tab/wrapper construction, opens its own Firefox profile with 1,000
discarded tabs and records six alternating full scroll passes. It uses the normal
3 GiB/five-minute guard, validates complete row order, captures Firefox JavaScript
allocation samples and GC markers, and cleans up its browser. All profiles remain
local. Instrumentation changes allocation and timing behaviour: use this tool for
diagnosis, and `benchmark:optim` without profiling for performance decisions.

In the original recording, 318 scroll steps built 5,328 tab rows and 5,808 wrappers.
There were 9,693 sampled JS allocations (498,384 sampled bytes), and 10 minor
collections with 6.89 ms total recorded duration. No major collection was recorded
in that interval. Cache cleanup, iterator/entry arrays and child reconciliation
dominated the sampled allocation sites; TanStack's core was a small part of them.
This does not establish GC pauses as the main CPU problem. Selected DOM/style
reporters grew from 0.82 to 18.73 MB after scrolling, then returned to 0.81 MB after
forced collection. That is evidence of transient DOM retention in this fixture,
not proof of a persistent leak or exclusive attribution of resident memory.

The revised renderer avoids entry tuples and discarded sorting arrays in cache
cleanup, skips unchanged child reconciliation, shares the empty child list and
uses TanStack's cached indexes. It invalidates range extraction when interaction
ownership or geometry changes, rather than on every draw. Native `scrollend` is
enabled through TanStack's feature-detected fallback. The same diagnostic sampled
4,249 allocations (220,984 bytes, 55.7% fewer) and 5.70 ms of minor GC. Row/wrapper
construction counts remained unchanged; these sampled observations are not a
calibrated performance result.

An alternative that disables row `content-visibility` is reproducible with a
committed source ref and the optional third argument `--visible-rows`. It roughly
halved synchronous reflow markers in one diagnostic but nearly doubled style
markers and had higher sampled thread CPU. It is kept in the diagnostic tool,
not enabled in the renderer. Browser containment still benefits the overscan
rows even though the total mounted row count is already small.

A second frozen-copy variant, `--wrapper-pool`, retains up to 64 empty, detached
leaf-tab wrappers. It never reassigns row controls to another tab. After warm-up,
wrapper construction fell from 5,808 to zero, while tab-row construction stayed
at 5,328. Sampled thread CPU was 1,162.8 versus 1,192.6 ms (2.5% lower), sampled
JS allocation was 212,800 versus 220,984 bytes, and selected uncollected DOM/style
reporters were 16.88 versus 18.80 MB. This single instrumented observation does
not demonstrate an overall performance gain. The variant passed complete native
row-order traversal but has not undergone the full interaction suite or an
unprofiled paired benchmark. It remains in `scripts/benchmarks/viewport/variants.mjs`
for further experiments, disabled in the working extension. Run it with:

```sh
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-wrappers - --wrapper-pool
```

Reducing allocation alone does not remove browser work to build, style and attach
row controls. The short recordings also cannot exclude major/cycle collection
costs in longer sessions. A larger row-reuse or flat-positioning redesign needs
its own focus, listener identity, hierarchy, animation and layout qualification;
the results here do not justify that extra complexity as an assumed optimisation.

### Library findings

The [TanStack API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
supports retaining extra indexes through `rangeExtractor`, stable item keys,
native `scrollend`, tunable overscan and manual or observed row sizes. We use the
first three and keep overscan at 12. Reducing overscan alone risks blank frames
without eliminating construction over a complete scroll. Fixed-height tree rows
do not need per-row `ResizeObserver` measurement. The docs advise against adding
an animation-frame wrapper to resize observation without measured benefit; this
adapter leaves it disabled.

The [React adapter's direct DOM mode](https://github.com/TanStack/virtual/blob/main/packages/react-virtual/src/index.tsx)
avoids React renders by writing absolute row positions and container size.
Tabernacle already updates DOM directly, so that option is not available as a
switch in the core or an argument for introducing React. Flattening/absolutely
positioning the tree would need separate work on nested rails, folding animations,
horizontal overflow and interaction ownership. The
[dynamic example](https://tanstack.com/virtual/latest/docs/framework/react/examples/dynamic)
does show a possible future route for wrapped Domain/Saved layouts; it does not
remove those product-specific responsibilities.

| Candidate                                                                              | Relevant capability                                                             | Assessment for this investigation                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [udomdiff](https://github.com/WebReflection/udomdiff)                                  | Small keyed child-list reconciliation                                           | Its source still uses native insertion/replacement operations, and it does not build or retain row controls. It would need our focus/animation rules around it; no evidence that replacing the small reconciler fixes the measured DOM construction. |
| [morphdom](https://github.com/patrick-steele-idem/morphdom)                            | Patches one DOM tree against another, with keyed nodes and update/discard hooks | Could help a future row-template rewrite, but creating a target tree still allocates nodes. Our unchanged surviving rows already bypass rebuilding. Not added without a demonstrated benefit.                                                        |
| [FastDom](https://github.com/wilsonpage/fastdom)                                       | Batches DOM reads and writes                                                    | Potentially useful if a specific layout read/write loop is identified. It would add scheduling to synchronous focus/scroll paths and does not stop row allocation. No additional scheduler was introduced.                                           |
| [Lit Labs Virtualizer](https://github.com/lit/lit/tree/main/packages/labs/virtualizer) | Integrated rendering and measured layouts                                       | Requires a rendering migration, still removes/adds children, and its own documentation warns of prerelease/breaking API changes. It is not a low-risk mature drop-in for this nested renderer.                                                       |

TanStack's [Pretext example](https://tanstack.com/virtual/latest/docs/framework/react/examples/pretext)
precalculates wrapped text height from font and width. It does not address this
fixed-height tree's allocation problem; font/loading parity would need its own
investigation before using it in Domain/Saved results. No additional dependency
was added. None of the reviewed libraries supplies complete nested-tree focus,
animation, drag and accessibility semantics for this application.

### Follow-up benchmark results

Three alternating standard pairs against `70fe951` completed with the unchanged
1,000-tab/two-sidebar native fixture and 100/1,000/10,000 synthetic cases:

| Metric                                 | Previous prototype median | Revised median | Change |
| -------------------------------------- | ------------------------: | -------------: | -----: |
| View-and-scroll extension CPU          |                4,448.4 ms |     4,430.4 ms |  -0.4% |
| Idle extension-process resident memory |                 342.95 MB |      335.68 MB |  -2.1% |
| Added idle extension resident memory   |                 103.63 MB |       97.01 MB |  -6.4% |
| Added collected extension heap         |                 10.786 MB |      10.783 MB | -0.03% |
| Sampled extension-process RSS peak     |                 615.63 MB |      603.95 MB |  -1.9% |
| Exact-search next-frame response       |                     21 ms |          22 ms |  +4.8% |
| Broad-search next-frame response       |                     12 ms |          12 ms |     0% |

CPU changed direction across pairs; idle resident memory fell in each pair.
Neither primary metric met the predeclared 10% screening threshold, so this
candidate was not promoted to five-pair calibration/confirmation. There is **no
demonstrated CPU or RAM improvement**. Search callback timings remain coarse,
uncalibrated observations rather than screen-paint guarantees. In particular,
earlier sessions' search timings must not be combined into a new paired claim.
The code is retained at the user's request, independently of the performance gate.
Evidence: `test-results/memory/tanstack-churn-2026-10-19/screen/`; diagnostic
recordings and variant results are under
`output/scratch/tanstack-churn-2026-10-19/profile-{before,a,b}/`.

A separate three-pair comparison of the same revised executable source against
`optim` (`b773d42`) also completed:

| Metric                                 | `optim` median | Revised viewport median | Change |
| -------------------------------------- | -------------: | ----------------------: | -----: |
| DOM elements across both sidebars      |          6,440 |                     810 | -87.4% |
| Idle extension-process resident memory |      306.99 MB |               339.00 MB | +10.4% |
| Added collected extension heap         |       18.73 MB |                10.76 MB | -42.6% |
| Added idle extension resident memory   |       66.85 MB |                98.88 MB | +47.9% |
| View-and-scroll extension CPU          |     3,926.6 ms |              4,459.1 ms | +13.6% |
| Sampled extension-process RSS peak     |      435.34 MB |               609.71 MB | +40.1% |
| Exact-search next-frame response       |          22 ms |                   23 ms |  +4.5% |
| Broad-search next-frame response       |          20 ms |                   11 ms | -45.0% |

These too are uncalibrated screening observations. The primary CPU and resident
memory directions were adverse in all three pairs; the retained heap/DOM benefit
does not establish an overall improvement. No timing/memory acceptance claim or
merge to `optim` follows from either screen. Evidence:
`test-results/memory/tanstack-churn-2026-10-19/vs-optim/`. Both comparisons used
the unchanged benchmark harness, full physical traversal and the normal resource
limits; no stress escalation or resource-limit increase was made.

Resident totals include the extension process's Firefox runtime and the test
control extension. "Added" memory subtracts the disabled-extension baseline;
the 47.9% increase is this added cost, not a 47.9% increase in total browser RAM.

Both screens used candidate extension fingerprint
`774c66c926e5700a0395807efa39a90f45ff9f04d20af4b763775922ccfee1f1`.
Final functional validation passed `npm run check` (613 unit tests), all 40
registered UI suites, and the native Firefox drag and tab-close suites. These
exercise the revised renderer, not the optional diagnostic variants. No vendor
bytes, bundling/minification, permissions, storage format or release version
changed. Manual screen-reader testing, touch, full native/upgrade qualification
and exceptional capacity tests remain outside this follow-up's coverage.
