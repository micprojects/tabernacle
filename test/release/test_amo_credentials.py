"""Offline contract checks for release credentials, relocation and submission guards."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "scripts/release/amo_credentials.py"
spec = importlib.util.spec_from_file_location("amo_credentials", HELPER)
amo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amo)
DUMMY = {"key": "dummy-key", "secret": "dummy-secret"}


class CredentialsTests(unittest.TestCase):
    def test_environment_pair_on_other_platform_does_not_access_keychain(self):
        with (
            patch.dict(
                os.environ,
                {
                    "WEB_EXT_API_KEY": DUMMY["key"],
                    "WEB_EXT_API_SECRET": DUMMY["secret"],
                },
                clear=True,
            ),
            patch.object(amo.sys, "platform", "linux"),
            patch.object(amo, "Keychain") as keychain,
        ):
            self.assertEqual(amo.credentials(), DUMMY)
            keychain.assert_not_called()

    def test_partial_or_empty_environment_never_falls_back(self):
        for env in (
            {"WEB_EXT_API_KEY": "dummy"},
            {"WEB_EXT_API_SECRET": "dummy"},
            {"WEB_EXT_API_KEY": "", "WEB_EXT_API_SECRET": "dummy"},
        ):
            with (
                self.subTest(env_keys=list(env)),
                patch.dict(os.environ, env, clear=True),
                patch.object(amo, "Keychain") as keychain,
            ):
                with self.assertRaises(amo.SafeError):
                    amo.credentials()
                keychain.assert_not_called()

    def test_mac_reuses_existing_keychain_entry(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(amo.sys, "platform", "darwin"),
            patch.object(amo, "Keychain") as keychain,
        ):
            keychain.return_value.read.return_value = json.dumps(DUMMY).encode()
            self.assertEqual(amo.credentials(), DUMMY)
            self.assertEqual(amo.SERVICE, b"com.michaelprojects.tabernacle.amo")
            self.assertEqual(amo.ACCOUNT, b"release")

    def test_missing_credentials_on_other_platform_has_actionable_error(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(amo.sys, "platform", "win32"),
            patch.object(amo, "Keychain") as keychain,
        ):
            with self.assertRaisesRegex(amo.SafeError, "WEB_EXT_API_KEY"):
                amo.credentials()
            keychain.assert_not_called()

    def test_setup_on_other_platform_never_opens_mac_dialog(self):
        with (
            patch.object(amo.sys, "platform", "linux"),
            patch.object(amo, "prompt") as prompt,
        ):
            with self.assertRaisesRegex(amo.SafeError, "requires macOS"):
                amo.setup()
            prompt.assert_not_called()

    def test_cancel_keeps_existing_credentials(self):
        with (
            patch.object(amo, "Keychain") as keychain,
            patch.object(
                amo, "prompt", side_effect=["dummy-key", amo.SafeError("cancelled")]
            ),
        ):
            with self.assertRaises(amo.SafeError):
                amo.setup()
            keychain.return_value.write.assert_not_called()


class ApiTests(unittest.TestCase):
    def test_pending_version_on_later_page_blocks_duplicate(self):
        responses = [
            {"id": 123},
            {"guid": amo.GUID, "default_locale": "en-GB"},
            {
                "results": [{"version": "0.2.2"}],
                "next": amo.BASE
                + "addons/addon/tabernacle/versions/?page=2&filter=all_with_unlisted",
            },
            {
                "results": [{"version": "0.2.3", "file": {"status": "unreviewed"}}],
                "next": None,
            },
        ]
        with patch.object(amo, "get", side_effect=responses) as get:
            state = amo.preflight("0.2.3", DUMMY)
        self.assertTrue(state["target_exists"])
        self.assertEqual(state["target_versions"][0]["status"], "unreviewed")
        self.assertIn("filter=all_with_unlisted", get.call_args_list[2].args[0])

    def test_wrong_addon_and_pagination_loop_fail(self):
        cases = [
            [{"id": 1}, {"guid": "wrong-addon"}],
            [
                {"id": 1},
                {"guid": amo.GUID},
                {
                    "results": [],
                    "next": amo.BASE
                    + "addons/addon/"
                    + urllib.parse.quote(amo.GUID, safe="")
                    + "/versions/?filter=all_with_unlisted&page_size=50",
                },
            ],
        ]
        for responses in cases:
            with (
                self.subTest(responses=responses),
                patch.object(amo, "get", side_effect=responses),
                self.assertRaises(amo.SafeError),
            ):
                amo.preflight("0.2.3", DUMMY)

    def test_requests_preserve_filters_and_force_fresh_reads(self):
        seen = []

        def open_request(request, timeout):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query)
            self.assertEqual(query["filter"], ["all_with_unlisted"])
            self.assertEqual(request.get_header("Cache-control"), "no-cache")
            seen.append(query["verification"][0])
            return io.StringIO('{"results": []}')

        with (
            patch.object(amo.urllib.request, "build_opener") as build,
            patch.object(amo.time, "time_ns", side_effect=[1, 2]),
        ):
            build.return_value.open.side_effect = open_request
            for _ in range(2):
                amo.get(
                    amo.BASE
                    + "addons/addon/tabernacle/versions/?filter=all_with_unlisted",
                    DUMMY,
                )
        self.assertNotEqual(seen[0], seen[1])

    def test_credentials_never_go_to_another_host_or_redirect(self):
        with patch.object(amo.urllib.request, "build_opener") as build:
            with self.assertRaises(amo.SafeError):
                amo.get("https://example.com/api/v5/", DUMMY)
            build.assert_not_called()
        self.assertIsNone(
            amo.NoRedirect().redirect_request(
                None, None, 302, None, {}, "https://example.com"
            )
        )


class SignTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tabernacle-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = (Path(self.temp.name) / "relocated checkout").resolve()
        self.attempt = self.repo / "output/scratch/releases/1.2.3/attempt"
        self.source = self.attempt / "signing-source"
        self.source.mkdir(parents=True)
        (self.source / "manifest.json").write_text(
            json.dumps(
                {
                    "version": "1.2.3",
                    "browser_specific_settings": {"gecko": {"id": amo.GUID}},
                }
            )
        )
        (self.source / "LICENSE").write_text("Test licence")
        self.metadata = self.attempt / "metadata.json"
        self.metadata.write_text(
            '{"version": {"release_notes": {"en-GB": "Approved"}}}'
        )
        self.cli = self.repo / "node_modules/web-ext/bin/web-ext.js"
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text("// Mocked CLI; never submitted")
        self.args = Namespace(
            confirmed=True,
            source_dir=str(self.source),
            artifacts_dir=str(self.attempt / "signed"),
            amo_metadata=str(self.metadata),
        )

    def test_unconfirmed_submission_stops_before_credentials(self):
        self.args.confirmed = False
        with patch.object(amo, "credentials") as credentials:
            with self.assertRaises(amo.SafeError):
                amo.sign(self.args)
            credentials.assert_not_called()

    def test_existing_version_stops_before_cli(self):
        with (
            patch.object(amo, "REPO", self.repo),
            patch.object(amo, "credentials", return_value=DUMMY),
            patch.object(amo, "preflight", return_value={"target_exists": True}),
            patch.object(amo.subprocess, "run") as run,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            with self.assertRaises(amo.SafeError):
                amo.sign(self.args)
            run.assert_not_called()

    def test_paths_outside_checkout_stop_before_credentials(self):
        self.args.source_dir = str(Path(self.temp.name) / "another checkout")
        with (
            patch.object(amo, "REPO", self.repo),
            patch.object(amo, "credentials") as credentials,
        ):
            with self.assertRaises(amo.SafeError):
                amo.sign(self.args)
            credentials.assert_not_called()

    def test_relocated_cli_uses_environment_and_redacts_output(self):
        def run(command, **kwargs):
            self.assertEqual(command[:3], ["node", str(self.cli), "sign"])
            self.assertEqual(kwargs["cwd"], self.repo)
            self.assertNotIn(DUMMY["key"], command)
            self.assertNotIn(DUMMY["secret"], command)
            self.assertEqual(kwargs["env"]["WEB_EXT_API_KEY"], DUMMY["key"])
            self.assertEqual(kwargs["env"]["WEB_EXT_API_SECRET"], DUMMY["secret"])
            self.assertNotIn("WEB_EXT_VERBOSE", kwargs["env"])
            self.assertNotIn("WEB_EXT_IGNORE_FILES", kwargs["env"])
            self.assertEqual(command[command.index("--channel") + 1], "listed")
            self.assertEqual(command[command.index("--amo-base-url") + 1], amo.BASE)
            self.assertIn("--no-config-discovery", command)
            self.assertIn("--no-input", command)
            return Namespace(returncode=0, stdout="dummy-key dummy-secret", stderr="")

        output = io.StringIO()
        with (
            patch.object(amo, "REPO", self.repo),
            patch.object(amo, "credentials", return_value=DUMMY),
            patch.object(amo, "preflight", return_value={"target_exists": False}),
            patch.object(amo.subprocess, "run", side_effect=run),
            patch.dict(
                os.environ, {"WEB_EXT_VERBOSE": "true", "WEB_EXT_IGNORE_FILES": "**"}
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(amo.sign(self.args), 0)
        self.assertNotIn(DUMMY["key"], output.getvalue())
        self.assertNotIn(DUMMY["secret"], output.getvalue())

    def test_root_comes_from_helper_location_not_working_directory(self):
        relocated = self.repo / "scripts/release/amo_credentials.py"
        relocated.parent.mkdir(parents=True)
        shutil.copyfile(HELPER, relocated)
        probe = "import importlib.util,sys; s=importlib.util.spec_from_file_location('amo',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.REPO)"
        output = subprocess.check_output(
            [sys.executable, "-c", probe, str(relocated)], cwd=self.temp.name, text=True
        )
        self.assertEqual(Path(output.strip()), self.repo)


if __name__ == "__main__":
    unittest.main()
