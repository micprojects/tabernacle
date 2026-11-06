"""Machine-local credentials and AMO preflight for this Tabernacle checkout."""

import argparse
import base64
import ctypes as c
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE = b"com.michaelprojects.tabernacle.amo"
ACCOUNT = b"release"
GUID = "tabernacle@michaelprojects.com"
BASE = "https://addons.mozilla.org/api/v5/"
REPO = Path(__file__).resolve().parents[2]


class SafeError(Exception):
    """Messages are deliberately safe to display without credential data."""


class Keychain:
    def __init__(self, keychain=None, service=SERVICE, account=ACCOUNT):
        if sys.platform != "darwin":
            raise SafeError(
                "Keychain setup requires macOS. Supply WEB_EXT_API_KEY and WEB_EXT_API_SECRET through your local secret manager's process environment instead."
            )
        self.ref, self.service, self.account = keychain, service, account
        self.sec = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
        self.cf = c.CDLL(
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        )
        ptr, uint = c.c_void_p, c.c_uint32
        self.cf.CFRelease.argtypes = [ptr]
        self.cf.CFRelease.restype = None
        signatures = {
            "SecKeychainFindGenericPassword": [
                ptr,
                uint,
                c.c_char_p,
                uint,
                c.c_char_p,
                c.POINTER(uint),
                c.POINTER(ptr),
                c.POINTER(ptr),
            ],
            "SecKeychainAddGenericPassword": [
                ptr,
                uint,
                c.c_char_p,
                uint,
                c.c_char_p,
                uint,
                ptr,
                c.POINTER(ptr),
            ],
            "SecKeychainItemModifyAttributesAndData": [ptr, ptr, uint, ptr],
            "SecKeychainItemFreeContent": [ptr, ptr],
        }
        for name, args in signatures.items():
            fn = getattr(self.sec, name)
            fn.argtypes, fn.restype = args, c.c_int32

    def read(self):
        length, data = c.c_uint32(), c.c_void_p()
        status = self.sec.SecKeychainFindGenericPassword(
            self.ref,
            len(self.service),
            self.service,
            len(self.account),
            self.account,
            c.byref(length),
            c.byref(data),
            None,
        )
        if status == -25300:
            return None
        if status:
            raise SafeError(f"Keychain read failed (OSStatus {status}).")
        try:
            return c.string_at(data, length.value)
        finally:
            self.sec.SecKeychainItemFreeContent(None, data)

    def write(self, value):
        item = c.c_void_p()
        status = self.sec.SecKeychainFindGenericPassword(
            self.ref,
            len(self.service),
            self.service,
            len(self.account),
            self.account,
            None,
            None,
            c.byref(item),
        )
        try:
            if status == -25300:
                status = self.sec.SecKeychainAddGenericPassword(
                    self.ref,
                    len(self.service),
                    self.service,
                    len(self.account),
                    self.account,
                    len(value),
                    value,
                    None,
                )
            elif status == 0:
                status = self.sec.SecKeychainItemModifyAttributesAndData(
                    item, None, len(value), value
                )
            if status:
                raise SafeError(f"Keychain write failed (OSStatus {status}).")
        finally:
            if item.value:
                self.cf.CFRelease(item)


def credentials():
    key, secret = (
        os.environ.get("WEB_EXT_API_KEY"),
        os.environ.get("WEB_EXT_API_SECRET"),
    )
    if key is not None or secret is not None:
        if not key or not secret or any(char.isspace() for char in key + secret):
            raise SafeError(
                "Supply both WEB_EXT_API_KEY and WEB_EXT_API_SECRET as nonempty values without whitespace; no Keychain fallback was used."
            )
        return {"key": key, "secret": secret}
    if sys.platform != "darwin":
        raise SafeError(
            "Mozilla credentials are not configured. Supply WEB_EXT_API_KEY and WEB_EXT_API_SECRET through your local secret manager's process environment."
        )
    raw = Keychain().read()
    if raw is None:
        raise SafeError(
            "Mozilla credentials are not configured in Keychain. Run setup locally."
        )
    try:
        values = json.loads(raw)
        if not all(
            isinstance(values.get(k), str) and values[k].strip()
            for k in ("key", "secret")
        ):
            raise ValueError()
        return {"key": values["key"], "secret": values["secret"]}
    except (ValueError, TypeError, AttributeError):
        raise SafeError(
            "The Keychain credential entry is invalid; run setup to replace it."
        ) from None


def prompt(label):
    # Only static prompt text is in argv. The entered value stays in a captured pipe.
    script = (
        'tell application "System Events"\nactivate\n'
        f'display dialog "Paste the Mozilla {label} from the API credentials page. '
        'It will be stored in macOS Keychain for Tabernacle Release." '
        'with title "Tabernacle Release — Mozilla credentials" default answer "" '
        'with hidden answer buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"\n'
        "text returned of result\nend tell"
    )
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise SafeError(
            "Credential entry was cancelled or the local dialog was unavailable. No credentials were changed."
        )
    value = result.stdout.strip()
    if not value or any(char.isspace() for char in value):
        raise SafeError(
            "The credential was empty or contained whitespace. No credentials were changed."
        )
    return value


def setup():
    store = Keychain()  # Reject unsupported hosts before opening any dialogs.
    values = {"key": prompt("API key (JWT issuer)"), "secret": prompt("API secret")}
    encoded = json.dumps(values).encode()
    store.write(encoded)  # One item keeps both halves of the pair together.
    if store.read() != encoded:
        raise SafeError("Keychain verification failed.")
    print(
        json.dumps(
            {
                "configured": True,
                "store": "macOS Keychain",
                "service": SERVICE.decode(),
                "account": ACCOUNT.decode(),
            }
        )
    )


def jwt(values):
    def encode(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=")

    now = int(time.time())
    header = encode(b'{"alg":"HS256","typ":"JWT"}')
    payload = encode(
        json.dumps(
            {
                "iss": values["key"],
                "jti": secrets.token_hex(16),
                "iat": now,
                "exp": now + 60,
            }
        ).encode()
    )
    content = header + b"." + payload
    signature = encode(
        hmac.new(values["secret"].encode(), content, hashlib.sha256).digest()
    )
    return (content + b"." + signature).decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get(url, values):
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "addons.mozilla.org"
        or not parsed.path.startswith("/api/v5/")
    ):
        raise SafeError("Refusing an unexpected API destination.")
    # AMO/CDN responses can lag a just-completed write. Each release check
    # needs fresh state, especially before deciding whether a version exists.
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("verification", str(time.time_ns())))
    fresh_url = urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(query))
    )
    request = urllib.request.Request(
        fresh_url,
        headers={
            "Authorization": "JWT " + jwt(values),
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(
            request, timeout=30
        ) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SafeError(
            f"Mozilla read-only API request failed (HTTP {error.code}); response omitted to protect credentials."
        ) from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise SafeError(
            "Mozilla read-only API request failed; check network connectivity and credentials."
        ) from None


def preflight(version, values=None):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SafeError("Use an exact MAJOR.MINOR.PATCH version.")
    values = values or credentials()
    profile = get(BASE + "accounts/profile/", values)
    addon_url = BASE + "addons/addon/" + urllib.parse.quote(GUID, safe="") + "/"
    addon = get(addon_url, values)
    if addon.get("guid") != GUID:
        raise SafeError("Mozilla returned an unexpected add-on identity.")
    # Unlike the default public list, this requires author/reviewer access and
    # includes pending, rejected and unlisted versions. Follow every page.
    url = addon_url + "versions/?filter=all_with_unlisted&page_size=50"
    seen, matches, total = set(), [], 0
    while url:
        if url in seen or len(seen) >= 100:
            raise SafeError("Incomplete version listing; do not submit.")
        seen.add(url)
        page = get(url, values)
        rows = page["results"]
        total += len(rows)
        matches.extend(row for row in rows if row.get("version") == version)
        url = page.get("next")
    return {
        "authenticated": True,
        "account_id": profile["id"],
        "management_access": True,
        "guid": GUID,
        "slug": addon.get("slug"),
        "default_locale": addon.get("default_locale"),
        "public_version": (addon.get("current_version") or {}).get("version"),
        "target_version": version,
        "versions_checked": total,
        "target_exists": bool(matches),
        "target_versions": [
            {
                "id": row.get("id"),
                "version": row.get("version"),
                "channel": row.get("channel"),
                "status": (row.get("file") or {}).get("status"),
                "edit_url": row.get("edit_url"),
            }
            for row in matches
        ],
    }


def sign(args):
    # The agent must obtain the SKILL.md confirmation before using this command.
    if not args.confirmed:
        raise SafeError("Release confirmation is required before upload.")
    source, artifacts, metadata = (
        Path(p).resolve()
        for p in (args.source_dir, args.artifacts_dir, args.amo_metadata)
    )
    releases = (REPO / "output/scratch/releases").resolve()
    if not all(p.is_relative_to(releases) for p in (source, artifacts, metadata)):
        raise SafeError("Signing paths must be inside the release records directory.")
    manifest = json.loads((source / "manifest.json").read_text())
    if (
        manifest["browser_specific_settings"]["gecko"]["id"] != GUID
        or not (source / "LICENSE").is_file()
    ):
        raise SafeError("Invalid release signing source.")
    values = credentials()
    state = preflight(manifest["version"], values)
    if state["target_exists"]:
        print(json.dumps(state, indent=2))
        raise SafeError(
            "The target version already exists on Mozilla; no upload was attempted."
        )
    env = {k: v for k, v in os.environ.items() if not k.startswith("WEB_EXT_")}
    env.update(WEB_EXT_API_KEY=values["key"], WEB_EXT_API_SECRET=values["secret"])
    cli = REPO / "node_modules/web-ext/bin/web-ext.js"
    if not cli.is_file():
        raise SafeError(
            "The locked web-ext CLI is missing. Run npm ci in this checkout first."
        )
    command = [
        "node",
        str(cli),
        "sign",
        "--no-config-discovery",
        "--no-input",
        "--source-dir",
        str(source),
        "--artifacts-dir",
        str(artifacts),
        "--channel",
        "listed",
        "--amo-base-url",
        BASE,
        "--amo-metadata",
        str(metadata),
        "--approval-timeout",
        "0",
    ]
    result = subprocess.run(
        command, cwd=REPO, env=env, capture_output=True, text=True, check=False
    )
    output = result.stdout + result.stderr
    for value in values.values():
        output = output.replace(value, "[REDACTED]")
    output = re.sub(
        r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED JWT]", output
    )
    print(output, end="" if output.endswith("\n") else "\n")
    print(json.dumps({"web_ext_exit_code": result.returncode}))
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser(
        "setup",
        help="Enter credentials in native hidden-answer dialogs and save to Keychain",
    )
    sub.add_parser(
        "status", help="Report only whether a valid credential pair is available"
    )
    check = sub.add_parser(
        "preflight", help="Read-only account, add-on access and all-version check"
    )
    check.add_argument("version")
    upload = sub.add_parser(
        "sign",
        help="Submit via official web-ext after the skill's explicit release confirmation",
    )
    upload.add_argument("--confirmed", action="store_true")
    for flag in ("source-dir", "artifacts-dir", "amo-metadata"):
        upload.add_argument("--" + flag, required=True)
    args = parser.parse_args()
    try:
        if args.action == "setup":
            setup()
        elif args.action == "status":
            credentials()
            print('{"configured": true}')
        elif args.action == "preflight":
            print(json.dumps(preflight(args.version), indent=2))
        else:
            return sign(args)
    except SafeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Stopped. Reconcile any upload state before retrying.", file=sys.stderr)
        return 130
    except Exception:  # noqa: BLE001 - never expose credentials through a traceback
        print(
            "Local helper failed; diagnostic details suppressed to protect credentials.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
