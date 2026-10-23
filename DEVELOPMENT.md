# Development

Tabernacle is a Firefox extension with native ES modules and no runtime build step.
The unsigned build packages `extension/` and the root licence only.

## Start here

- [Architecture and ownership contracts](docs/architecture.md): module responsibilities,
  persistence, recovery, snapshots, rendering and feature behaviour.
- [Testing and release procedures](docs/testing.md): local setup, suite selection,
  browser fixtures, screenshots and unsigned builds.
- [Benchmark procedures](docs/benchmarks.md): bounded comparisons, calibration,
  resource guards and interpretation.
- [Performance history](docs/performance/README.md): dated evidence, including
  rejected and superseded experiments.

Use Node 24 from `.nvmrc` and the locked dependencies. Run commands at the repository root:

```sh
npm ci
npm run check
npm run preview
```

`npm run dev` loads the extension in a temporary Firefox profile. The preview uses
the shared in-memory browser adapter and does not access your everyday profile.

## Validation

```sh
npm run test:ui
npm run test:firefox
```

Run `check` and the affected UI/native suites for code changes. The suite catalogue
in `scripts/qa-suites.js` owns the executable paths and release coverage. UI suites
live in `test/ui/`, native suites in `test/firefox/`, and unit tests in `test/`.
See the [testing guide](docs/testing.md) for requirements and coverage limits.

## Release build

```sh
npm run qa:release
```

This runs the complete functional gate and creates an unsigned build. It does not
change versions, sign or publish. Follow the [release procedures](docs/testing.md#release-build)
for deliberate release work. Preserve add-on identity and existing saved data.

## Benchmark reports for posting

Use `npm run benchmark:report`; choose versions and interpret results using the
[reporting procedure](docs/benchmarks.md#benchmark-reports-for-posting).

## Optimisation benchmarks

Use `npm run benchmark:optim` for routine performance and memory work. Screen changes,
reuse only matching A/A calibration, then confirm with `--confirm` and the affected
functional suites. Read the [complete procedure](docs/benchmarks.md#optimisation-benchmarks)
before running. Node heap is not Firefox RAM; uncalibrated differences are not gains.
Stress workloads are exceptional and are not an automatic follow-up to a small run.

## Local files

Keep exploratory work under `output/`, test evidence under `test-results/`, packages
under `dist/` and owned Firefox fixtures under `firefox/`. These stay untracked.
See [AGENTS.md](AGENTS.md) for compatibility, validation and repository rules.
