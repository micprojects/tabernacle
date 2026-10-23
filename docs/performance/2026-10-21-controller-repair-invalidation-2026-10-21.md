# Controller repair invalidation (2026-10-21)

Cold-read, structural-update and retained-heap profiles used the standard synthetic
10,000-tab, nine-window, two-reader fixture, with separate CPU and allocation-sampling
runs. These instrumented profiles locate work; they are not timing or Firefox RAM
comparisons. Cold reads spent substantial CPU in cloning and serialising records.
After readers closed, the largest sampled live allocations were native tab records
(6.3 MB), presentation copies (4.2 MB), memberships (3.2 MB) and ownership indexes
(1.7 MB). Most sampled allocations disappeared after controller disposal; this does
not establish leak freedom or identify the fixture's total heap as controller memory.

The retained change limits membership-repair invalidation to the native tab's window
when that native structure and identity-ownership generation are still current after
the write. Previously, a new identity had no published window owner yet, so a repair
cleared every window's resolved tree. Ownership still commits only after all repairs
settle. Structural events, changed ownership, disposal or unavailable lifecycle
events discard that evidence. A repair without evidence or a published owner retains
conservative global invalidation, as does an ordinary write with unknown ownership.
No saved format, write ordering or creation timing changes.

Comparison baseline is `optim` commit `7e1cfaf53f3792c3c92d628ea7ef72f17d9095c4`,
extension SHA-256 `bead957e8be52eebfed940fb261f543bb7dd31fd2e6184b36499e84b785f133e`.
Candidate extension SHA-256 is
`147dbf2e7f13cec9e42440d67e0a932120b00fab9d6044c5cddb5708b7491e12`.
The unchanged standard harness ran on Node 24.22.0 / Firefox 158.0 on the 16 GiB M1
Mac, with 1,000 native tabs across two sidebars and the 100/1,000/10,000 synthetic cases.
Three screening pairs, five matching A/A pairs and five fresh confirmation pairs
completed. Calibration and confirmation were separate bounded invocations.

| Confirmed metric, 10,000 synthetic tabs |     Before |     After | Reduction |
| :-------------------------------------- | ---------: | --------: | --------: |
| Create/close sequence                   | 155.063 ms | 77.743 ms |     49.9% |
| Sampled peak heap in that sequence      | 110.087 MB | 89.341 MB |     18.8% |

Both reductions exceeded 10% and three full A/A ranges, with improvement in every
pair. All 298 metrics were reviewed: two demonstrated improvements, 224 without a
demonstrated change, 72 unchanged work measures and zero regression flags. All forty
workers completed; peak owned-process RSS was 2,619,408,384 bytes. The 1,000-tab
sequence fell 10.5%, but did not exceed three A/A ranges and is not a demonstrated
improvement. Cold reads (241.1 to 239.0 ms), cold retained heap (62.85 to 62.84 MB),
reader-closed heap (43.706 to 43.699 MB) and all Firefox metrics showed no demonstrated
change. Sampled Node peak heap is not retained controller memory or Firefox RAM.

Two earlier prototypes were removed. Delaying a creation batch by one event-loop
turn demonstrated synthetic timing reductions but added a 30.3% small-fixture heap
peak regression; a supplementary native creation screen showed no timing/CPU benefit.
Removing redundant object-rest copies did not produce a promising timing improvement.

Evidence is under `test-results/memory/controller-profile-2026-10-21/`:
`repair-standard-screen/`, `repair-standard-calibration/`, `repair-standard-confirm/`
and `repair-functional/`. Profiles, rejected patches and investigation scripts are
under `output/scratch/controller-profile-2026-10-21/`. The test for an untouched
1,996-tab window observes 7,568 tree-key lookups on the baseline and zero on the
candidate; snapshot contents remain identical. Partial repairs publish no ownership,
and an event during a pending repair exercises the global-invalidation fallback.

Validation passed `npm run check` (formatting, lint and 663 unit tests), eighteen
affected UI suites and nine native Firefox suites: smoke, domain filtering, Later,
tab collections, move dialogs, containers, drag, close and new-tab behaviour. A
post-run export verifies that the functional checkout's shipped sources match
confirmation; `repair-functional/source-equivalence.json` records that comparison.
