# Benchmark shutdown and refactor retries (2026-10-21)

The earlier shutdown stall did not recur in an unchanged, instrumented native
workload. A final process audit did identify a detached Firefox updater whose
command line referenced the first failed baseline's browser PID and temporary
profile. It had survived the watchdog and was waiting for elevation. That verified
test-owned process was terminated; the pending application update files were left
intact. This establishes that application update processing escaped the isolated
session, though the archived shutdown report lacks the exit timing needed to prove
the cause of the separate later stall.

Test sessions now pass `-first-startup` to skip pending updates before preferences
load, and explicitly keep `app.update.disabledForTesting` enabled during automation.
The startup behaviour is documented in
[Mozilla's startup code](https://raw.githubusercontent.com/mozilla/gecko-dev/master/toolkit/xre/nsAppRunner.cpp).
Only disposable test launches use these settings. The native smoke suite checks
the effective runtime update-disabled state. A pending update remained pending
through protected launches without spawning another updater.

The retained harness changes address two reproducible lifecycle gaps. Process
accounting now includes the detached worker's process group, retaining descendants
after an intermediate parent exits. An exited worker gets three seconds to drain
its output; inherited pipes that remain open trigger owned-group cleanup and an
inconclusive result instead of waiting for the workload's 60-second stall limit.
Reports record the exit separately. A successful result message alone is never
accepted as shutdown. Standard native comparisons also reject incomplete extension-process
RSS accounting. The existing pressure, RSS, worker and command limits are unchanged.
Tests exercise reparenting, exclusion of unrelated processes, preserved final
output and termination of an orphan that retains the worker's output pipes.

Both saved refactors were retried independently against `1d8e40f`, with baseline
extension SHA-256
`147dbf2e7f13cec9e42440d67e0a932120b00fab9d6044c5cddb5708b7491e12`.
Each completed three alternating pairs of the standard native/synthetic benchmark
and its targeted native workload. Node 24.22.0, Firefox 158.0 and the 16 GiB M1 Mac
were used throughout. The standard harness fingerprint is
`89449dc8b1355ba0785dca24c9cac5863ffb64b220621103f41b1b57a45949db`.
These comparisons include the watchdog fixes and precede the final startup-update
protection. That later launch change invalidates their calibration for future runs;
neither rejected application refactor was retained based on these measurements.

The sidebar candidate reused a validated index for activation, folding and scope
changes. Its targeted screen observed 7.5% lower activation CPU, 1.6% higher folding
CPU and 0.4% lower navigation CPU. Standard view-cycle CPU changed by -0.2%.
Some temporary Firefox memory readings looked promising, so five matching A/A
pairs were run before deciding. The 65.8 MB sampled extension-RSS peak reduction
was smaller than three times the 53.6 MB A/A range. The 33.4 MB activation explicit
memory reduction likewise failed against a 13.2 MB A/A range. All 75 targeted
metrics assessed with that calibration reported no demonstrated change. Collected
memory was essentially unchanged. The candidate was removed; its extension hash
was `f50e95b62d70b5516ddfde0570a69aef907a083b0b1fed26862173caad4d9a80`.

The drag candidate reused subtree and sibling work within each move plan. The
trusted-gesture screen observed 5.5% lower extension CPU and 0.8% lower elapsed time;
p95 preview response remained 5 ms. Targeted memory did not show a promising gain.
Standard folder-action and view-cycle CPU changed by +0.1% and +0.3%. The candidate
was removed because it did not clear the minimum improvement threshold. Its hash
was `b027f2b439e7df71461b558cd46ce12a0b5593ee9cd3295845587b1974bea958`.
Screening percentages are descriptive, not confirmed improvements. No five-pair
candidate confirmation was justified after screening and the sidebar calibration.

Functional checks passed on the exact candidates: sidebar formatting/lint and 666
unit tests, all 41 UI suites and 11 relevant native suites; drag formatting/lint and
668 unit tests, all 40 UI suites and the same 11 native suites. These cover smoke,
domain filtering, Later, tab collections, move dialogs, drag, closing, new tabs,
Find, containers and pinned folders. Neither production refactor is retained.
Final `npm run check` passed on the retained harness changes, including 665 unit tests.

After adding startup-update protection, all 11 native suites passed again. The
final standard pilot completed the native workload and all three synthetic sizes,
with 76 of 76 extension-RSS samples complete and a clean worker exit. No Firefox,
geckodriver or updater process remained; the pre-existing `pending-elevate` update
status was unchanged. This final harness fingerprint is
`b929ec72bf1d1e84a065bb9b6e9e50e385b27ef6917b9196e96a306066fe0685`.
The final shipped-source export matches the original baseline hash above.

Evidence is under `test-results/memory/benchmark-retry-2026-10-21/`: `harness-pilot/`,
`sidebar-screen-http/`, `sidebar-standard/`, `sidebar-calibration/`,
`drag-screen-order/` and `drag-standard/`. Together these contain 35 completed native
workers with complete RSS accounting. `update-isolation-pilot/` contains the final
launch-protection pilot. The two earlier fixture failures are also
preserved: Firefox rejected extension-created data URLs, then the drag fixture
incorrectly treated snapshot array order as display order. The corrected fixtures
use local HTTP pages and native tab indices, retaining complete row/state checks.
Logs, calibrated screen assessment, decisions and lifecycle diagnostics are in
`output/scratch/benchmark-retry-2026-10-21/`. The original prototype patches remain
in the earlier sidebar and drag scratch directories.
