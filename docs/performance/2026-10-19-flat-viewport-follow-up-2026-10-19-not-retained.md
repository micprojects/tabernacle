# Flat viewport follow-up (2026-10-19; not retained)

The follow-up prototype took the earlier flat-list diagnostic through functional validation,
including the visual and interaction behaviour that diagnostic omitted. It kept TanStack's
buffered range and lazy measurements, made steady-state rows direct tree children, and retained
focused, pressed, menu, drag and horizontal-width owners by their existing keys. It did not pool
or reassign controls. Search continued to use the complete logical projection.

The prototype restored continuous parent-coloured hierarchy lines, curved branch endpoints,
RTL and horizontal overflow, explicit tree ARIA position metadata, and insertion markers based
on logical sibling/subtree boundaries. It reused the existing nested viewport layout temporarily
for fold/unfold motion, including interrupted reversals and crossing the 100-row threshold.
State-preserving `moveBefore` moves kept live controls connected, with explicit scroll restoration
around the layout transitions. Engines without that API used the existing nested viewport path;
the Firefox minimum version and extension packaging were unchanged.

Functional testing exposed a further native-click risk: moving a row after `mousedown` but before
`mouseup` can suppress the subsequent click even when `moveBefore` preserves its focus and DOM
connection. The prototype deferred the return to flat layout until the press and click finished,
and prevented an older release task from clearing a newer press. A trusted mouse-event regression
and the existing rapid-toggle/double-click navigation suite passed with that fix. This distinction
is consistent with the narrower state-preservation guarantees documented for
[`Element.moveBefore`](https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore).

### Functional evidence and complexity

- `npm run check` passed, including 626 unit tests (four new logical drop-boundary tests).
- All 41 registered UI suites obtained passing results across the initial serial run and focused
  follow-ups. The initial full batch stopped at a real double-click regression; it was not a
  single clean full-batch pass. Subsequent failures in cold/performance tests were assertions of
  the old nested DOM shape, updated to verify actual child depth, expansion, focus and revealed
  controls. Behavioural assertions were retained.
- The final expanded viewport suite passed on the frozen candidate: flat DOM/order/ARIA,
  complete search, metadata, empty-folder/full-render fallbacks, reorder/shrink/resize, ownership,
  exact guide/pixel geometry in light/dark/forced colours and RTL, horizontal extent, fold exits,
  both reversal directions, threshold transitions, held presses and compatibility without
  `moveBefore`.
- The dedicated flat drag suite passed against independent full-render boundary geometry,
  including actual moves, hover expansion, Escape restoration, invalid cycles, pins, pointer
  capture and autoscroll. Native Firefox drag and tab-close suites also passed in isolated profiles.
- Manual assistive-technology announcements, touch devices, upgrade/release QA, all native suites
  and exceptional-capacity workloads were not qualified. ARIA and keyboard assertions are not
  a substitute for screen-reader testing.

The complete production prototype added **422 net lines**, including 131 lines in two new
modules and 87 CSS lines. It still needed the nested path for motion, compatibility and existing
full-render fallbacks. Smaller steady-state DOM alone does not justify that extra maintenance.

### Benchmark stop and retention decision

The requested standard screen against current TanStack (`cc5b4245d14e`) stopped **before its first
native worker launched**. The guard observed macOS pressure level 2 with 46% pressure-free memory;
the start rule requires normal pressure as well as at least 30% free. Exit status was 2,
**inconclusive**, with no complete samples and no comparison or regression verdict.

No CPU, resident-memory or responsiveness improvement was demonstrated. The standard comparison
against `optim` (`b773d42be64b`), targeted scrolling screens and A/A confirmation were not run after
this resource stop. Replacing the stopped batch with a different native workload would not cure
the environment problem. There was no automatic retry, guard change, stress escalation or closure
of user applications. Earlier incomplete flat diagnostics are not measurements of this corrected
prototype and cannot establish its performance.

The user required meaningful overall gains before retaining the implementation. Because that
condition could not be verified, **the production and test changes were restored to `cc5b424`**;
`optim-tanstack` keeps its existing TanStack renderer. This is an unqualified experiment, not a
finding that flat rendering is slower. The complete tested prototype remains locally preserved
for a new explicitly requested comparison when memory pressure is normal:

- `output/scratch/tanstack-flat-2026-10-19/final-prototype/`: frozen extension/package source.
- `output/scratch/tanstack-flat-2026-10-19/saved-changes/`: all 13 changed/new source and test files;
  `changed-files.json` lists them, and `tracked.patch` preserves the tracked diff.
- `output/scratch/tanstack-flat-2026-10-19/`: `check-final.log`, initial `ui.log`,
  `remaining-2.log` (performance passed before the cold assertion failure), `remaining-3.log`
  (cold/refresh/native passes), `viewport-final-4.log`, and `drag-2.log` retain validation evidence.
- `test-results/memory/tanstack-flat-2026-10-19/standard-current/`: stopped benchmark report,
  guard observations and frozen baseline/candidate sources. Other comparison reports do not exist.

Candidate extension SHA-256:
`1f6b257fa1b7f3efe75cea8243a5e6955655fec7e7ba33cb53f5c3ed94131642`.
Current TanStack/restored extension SHA-256:
`77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`.
Standard harness SHA-256:
`128672ebef79bf9919323f43028d8780e7c16ea6b7c6d90c9f09216c54bc3917`.
The stopped run used Firefox 158.0, Node 24.19.0 and Apple M1/16 GiB. Source hashes identify the
actual candidate; the shared base commit alone does not.
