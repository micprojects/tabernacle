---
name: tabernacle-release
description: Prepare, confirm and publish a Tabernacle Firefox extension release, with an optional exact version, release QA, a version commit, annotated Git tag, push and Mozilla web-ext submission. Use when Michael explicitly invokes Tabernacle Release; creating or discussing this skill is not a release request.
---

# Tabernacle Release

Release the Firefox extension in the checkout containing this project skill.
Resolve the root with `git rev-parse --show-toplevel` from this skill's directory;
run commands from that root, never a remembered absolute path or another checkout.
Follow the current `AGENTS.md`. When present, read `output/docs/testing.md` and
`output/docs/benchmarks.md` for additional validation guidance. These ignored local
documents are absent from fresh clones: use the setup and release gates below,
the maintained `scripts/release-qa.js`, `scripts/qa-suites.js`, and affected tests
instead. Disclose missing local guidance and resolve any unknown required coverage;
do not waive tests or copy machine-specific evidence into the skill.
Keep release records in
`output/scratch/releases/<version>/<attempt>/`, not tracked documentation.

Defaults: next patch version, branch `main`, remote `origin`, annotated tag
`v<version>`, existing AMO add-on `tabernacle@michaelprojects.com`, public `listed`
channel at `https://addons.mozilla.org/api/v5/`. Verify the repository remote is
`micprojects/tabernacle` on GitHub; do not infer a different publishing target.

## Invocation and version

This skill is explicit-only. An invocation authorises local preparation. It does
**not** authorise committing, tagging, pushing or submitting before the confirmation
below. Discussing, creating or editing this skill does not invoke it.

- `$tabernacle-release`: propose the current project version with its patch number
  incremented by one. Do not choose a minor or major release on your own.
- `$tabernacle-release 0.3.0`: use that exact version. Accept an optional leading
  `v`, then use plain `MAJOR.MINOR.PATCH` in all version files.
- An explicit version equal to the current version means resume that prepared
  release. Inspect what is already built, committed, tagged, pushed or submitted;
  do not bump again or make a redundant commit. For a tagged resume, the candidate
  is the original tagged contents; later changes on `main` are not included.
- Reject a lower version, an invalid version or disagreement between the package,
  lockfile and manifest. Do not silently select another version to evade a clash.
  If a previous attempt is unfinished and no version was supplied, identify it
  and clarify resume versus a new release before preparing another version.

## Establish the release

1. Read `git status --short`, the staged diff, branch, remotes, recent commits and
   local/remote tags. Review intended changes and new files. Preserve unrelated
   edits; resolve ambiguous commit scope before proceeding. Never stage everything,
   force-push, replace a published tag or automatically merge another branch.
2. Inspect the release delta, including unpublished commits. Select the required
   QA and upgrade coverage from the project instructions. Report the proposed
   current → target version, included changes and intended publishing destination.
3. Read [Mozilla submission](references/mozilla.md). Confirm that credentials are
   available and that this account can manage the existing AMO add-on using a
   read-only authenticated request or the Developer Hub. Check the target version
   including pending submissions. Public listing absence does not establish that
   a version has never been submitted. Resolve missing credentials or inaccessible
   submission state before changing version files; never test access by uploading.
4. If the version already exists on AMO, report its actual state and take no new
   submission action. A timed-out or interrupted earlier upload requires status
   reconciliation, not an automatic version bump or another upload. On a new
   release, reject conflicting local or remote tags. A matching tag on a resumed
   release is evidence to verify, not a conflict to overwrite. If the candidate
   differs from an existing tag, stop and require a new version; do not commit new
   release changes under that tag.

## Prepare a concrete release

On a fresh checkout, use the Node version in `.nvmrc` and run `npm ci`. Install
Playwright Chromium with `npx playwright install chromium` and make Firefox
available for the native suites; `FIREFOX_BINARY` and `GECKODRIVER_BINARY` can point
to local executables. The release helper needs Python 3.9+ and its standard library.
Configure credentials locally on each machine as described in the Mozilla reference;
they never travel with the clone. Run helper regression checks with
`python3 -m unittest discover -s test/release -p 'test_*.py'`.

For a new release, update only the version fields in `package.json`, the root and
root-package entries of `package-lock.json`, and `extension/manifest.json`.
Use targeted edits; do not use a version command that creates an implicit commit
or tag. Do not change dependencies, permissions, add-on identity, Firefox support
or README content as part of the version bump.

Use Node from `.nvmrc`, not whichever Node happens to be first in the shell.
Run `npm run qa:release`: it runs formatting, lint, unit tests, all registered UI
and native Firefox suites, and builds the package. Use
`npm run qa:release -- --stress` when the release changes performance or
large-collection behaviour. For this workload on macOS, set
`TABERNACLE_MEMORY_GUARD=1` in the process environment; other platforms use the
portable runner. Unsupported or resource-stopped checks are inconclusive, not
passes. For storage-affecting changes, include representative published-version
upgrade and reload checks under an isolated profile; preserve their stated coverage
limits. A failed or inconclusive gate blocks publication;
never lower guards, skip failed suites or automatically resume after a resource stop.
Fix an actual defect within the authorised scope, then revalidate the affected
checks and final release gate. Do not claim a gate passed from its build step alone.

The gate builds `dist/tabernacle-<version>.zip`. For a resumed release, reuse prior
QA only if its recorded source fingerprint, relevant tests/tooling and version
match the candidate and all required checks passed. Otherwise rerun the gate.
Verify that the ZIP contains exactly the intended extension files plus root
`LICENSE`, matches the candidate file contents, and omits generated/private files.
Record the ZIP SHA-256, source fingerprint, QA report path and intended commit paths.

For first preparation, preserve a copy of this ZIP and safely extract it into a
new release-specific `signing-source/` directory. To continue an earlier upload,
reuse its original approved signing source and upload state instead; do not replace
it with a fresh extraction. Reject absolute paths, traversal, duplicate entries
and symlinks before extraction. Compare extracted paths and bytes with the ZIP;
keep submission metadata, logs and records outside `signing-source/`. The CLI
continuation file `.amo-upload-uuid` is an exception: preserve it there and verify
that it is excluded from the package.
Do not pick an archive by modification time or a wildcard for “latest”.

Draft concise public release notes from the actual changes, plus reviewer notes
only when needed. Prepare both before asking for release confirmation, using the
minimal version metadata described in the reference. Do not rewrite the AMO
listing, licence, compatibility or other listing metadata incidentally.

## Confirm once, immediately before committing and publishing

After preparation, present a compact review containing:

- Current → exact target version, or the remaining steps of a resumed release.
- Included changes, explicit commit paths and any existing unpublished commits.
- QA result and verified ZIP link/hash.
- **Public release notes:** the exact complete text to be sent, with its locale.
- **Reviewer notes (Mozilla only):** the exact complete text if any will be sent;
  otherwise explicitly state **None — no reviewer notes will be sent.**
- Exact branch/remote, commit message, annotated tag and existing Mozilla add-on.
- The remaining actions: commit, tag, push, then submit through `web-ext` to the
  public listing. Mozilla may make the update available after validation/review.

Include both notes fields inline in the first release-plan message that asks for
confirmation, alongside the actions to be performed. A summary, a file link alone,
or a preview after approval is insufficient. If multiple release-note locales are
being submitted, show every locale's exact text. The prepared metadata must match
this preview; “None” means omit reviewer notes, not send that word to Mozilla.

Ask an explicit “Proceed with this release?” and wait for an affirmative answer.
Explain that this confirmation is required by this skill at Michael's request;
link this SKILL.md and quote “An invocation authorises local preparation.”
An invocation, an unanswered prompt, a preselected answer or approval for a previous
release is not confirmation of this release. If declined, leave the prepared files
and explain their state; do not discard anyone's edits automatically.

This approval covers the exact plan through submission: do not ask again at each
step. Any change to either notes text after approval requires showing the revised
text and obtaining confirmation again. If the version, included code, destination
or publishing behaviour materially changes, prepare and validate the revised result
before confirming it.

## Commit, tag, push, submit

1. Recheck the approved file contents, archive hash and remote state immediately
   before mutation. Stage explicit reviewed paths; inspect `git diff --cached
--stat` and run `git diff --cached --check`. Confirm that the project's forbidden
   generated output directories contain no tracked files.
2. Commit the approved changes as `Bump to <version>` and create annotated tag
   `v<version>` with message `Release v<version>`. For a resumed release, verify
   and reuse matching existing commits/tags. Never move an existing release tag.
3. Push branch and tag together using `git push --atomic origin main
refs/tags/v<version>`. Verify the remote branch and peeled annotated tag point
   to the intended commit. On a resume, omit already-completed commit/tag/push
   actions after verifying their results. If `main` has since advanced, verify
   that it still contains the tagged commit; never reset it to that release.
   Do not upload if a required push fails or the release tag disagrees.
4. Verify that the tagged extension files and root licence match the approved
   package and signing directory. Check AMO target-version state again, then use
   the installed official CLI exactly as described in [Mozilla submission](references/mozilla.md).
   Make one initial invocation after this release's confirmation and verified
   push. A continuation is allowed only after the reference's authoritative
   reconciliation and within its single-continuation limit.
5. Record the commit, tag, source and archive hashes, submission identifiers and
   actual AMO state. Preserve CLI state files for a possible continuation.

If interrupted, reconcile Git refs and AMO state before continuing. Do not undo
published refs, retry an ambiguous submission, delete its state directory or change
version to get around a duplicate. If authoritative state cannot be established,
report what completed and what remains uncertain, and stop external mutations.

Return the version, commit/tag links, ZIP link and submission/developer URL. Say
whether it is uploaded, awaiting review, approved or publicly available based on
observed evidence. A zero CLI exit or a Git tag alone does not mean users have
received the update.
