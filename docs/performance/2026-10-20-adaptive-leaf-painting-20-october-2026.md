# Adaptive leaf painting: 20 October 2026

The subsequent comparison with `optim` exposed additional whole-browser CPU during the
folder and sidebar-reopening sequences. Both sequences include repeated full-tree scrolling
for authoritative content verification; their CPU totals are not pure action latency.

The follow-up retains TanStack, nested layout, row pooling and interaction ownership.
Leaf rows now use explicit `content-visibility: visible` and `contain: layout style paint`
only during gradual scrolling. Startup and large jumps retain Firefox's automatic
offscreen paint suppression. The existing deep-row overflow exception applies in both
modes. Painting follows the adaptive range policy: owner-only updates preserve it,
geometry resets return to startup behaviour, and full rendering or suspension clears
the extra class.

Startup retains twelve overscan rows and gradual scrolling retains twenty-four. Large
jumps request eight. Four- and six-row trials used more collected heap after sidebar
closure; the twelve-row intermediate confirmation retained a reopening extension-CPU
flag. Eight rows was the best candidate from the adjacent settings. These trial observations
are selection evidence, not independently calibrated performance claims.

Controller and snapshot-allocation prototypes remain exploratory and were not adopted.
Sparse Node heap samples were sensitive to source and GC timing, including different
peaks for unchanged code at the same execution path. An identical-path control did not
eliminate the original difference, so path alone does not explain it. Collected Node heap
remained effectively unchanged; this neither proves lower peak allocation nor turns Node
heap into Firefox RAM. The detailed investigation and rejected variants are preserved in
`output/scratch/regressions-2026-10-20/`.

The retained extension source fingerprint is
`0e4819232a42dc8df9d062b92f874d1674fc36f01d9b4ffc805636a9472f4f0b`.
The five-pair scrolling confirmation against `efa1b5dc`, with matching five-pair A/A,
completed with no timing or RAM regression flags:

| Scrolling measure                   | Starting TanStack | Adaptive painting | Assessment             |
| ----------------------------------- | ----------------: | ----------------: | ---------------------- |
| Gradual-scroll extension CPU        |         654.78 ms |         654.89 ms | No demonstrated change |
| Jump extension CPU                  |       1,320.65 ms |       1,251.76 ms | No demonstrated change |
| Jump whole-browser CPU              |       4,768.57 ms |       4,430.80 ms | No demonstrated change |
| Gradual/jump frame-interval p95     |          18/18 ms |          18/18 ms | No demonstrated change |
| Sampled extension-process RSS peak  |         295.93 MB |         295.83 MB | No demonstrated change |
| Unforced RSS 30 seconds after jumps |         249.04 MB |         265.45 MB | No demonstrated change |

The smaller jump CPU readings did not clear the acceptance gate. The higher idle RSS
median was not consistent in every pair: baseline values ranged from 248.55 to 270.19 MB,
and candidate values from 248.56 to 269.71 MB. This does not demonstrate a lower RSS floor.

Eight count flags remain visible: after jumps and at the subsequent three memory stages,
mounted rows increased from 35 to 58 and document elements from 420 to 558. The workload
ends with a partial viewport movement; the adaptive policy can retain its wider gradual
buffer. These connected-node counts remain within the existing 48-spare-row policy and
separate 96-dormant-view budget. No timing or RAM regression accompanied them in this
confirmation. Evidence: `test-results/memory/regression-fix-2026-10-20/scroll-final/`.

The final standard comparison against `optim` (`b773d42be64b`) completed five
alternating pairs with matching five-pair A/A calibration and the unchanged
maintained harness. It reports 15 demonstrated reductions (nine memory reporters
and six descriptive DOM counts), 210 metrics without demonstrated change,
72 unchanged deterministic work measures and one synthetic regression flag.
There are no Firefox regression flags.

| Standard native measure                | optim median | Adaptive painting | Assessment                 |
| -------------------------------------- | -----------: | ----------------: | -------------------------- |
| Idle extension-process RSS             |    306.25 MB |         299.06 MB | No demonstrated change     |
| Sampled extension-process RSS peak     |    435.57 MB |         432.23 MB | No demonstrated change     |
| Idle collected heap                    |     27.20 MB |          18.85 MB | Demonstrated 31% reduction |
| Collected heap after three view cycles |     28.42 MB |          20.02 MB | Demonstrated 30% reduction |
| Added collected heap after closing     |      3.04 MB |           2.99 MB | No demonstrated change     |
| Folder-action extension CPU            |  4,056.06 ms |       4,111.92 ms | No demonstrated change     |
| Folder-action whole-browser CPU        |  8,811.64 ms |       9,099.81 ms | No demonstrated change     |
| Sidebar-reopening extension CPU        |  1,022.25 ms |       1,055.64 ms | No demonstrated change     |
| Sidebar-reopening whole-browser CPU    |  2,372.61 ms |       2,410.05 ms | No demonstrated change     |
| Warm snapshot reply p95                |         2 ms |              2 ms | No demonstrated change     |

The folder and reopening whole-browser CPU gaps are now approximately 3% and 2%,
compared with approximately 18% in the preceding `optim` versus starting-TanStack
report. Those are separate comparisons, not a calibrated percentage improvement
against the starting TanStack commit. Collected heap improvements against `optim`
remain demonstrated, but ordinary RSS and sampled peak RSS do not. The folder and
reopening totals still include the harness's content verification and settlement.

The remaining flag is the 100-tab Node create/close sampled heap peak: 8.644 to
10.474 MB, a 21% increase. Collected heap after the same burst is 7.302 MB on both
sides. The 1,000- and 10,000-tab synthetic cases have no regression flags.
Investigation found GC-sensitive sampling, but did not establish a complete
explanation or a production fix for this warning. It remains visible; it is not
evidence of higher Firefox RAM, and the work does not claim that every memory
regression is resolved.

Standard evidence: `test-results/memory/regression-fix-2026-10-20/retained-vs-optim/`.
Its generated Markdown retains the fixed headline and detailed metric selections.
The similarly named `final-vs-optim/` directory is the rejected twelve-row
intermediate comparison, not the selected eight-row result. Both final comparisons
completed all ten runs with the normal guards and matching source/harness hashes.

The selected source passed `npm run check` (644 unit tests, formatting, lint and
extension lint), the viewport suite and ten other affected UI suites, and the
native Firefox smoke, drag, tab-close and find suites. Four additional native
Firefox pixel comparisons matched full rendering exactly for light/dark mode
and jump/gradual scrolling. These cover the affected behaviour, not full release
or upgrade QA. Validation logs and source verification are under
`output/scratch/regressions-2026-10-20/`: `retained-check.log`,
`retained-viewport.log`, `functional-final/`, `native-pixels-final/` and
`final-verification.json`. No storage, identity, dependency or benchmark changes
were required.
