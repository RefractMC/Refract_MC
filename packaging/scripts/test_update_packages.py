"""Offline regressions for package generation and the Nix trust boundary."""

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("update_packages", SCRIPTS / "update-packages.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
validator = update.validator
ROOT = SCRIPTS.parents[1]
SOURCE_HASH = "sha256-" + base64.b64encode(b"s" * 32).decode("ascii")
DEPENDENCY_HASH = "sha256-" + base64.b64encode(b"p" * 32).decode("ascii")
STORE_PATH = "/nix/store/" + "a" * 32 + "-source"
DERIVATION = "/nix/store/" + "b" * 32 + "-refract-12.34.56-pnpm-deps.drv"
ZERO_HASH = "sha256-" + base64.b64encode(bytes(32)).decode("ascii")


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="refract-package-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in validator.FILES:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / name).read_bytes())
        self.root_patch = patch.object(update, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def snapshot(self):
        return {name: (self.root / name).read_bytes() for name in validator.FILES}

    def texts(self):
        return {name: (self.root / name).read_text(encoding="utf-8") for name in validator.FILES}

    @staticmethod
    def fetch(url):
        if "/releases/tags/" in url:
            return json.dumps({
                "draft": False,
                "prerelease": False,
                "assets": [{"name": name} for name in update.ASSETS.values()],
            }).encode()
        return url.rsplit("/", 1)[-1].encode()

    def generate(self, *arguments, fetch=None, nix=None):
        with (
            patch("sys.argv", ["update-packages.py", *(arguments or ("v12.34.56",))]),
            patch.object(update, "fetch", side_effect=fetch or self.fetch),
            patch.object(update, "nix_hashes", side_effect=nix or (lambda *_: (SOURCE_HASH, DEPENDENCY_HASH))),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            update.main()

    def test_full_version_urls_and_distinct_hashes_then_idempotence(self):
        self.generate()
        texts = self.texts()
        self.assertEqual(validator.validate(texts), "12.34.56")
        scoop = json.loads(texts[validator.FILES[1]])
        self.assertEqual(scoop["version"], "12.34.56")
        self.assertEqual(scoop["architecture"]["64bit"]["hash"], hashlib.sha256(b"Refract-Windows-x64.exe").hexdigest())
        self.assertIn("/v12.34.56/Refract-Windows-x64.exe", scoop["architecture"]["64bit"]["url"])
        for name in (validator.FILES[0], validator.FILES[2], validator.FILES[4]):
            self.assertIn("12.34.56", texts[name])
        nix = texts[validator.FILES[4]]
        for field, fetcher, expected in (
            ("src", "fetchFromGitHub", SOURCE_HASH),
            ("pnpmDeps", "fetchPnpmDeps", DEPENDENCY_HASH),
        ):
            block = validator.one(nix, rf"{field} = {fetcher} \{{([\s\S]*?)\n  \}};", field)
            self.assertEqual(validator.one(block, r'hash = "([^"]+)";', field), expected)
        for name in ("Refract-macOS-arm64.dmg", "Refract-macOS-x64.dmg"):
            self.assertIn(hashlib.sha256(name.encode()).hexdigest(), texts[validator.FILES[0]])
        first = self.snapshot()
        self.generate()
        self.assertEqual(first, self.snapshot())
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_check_only_leaves_files_unchanged(self):
        before = self.snapshot()
        self.generate("v12.34.56", "--check-only")
        self.assertEqual(before, self.snapshot())

    def test_invalid_tags_fail_before_network_or_nix(self):
        invalid = ["1.2.3", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2", "v1.2.3-rc.1", "v1.2.3+build.1", "v1.2.3\n", "v١.2.3", "v1.2.3$(echo bad)"]
        for tag in invalid:
            with self.subTest(tag=tag):
                before = self.snapshot()
                with self.assertRaises(SystemExit):
                    self.generate(tag, fetch=lambda _: self.fail("unexpected fetch"), nix=lambda *_: self.fail("unexpected Nix"))
                self.assertEqual(before, self.snapshot())
        self.assertEqual(update.parse_tag("v0.0.0"), "0.0.0")

    def test_release_state_and_missing_assets_leave_files_unchanged(self):
        for data in (
            {"draft": True},
            {"prerelease": True},
            {"assets": [{"name": update.ASSETS["windows"]}]},
        ):
            with self.subTest(data=data):
                before = self.snapshot()
                with self.assertRaises(SystemExit):
                    self.generate(fetch=lambda _: json.dumps(data).encode(), nix=lambda *_: self.fail("unexpected Nix"))
                self.assertEqual(before, self.snapshot())

    def test_download_or_nix_failure_leaves_files_unchanged(self):
        def failed_fetch(url):
            if "/releases/tags/" in url:
                return self.fetch(url)
            raise OSError("fixture download failure")

        for options in ({"fetch": failed_fetch}, {"nix": lambda *_: (_ for _ in ()).throw(SystemExit("fixture Nix failure"))}):
            with self.subTest(options=options):
                before = self.snapshot()
                with self.assertRaises((SystemExit, OSError)):
                    self.generate(**options)
                self.assertEqual(before, self.snapshot())

    def test_late_template_corruption_or_duplicate_leaves_files_unchanged(self):
        nix_path = self.root / validator.FILES[4]
        original = nix_path.read_text(encoding="utf-8")
        for broken in (
            original.replace("rev =", "revision ="),
            original.replace("pnpmDeps = fetchPnpmDeps", "dependencySnapshot = fetchPnpmDeps"),
            original.replace('    hash = "', '    missingHash = "', 1),
            original + '\n  version = "1.3.4";\n',
        ):
            with self.subTest(broken=broken[-60:]):
                nix_path.write_text(broken, encoding="utf-8")
                before = self.snapshot()
                with self.assertRaises(SystemExit):
                    self.generate()
                self.assertEqual(before, self.snapshot())

    def test_invalid_prepared_hash_is_rejected_before_writes(self):
        before = self.snapshot()
        with self.assertRaises(SystemExit):
            self.generate(nix=lambda *_: ("sha256-not-a-hash", DEPENDENCY_HASH))
        self.assertEqual(before, self.snapshot())

    def test_partial_publication_failure_cleans_temporary_files(self):
        before = self.snapshot()
        replace = update.os.replace
        destinations = []

        def fail_second(source, destination):
            destinations.append(destination)
            if len(destinations) == 2:
                raise OSError("fixture replacement failure")
            replace(source, destination)

        with patch.object(update.os, "replace", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "fixture replacement failure"):
                self.generate()
        after = self.snapshot()
        self.assertNotEqual(before[validator.FILES[0]], after[validator.FILES[0]])
        for name in validator.FILES[1:]:
            self.assertEqual(before[name], after[name])
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_validator_rejects_independent_metadata_corruption(self):
        self.generate()
        originals = self.texts()
        cases = [
            (validator.FILES[0], 'version "12.34.56"', 'version "12"'),
            (validator.FILES[0], hashlib.sha256(b"Refract-macOS-arm64.dmg").hexdigest(), "abcd"),
            (validator.FILES[0], "Refract-macOS-x64.dmg", "wrong.dmg"),
            (validator.FILES[2], "<version>12.34.56</version>", "<version>1.0.0</version>"),
            (validator.FILES[2], "/tag/v12.34.56", "/tag/v0.0.0"),
            (validator.FILES[3], "/v12.34.56/", "/v1.0.0/"),
            (validator.FILES[3], hashlib.sha256(b"Refract-Windows-x64.exe").hexdigest(), "0" * 64),
            (validator.FILES[4], SOURCE_HASH, "sha256-invalid"),
            (validator.FILES[4], DEPENDENCY_HASH, "sha256-invalid"),
            (validator.FILES[4], 'rev = "v${version}"', 'rev = "v1.3.4"'),
            (validator.FILES[4], "fetcherVersion = 4", "fetcherVersion = 3"),
            (validator.FILES[1], '"version": "12.34.56"', '"version": "01.2.3"'),
            (validator.FILES[1], "/v12.34.56/", "/v0.0.0/"),
            (validator.FILES[1], hashlib.sha256(b"Refract-Windows-x64.exe").hexdigest(), "bad"),
        ]
        for name, old, new in cases:
            with self.subTest(name=name, old=old):
                modified = dict(originals)
                self.assertIn(old, modified[name])
                modified[name] = modified[name].replace(old, new)
                with self.assertRaises(SystemExit):
                    validator.validate(modified)


class NixHashTests(unittest.TestCase):
    @staticmethod
    def result(stdout="", stderr="", code=0):
        return subprocess.CompletedProcess([], code, stdout, stderr)

    @staticmethod
    def mismatch(derivation=DERIVATION, digest=DEPENDENCY_HASH):
        return (
            f"warning: found empty hash, assuming '{ZERO_HASH}'\n"
            f"error: hash mismatch in fixed-output derivation '{derivation}':\n"
            f"         specified: {ZERO_HASH}\n"
            f"            got:    {digest}\n"
        )

    def responses(self, mismatch=None):
        return [
            self.result(json.dumps({"hash": SOURCE_HASH, "storePath": STORE_PATH})),
            self.result(DERIVATION),
            self.result(stderr=self.mismatch() if mismatch is None else mismatch, code=1),
            self.result(),
        ]

    def test_actual_nix_commands_require_exact_derivation_and_verified_rebuild(self):
        with patch.object(update.subprocess, "run", side_effect=self.responses()) as run:
            self.assertEqual(update.nix_hashes("v12.34.56", "12.34.56"), (SOURCE_HASH, DEPENDENCY_HASH))
        calls = [call.args[0] for call in run.call_args_list]
        self.assertIn("--unpack", calls[0])
        self.assertIn("/v12.34.56.tar.gz", calls[0][-1])
        self.assertEqual(calls[1][-1], "drvPath")
        self.assertNotIn("--apply", calls[1])
        self.assertEqual(calls[2][-1], "")
        self.assertEqual(calls[3][-1], DEPENDENCY_HASH)
        expected_arguments = [
            ("source", STORE_PATH),
            ("version", "12.34.56"),
            ("lockFile", str(update.ROOT / "flake.lock")),
        ]
        for call in calls[1:]:
            self.assertEqual(call[call.index("--file") + 1], str(update.ROOT / "packaging/scripts/pnpm-deps.nix"))
            arguments = [(call[index + 1], call[index + 2]) for index, value in enumerate(call) if value == "--argstr"]
            self.assertEqual(arguments[:3], expected_arguments)
        self.assertTrue(all("shell" not in call.kwargs and "env" not in call.kwargs for call in run.call_args_list))

    def test_unrelated_or_ambiguous_mismatch_never_rebuilds(self):
        for message in (
            self.mismatch(derivation=DERIVATION.replace("b" * 32, "c" * 32)),
            self.mismatch() + self.mismatch(),
            f"error: network problem\ngot: {DEPENDENCY_HASH}",
            self.mismatch(digest="sha256-invalid"),
        ):
            with self.subTest(message=message):
                with patch.object(update.subprocess, "run", side_effect=self.responses(message)) as run:
                    with self.assertRaises(SystemExit):
                        update.nix_hashes("v12.34.56", "12.34.56")
                    self.assertEqual(run.call_count, 3)

    def test_failed_candidate_rebuild_cannot_return_hash(self):
        responses = self.responses()
        responses[-1] = self.result(stderr="candidate verification failed", code=1)
        with patch.object(update.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(SystemExit, "candidate verification failed"):
                update.nix_hashes("v12.34.56", "12.34.56")

    def test_unexpected_success_for_empty_hash_is_rejected(self):
        responses = self.responses()
        responses[2] = self.result()
        with patch.object(update.subprocess, "run", side_effect=responses) as run:
            with self.assertRaisesRegex(SystemExit, "Could not determine the target"):
                update.nix_hashes("v12.34.56", "12.34.56")
            self.assertEqual(run.call_count, 3)

    def test_bad_prefetch_metadata_or_unavailable_nix_fails_clearly(self):
        for output in ("not json", "{}", json.dumps({"hash": "bad", "storePath": STORE_PATH}), json.dumps({"hash": SOURCE_HASH, "storePath": "/tmp/source"})):
            with self.subTest(output=output):
                with patch.object(update.subprocess, "run", return_value=self.result(output)):
                    with self.assertRaises(SystemExit):
                        update.nix_hashes("v12.34.56", "12.34.56")
        with patch.object(update.subprocess, "run", side_effect=FileNotFoundError("nix")):
            with self.assertRaisesRegex(SystemExit, "Nix is required"):
                update.nix_hashes("v12.34.56", "12.34.56")


if __name__ == "__main__":
    unittest.main()
