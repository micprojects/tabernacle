# Tabernacle project guidance

Tabernacle is a published Firefox extension. Protect existing installations and
their data in every change. Development documentation is kept locally in the
Git-ignored `output/docs/` directory and is not included in fresh clones.
Detailed current ownership contracts live in
[output/docs/architecture.md](output/docs/architecture.md); testing and benchmark procedures live in
[output/docs/testing.md](output/docs/testing.md) and [output/docs/benchmarks.md](output/docs/benchmarks.md).
Dated experiments in `output/docs/performance/` describe historical source layouts.

## Data and compatibility

- Preserve folders, hierarchy, ordering, tab membership, containers, pins and
  settings except where the requested behaviour deliberately changes them.
  Compatibility with existing installations is a core requirement.
- Keep the add-on identity, storage keys and durable identifiers stable. Changes
  to stored formats require an explicit migration approach and tests using
  existing data, including interrupted migrations and retries.
- Never reset or overwrite stored data because a read failed, a structure is
  invalid or a version is unsupported. Preserve the records and surface the
  failure. Defaults for a new installation must not become recovery for a failed
  load of an existing installation.
- Feature removal may discard explicitly retired fields only. Preserve unrelated
  and unrecognised saved data; do not broadly purge storage as cleanup.
- Route persistent changes through the established controllers, serialised writes
  and recovery mechanisms. Preserve protection against concurrent windows,
  partial writes, interrupted operations and background restarts.
- Preserve retry safety, rollback and recovery records. A lost response must not
  duplicate an operation; a failed operation must not silently lose tabs, orphan
  folders or leave an inconsistent tree. UI refactors must not silently change
  persisted organisation.

## Product and design

- Maintain a compact, calm Firefox tab organiser with neutral colours, clear
  hierarchy, familiar controls and restrained motion. Use plain British English
  and specific action labels.
- Reuse existing components, design tokens and icons. Preserve keyboard access,
  visible focus, narrow-sidebar usability, dark mode, forced colours and reduced
  motion. Keep the interface responsive with large tab collections.
- Site-specific enhancements and page extraction remain retired unless explicitly
  requested again. Keep changes focused; avoid unrelated refactors and dependency
  churn during feature work or bug fixes.

## Validation

- For code changes, run `npm run check` and the relevant UI and native Firefox
  suites for the affected behaviour. Use the suite guidance in `output/docs/testing.md`.
  Documentation-only changes need formatting and diff checks, not browser tests.
- Changes to persistence, hierarchy, containers or destructive operations require
  coverage for failed reads/writes, partial completion, retries, restarts and
  multiple windows. Extend the affected tests where coverage is missing.
- Storage-affecting releases also require upgrade checks using representative
  data from a published version in an isolated Firefox profile. Verify preserved
  structure, identities, membership and settings after upgrade and reload; a
  fresh-install test alone is insufficient.
- Use `npm run benchmark:optim` as the default for performance and memory work.
  It compares HEAD with a frozen working tree using the bounded iteration workload.
  Read the optimisation benchmark section in `output/docs/benchmarks.md`: screen changes,
  reuse matching A/A calibration, then confirm promising changes with `--confirm`
  and the relevant functional suites before keeping them. Node heap is not Firefox
  RAM, and uncalibrated timing/memory differences are not demonstrated improvements.
- Larger workloads, including 60,000 tabs, are exceptions for a specific capacity
  question or an explicitly requested stress/release investigation. Do not run the
  old large matrix routinely during optimisation, automatically escalate a small
  run, or raise safety limits. Use the explicitly named `:stress` commands and
  record resource stops as inconclusive. Keep ordinary regression suites in place.
- Run `npm run qa:release` before preparing a release. Add the documented stress
  checks when changes affect large collections or performance.
- Do not weaken or delete tests merely to make a change pass. Update expectations
  only for intended behaviour changes. Report failures and checks that could not
  run; do not claim coverage or upgrade safety without evidence.

## Privacy and releases

- Limit permissions and external requests to the authorised feature. Do not add
  broad website access, page extraction or background requests incidentally.
- Use isolated temporary Firefox profiles and fixtures for development and tests.
  Do not use the user's everyday profile for destructive tests or reset their
  extension data to make a test pass.
- Signing, publishing, version changes and changes to supported Firefox versions
  are deliberate release work, not incidental parts of routine fixes. Follow the
  documented release process when that work is requested.
- Folder export is not a complete backup of tabs, settings or browser session
  state. Do not rely on it as recovery for changes outside its documented scope.

## Local outputs

- Use the existing repo-root `output/` directory (singular) for exploratory work.
  It is ignored by Git, ESLint and Prettier.
- Keep development documentation in `output/docs/`; do not commit it or recreate
  a root `DEVELOPMENT.md` or `docs/` directory.
- Put mockup images, generation prompts and mockup-only HTML or scripts in
  `output/mockups/<topic-date>/`.
- Put one-off scripts, investigation notes, plans, downloaded references and
  temporary reports in `output/scratch/<task>/`. Keep related files together.
- Keep profiling reports and recordings in ignored local output. Never commit
  them to the repository.
- Existing tools may continue using their ignored `test-results/`, `dist/` and
  `firefox/` directories for test evidence, build packages and test profiles.
- Do not create a parallel `outputs/` directory or put experiments in `design/`,
  `assets/`, `extension/` or the repository root. Old mockup paths remain ignored
  as a safeguard; use `output/` for new work.

## Files that belong in Git

- Keep application code in `extension/`, reusable tools in `scripts/`, tests in
  `test/`, and shared browser fixtures in `preview/`.
- `assets/` contains maintained app artwork and release/documentation screenshots.
  Keep their source records and reusable fixtures. Add assets there only when they
  are intentionally used by the product, documentation or screenshot workflow;
  exploratory designs stay in `output/`.
- Do not commit credentials, local agent state, machine-specific settings, logs,
  browser profiles, build archives or temporary files.
- Preserve existing local artifacts when removing them from Git tracking. Move
  them into `output/` without overwriting other work. Adding an ignore rule alone
  does not untrack a file already in Git.

## Before committing

- Inspect `git status --short` and `git diff --cached --stat`; review newly added
  files and images for relevance to the requested change.
- Stage explicit paths after reviewing them. Do not force-add ignored artifacts
  unless the user explicitly requests it.
- Run `git diff --cached --check` and the checks appropriate to the change. See
  `output/docs/testing.md` for the existing validation and screenshot workflows.
- Confirm `git ls-files -- output/ outputs/ design/mockups/ test-results/ dist/ firefox/`
  is empty. Keep unrelated work out of the commit.
