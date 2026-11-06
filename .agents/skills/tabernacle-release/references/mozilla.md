# Mozilla submission

Read this before checking AMO credentials or preparing a submission. Use the
repository's installed Mozilla `web-ext` CLI, not a third-party publisher or a
hand-written upload API implementation. Recheck its `sign --help` if the locked
CLI version changes; do not upgrade it incidentally during a release.

## Credentials and read-only preflight

Mozilla provides an API issuer/key and API secret at
[API credentials](https://addons.mozilla.org/en-US/developers/addon/api/key/).
The account must be an author of the existing Tabernacle add-on.

Use the tracked [`amo_credentials.py`](../../../../scripts/release/amo_credentials.py)
helper from the repository root. It resolves this checkout from its own location.
It requires Python 3.9+ with no extra Python dependencies; use the host's Python 3
command if it is named `python` rather than `python3`.

```sh
python3 scripts/release/amo_credentials.py status
python3 scripts/release/amo_credentials.py preflight VERSION
```

Replace `VERSION` with the exact target version. It uses authenticated GETs,
checks the existing add-on identity, and walks the author-only version list,
including pending/rejected/unlisted versions. It reports only a safe summary.
Credentials belong to the machine, not the repository. The helper uses a complete
`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` pair from its process environment first;
a partial or empty pair fails rather than mixing credentials from different sources.
Configure that environment through an existing local secret manager without
exposing the values in chat, command arguments, shell history or checked-in files.

On macOS, when neither variable is set, the helper reads the generic-password
Keychain entry with service `com.michaelprojects.tabernacle.amo`, account `release`.
This preserves the existing entry when the checkout moves. For a new Mac or an
explicit replacement, run `python3 scripts/release/amo_credentials.py setup`.
It opens native hidden-answer dialogs for the API key and secret, then saves and
verifies the pair together in Keychain. Cancelling either dialog leaves the stored
pair unchanged. Other platforms use the environment option; `setup` explains this
without invoking macOS APIs or creating a plaintext credentials file. If no local
secret manager is configured, ask for the user's preferred store before setting one up.

The helper passes the pair directly into the upload child process environment.
Do not export credentials into shell startup files or retrieve them through
tool-visible output. Keychain and network access may require the normal execution
permission mechanism. Missing credentials block release execution, not creating
or validating this skill.

Do not print or persist credential values, JWTs, full environment dumps or secret
command arguments. Avoid `web-ext dump-config`, verbose output and shell tracing
with credentials present. Use only a redacted summary if a diagnostic contains
sensitive data. Keep credentials out of the repo, artifact, metadata and release
record. Do not use `sign` to test whether credentials work: it submits a real upload.

Check the existing add-on identity, management access and target-version status
using the authenticated read-only AMO API or Developer Hub. For an API check,
follow Mozilla's current [authentication reference](https://mozilla.github.io/addons-server/topics/api/auth.html)
and [add-on/version endpoints](https://mozilla.github.io/addons-server/topics/api/addons.html).
Keep JWT generation and headers inside the local process, out of tool output.
Check pending and rejected versions as well as the public current version.
A missing public version is not sufficient evidence for safe resubmission.

## Upload the approved contents

`web-ext sign` takes a source directory and builds a package itself; it does not
accept an existing release ZIP as its source. Use the preserved, verified
`signing-source/` extracted from the approved ZIP, which includes `LICENSE`.
Do not point it at a changing working tree, repository root or `dist/`.
Compressed ZIP bytes may differ when repacked; every packaged file must match the
approved bytes. The manifest must retain `tabernacle@michaelprojects.com`.

Store metadata outside that directory. For an update, the minimal metadata shape is:

```json
{
  "version": {
    "release_notes": {
      "en-GB": "The approved public release notes."
    }
  }
}
```

Use the listing's existing locale when preparing the real metadata; do not change
its default locale. If reviewer notes are needed, put the exact approved text in
`version.approval_notes`; otherwise omit that field. Before invoking the CLI,
compare `version.release_notes` and any `version.approval_notes` against the exact
text shown in the release confirmation. Do not add, omit or reword notes after
approval without showing the revised text and obtaining confirmation again.
The current extension is readable JavaScript without a bundling/minification step;
a separate source archive is not ordinarily needed. Reassess against Mozilla's
[source submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)
if the release introduces generated or processed code.

After the skill's confirmation, commit/tag and verified push, run the equivalent of:

```sh
./node_modules/.bin/web-ext sign \
  --no-config-discovery \
  --no-input \
  --source-dir "$release_signing_source" \
  --artifacts-dir "$release_signing_artifacts" \
  --channel listed \
  --amo-base-url https://addons.mozilla.org/api/v5/ \
  --amo-metadata "$release_metadata" \
  --approval-timeout 0
```

Use the configured credential helper to execute that CLI with credentials held
inside the process. It invokes the installed `web-ext` JavaScript entrypoint
through Node, without relying on a platform-specific executable shim. After the
release confirmation, with Node from `.nvmrc` on PATH, run:

```sh
python3 scripts/release/amo_credentials.py sign \
  --confirmed \
  --source-dir "$release_signing_source" \
  --artifacts-dir "$release_signing_artifacts" \
  --amo-metadata "$release_metadata"
```

`--confirmed` records the agent's prior user confirmation; it does not replace
asking for it. The helper checks AMO version state again, refuses an existing
version, invokes the installed official `web-ext`, and redacts credentials from
captured CLI output. It does not verify Git refs, QA or approved archive hashes:
those remain the skill's preparation and confirmation responsibilities. It never
retries. Reconcile upload state as described below before any continuation.

The three variables above are absolute paths in this release's attempt directory,
not credentials. Construct argv safely. Launch the child with other `WEB_EXT_*`
variables removed except `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, so inherited
config, ignore patterns, endpoints and other CLI defaults cannot change the
approved upload. Disable config discovery and use the explicit official endpoint
and channel shown above. Do not include `--api-key` or `--api-secret` values in argv.

`--approval-timeout 0` skips waiting for Mozilla's approval, not upload validation,
and does not defer publication. A listed submission may become available after
Mozilla validates/reviews it. The skill's confirmation must include that effect.
Do not use the removed `--use-submission-api`, `--api-url-prefix` or `--id` flags.

## Outcomes and retries

Capture the exit code, upload UUID, version/edit URL and any validation messages
without credentials. Keep the signing source and `.amo-upload-uuid` file that
`web-ext` writes there. These are continuation evidence, not permission to retry.
Read current submission state even if the CLI exits successfully. The credential
helper adds a unique verification query and requests fresh responses on read-only
checks; avoid drawing conclusions from cached status after an upload or edit.
Verify the version's public release notes using the listing's existing locale
(`lang=<default_locale>&show_source=true`) and compare them with the approved
metadata. If notes appear missing, first repeat a fresh locale-specific read.
If they are still absent, update only `release_notes` on that existing version
with the documented authenticated JSON `PATCH` version-metadata endpoint, using
the exact already-approved text. This is metadata reconciliation, not a package
upload. Preserve unexpected existing notes and report a conflict rather than
silently overwriting them. Verify the saved notes with another fresh read; never
rerun `web-ext sign` to repair release notes.

If a timeout, network loss, authentication error or duplicate-version response
occurs, first determine whether the upload/version was already created. An upload
can succeed before a later request fails. Do not automatically rerun `sign`, select
a new version, delete the upload-state file or move the Git tag. If the version is
pending/approved, report that state; use read-only polling for progress. If absence
is authoritatively confirmed, also reconcile the upload identified by the saved
UUID: absence of a version alone does not prove that upload is absent or reusable.
Only when the same approved submission can safely continue, resume that original
signing directory and state once; stop on a repeated failure and report the blocker.

Official references:

- [web-ext command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
- [Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [AMO authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)
- [AMO add-on and version API](https://mozilla.github.io/addons-server/topics/api/addons.html)
