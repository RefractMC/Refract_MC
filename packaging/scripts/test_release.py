"""Regressions for complete manifests and the Linux release check."""

import base64
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release", SCRIPTS / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ManifestTests(unittest.TestCase):
    def test_complete_manifest_and_missing_input(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            for name in release.FILES:
                (directory / name).write_bytes(b"package")
            for name in release.UPDATERS:
                (directory / (name + ".sig")).write_text(base64.b64encode(b"signature").decode())
            manifest = release.manifest_for("v1.2.3", "Notes", directory)
            self.assertEqual(manifest["version"], "1.2.3")
            self.assertEqual(len(manifest["platforms"]), 10)
            for platform in ("windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"):
                self.assertIn(platform, manifest["platforms"])
            self.assertTrue(all("/v1.2.3/Refract-" in item["url"] for item in manifest["platforms"].values()))
            (directory / "Refract-Linux-amd64.deb.sig").unlink()
            with self.assertRaises(ValueError):
                release.manifest_for("v1.2.3", "Notes", directory)

    def test_existing_draft_and_published_release(self):
        draft = {"id": 42, "tag_name": "v1.2.3", "draft": True, "prerelease": False, "body": "Notes"}
        self.assertEqual(release.draft_id("v1.2.3", "Notes", [[draft]]), 42)
        self.assertEqual(release.draft_id("v1.2.3", "Notes", [[]]), "")
        for changed in ({"draft": False}, {"body": "Wrong"}, {"prerelease": True}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                release.draft_id("v1.2.3", "Notes", [[{**draft, **changed}]])

@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("dpkg-deb"),
                     "Linux package-check regression needs dpkg-deb")
class LinuxWorkflowTests(unittest.TestCase):
    def check_package(self, variant):
        workflow = (SCRIPTS.parents[1] / ".github/workflows/release-tauri.yml").read_text(encoding="utf-8")
        block = workflow.split("- name: Verify the canonical executable name\n", 1)[1]
        block = block.split("        run: |\n", 1)[1]
        lines = []
        for line in block.splitlines():
            if line and not line.startswith("          "):
                break
            lines.append(line[10:])
        script = "\n".join(lines).replace("${{ runner.os }}", "Linux")
        with tempfile.TemporaryDirectory(prefix="refract-package-check-") as directory:
            root = Path(directory)
            package = root / "package"
            (package / "DEBIAN").mkdir(parents=True)
            (package / "DEBIAN/control").write_text(
                "Package: refract-test\nVersion: 1.2.3\nArchitecture: amd64\n"
                "Maintainer: Refract Maintainers <test@example.invalid>\n"
                "Description: Release package verification fixture\n", encoding="utf-8"
            )
            executable = package / "usr/bin/refract"
            executable.parent.mkdir(parents=True)
            if variant != "missing":
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)
            if variant == "valid":
                padding = package / "usr/share/refract"
                padding.mkdir(parents=True)
                for index in range(700):
                    (padding / (f"{index:04}-" + "x" * 150)).touch()
            bundle = root / "apps/tauri/src-tauri/target/release/bundle"
            (bundle / "deb").mkdir(parents=True)
            deb = bundle / "deb/Refract_1.2.3_amd64.deb"
            subprocess.run(["dpkg-deb", "--build", str(package), str(deb)],
                           check=True, capture_output=True)
            if variant == "corrupt":
                deb.write_bytes(deb.read_bytes()[:40])
            (bundle / "appimage").mkdir()
            image = bundle / "appimage/Refract_1.2.3_amd64.AppImage"
            image.write_text(
                '#!/bin/sh\nset -eu\n'
                'test "$1" = --appimage-extract\n'
                'test "$2" = usr/bin/refract\n'
                'mkdir -p squashfs-root/usr/bin\n'
                'cp "$0" squashfs-root/usr/bin/refract\n'
                'chmod +x squashfs-root/usr/bin/refract\n', encoding="utf-8"
            )
            image.chmod(0o755)
            if variant == "missing-appimage-executable":
                image.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            temporary = root / "runner-temp"
            temporary.mkdir()
            # A previous extraction must never make a broken package pass.
            stale = temporary / "squashfs-root/usr/bin/refract"
            stale.parent.mkdir(parents=True)
            stale.write_text("stale executable", encoding="utf-8")
            stale.chmod(0o755)
            return subprocess.run(
                ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
                cwd=root, env={**os.environ, "RUNNER_TEMP": str(temporary)},
                capture_output=True, text=True,
            )

    def test_real_deb_and_appimage_extraction_from_different_directory(self):
        result = self.check_package("valid")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_corrupt_deb_is_rejected(self):
        self.assertNotEqual(self.check_package("corrupt").returncode, 0)

    def test_missing_executable_is_rejected_despite_stale_extraction(self):
        self.assertNotEqual(self.check_package("missing").returncode, 0)

    def test_empty_appimage_extraction_does_not_use_stale_executable(self):
        self.assertNotEqual(self.check_package("missing-appimage-executable").returncode, 0)


if __name__ == "__main__":
    unittest.main()
