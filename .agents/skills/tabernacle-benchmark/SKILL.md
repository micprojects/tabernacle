---
name: tabernacle-benchmark
description: Run reproducible Tabernacle version comparisons and generate a Markdown benchmark table for posting. Use when asked to benchmark the current branch, a commit or a tag against a release or older revision, or to produce a benchmark report. Routine optimisation experiments still use benchmark:optim.
---

# Tabernacle benchmark report

Use the maintained runner in this repository; read the **Benchmark reports for posting**
and **Optimisation benchmarks** sections of [DEVELOPMENT.md](../../../DEVELOPMENT.md)
for the command, measurement limits and evidence policy. Run from the repository root
with Node 24 from `.nvmrc` and the locked dependencies.

## Select versions

- Default old version: highest local stable release tag (`vMAJOR.MINOR.PATCH` or
  `MAJOR.MINOR.PATCH`), excluding prereleases. The command does not fetch; if current
  remote release discovery is needed, fetch tags without forcing/replacing local tags.
- Default new version: committed `HEAD` on the current branch. Do not silently include
  dirty files. A requested branch, commit or tag uses `--candidate REF`.
- Use `--baseline REF` for an explicit old version and `--working-tree` only when the
  user requests uncommitted work. Both sides are exported without switching branches.
- Preserve exact resolved commits and extension source hashes in the report. If there
  is no stable tag, ask for the intended baseline or resolve release tags; do not
  substitute HEAD. Incompatible historical code must be reported as unsupported/failed,
  never patched silently or treated as zero cost.

## Run

```sh
npm run benchmark:report
npm run benchmark:report -- --baseline v0.2.0 --candidate HEAD
npm run benchmark:report -- --baseline OLD_REF --candidate NEW_REF
npm run benchmark:report -- --baseline v0.2.0 --working-tree
```

This defaults to five alternating comparison pairs, first establishing matching
five-pair A/A noise if needed. It uses the existing bounded native and synthetic
workloads, isolated profiles and resource guards. Run sequentially; do not edit
benchmark code or run other tests/benchmarks concurrently. Do not close the user's
apps, raise limits, retry resource stops automatically or expand to stress workloads.

Each invocation reserves a fresh `test-results/memory/iteration/run-*/` directory
(or a fresh `--output DIRECTORY`) with frozen sources, `report.md`, `report.json`
and `report.html`. A stopped calibration is also reported at the run root. Setup
errors can occur before these reports exist; preserve the error and do not invent
results. Exit 2 means inconclusive; exit 1 means failed, neither means passed.

`--pilot` runs only the new version and is a diagnostic, not a comparison.
`--synthetic-only` gives no Firefox evidence. Use these only when the user wants
that narrower diagnostic or a blocker prevents the full requested run, with the
limitation clearly stated. `--help` lists all options.

## Deliver

Read the final JSON status, source identities, comparison verdicts and worker
failures, then return the generated Markdown tables and link the saved report.
Lead with the generated Headline results table (at most five rows) before the
detailed tables. Keep its fixed measures even when they worsen or show no
demonstrated change; do not select only the largest improvements. Include the
nearby workload/scope notes and the counts of Firefox and synthetic regression
flags, so a GitHub discussion comment does not conceal adverse results outside
the headlines. Do not infer whole-browser RAM, click-to-screen speed or battery
life from these measurements. Synthetic-only and incomplete runs have no native
headline comparison.

Keep the detailed fixed metric selection and all additional regression flags. Columns are
metric, old value, new value, and absolute/percentage difference with assessment.
Use unsigned percentages rounded to whole numbers and explicit direction. A
demonstrated reduction reads, for example, `Improved 93% (28 ms less time)`;
regressions and unproven changes retain their assessments. Timing reductions mean
less time, not percentage increases in speed. Keep raw measurements and verdicts
unrounded, including when the displayed percentage rounds to 0% or 100%.
Include workload/runtime/machine context and measurement limitations when posting.
Relative evidence links need accompanying files or updated destinations elsewhere.

Do not rewrite noisy reductions as improvements, suppress regressions, combine
Node heap with Firefox RAM, call collected heap ordinary RAM, or describe timed
settlement sequences as pure UI latency. Preserve N/A for absent comparisons and
percentages with nonpositive baselines. Correctness rows cover the benchmark fixture,
not complete release QA or upgrade safety. Generate the report locally; posting to
an external service requires the user's instruction.
