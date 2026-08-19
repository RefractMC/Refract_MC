#!/usr/bin/env python3
"""Refresh package metadata from a published Refract GitHub release.

This script downloads release assets only to hash them; it never executes a
downloaded file. Run it from the repository root with a published tag, for
example: `python packaging/scripts/update-packages.py v1.3.4`.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import tempfile
import urllib.request
from pathlib import Path

REPO = "RefractMC/Refract_MC"
SEMVER = re.compile(r"^v(?P<version>0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$")
ASSETS = {
    "windows": "Refract-Windows-x64.exe",
    "arm_dmg": "Refract-macOS-arm64.dmg",
    "intel_dmg": "Refract-macOS-x64.dmg",
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "refract-packaging"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def release_assets(tag: str) -> set[str]:
    data = json.loads(fetch(f"https://api.github.com/repos/{REPO}/releases/tags/{tag}"))
    if data.get("draft") or data.get("prerelease"):
        raise SystemExit(f"{tag} is not a published stable release")
    return {asset["name"] for asset in data.get("assets", [])}


def replace(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"Expected one metadata match in {path}, found {count}")
    path.write_text(updated, encoding="utf-8", newline="\n")


def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"Expected one metadata match for {label}, found {count}")
    return updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag", help="published release tag, such as v1.3.4")
    parser.add_argument("--check-only", action="store_true", help="verify assets and print hashes without modifying files")
    args = parser.parse_args()
    match = SEMVER.fullmatch(args.tag)
    if not match:
        raise SystemExit("tag must match vMAJOR.MINOR.PATCH, with an optional prerelease/build suffix")
    version = match.group("version")
    available = release_assets(args.tag)
    missing = sorted(set(ASSETS.values()) - available)
    if missing:
        raise SystemExit(f"Release {args.tag} is missing stable assets: {', '.join(missing)}")

    base = f"https://github.com/{REPO}/releases/download/{args.tag}"
    with tempfile.TemporaryDirectory(prefix="refract-packaging-") as temp:
        hashes = {}
        for key, name in ASSETS.items():
            data = fetch(f"{base}/{name}")
            hashes[key] = sha256(data)
        source = fetch(f"https://github.com/{REPO}/archive/refs/tags/{args.tag}.tar.gz")
        source_sri = "sha256-" + base64.b64encode(hashlib.sha256(source).digest()).decode("ascii")

    print(f"version: {version}")
    for key, digest in hashes.items():
        print(f"{key}: {digest}")
    print(f"nix source: {source_sri}")
    if args.check_only:
        return

    root = Path(__file__).resolve().parents[2]
    cask = root / "packaging/homebrew/refract.rb"
    cask_text = cask.read_text(encoding="utf-8")
    cask_text = sub_once(cask_text, r'version "[^"]+"', f'version "{version}"', "Homebrew version")
    cask_text = sub_once(cask_text, r'(on_arm[\s\S]*?sha256 ")[0-9a-f]+("\n)', rf'\g<1>{hashes["arm_dmg"]}\g<2>', "Homebrew ARM checksum")
    cask_text = sub_once(cask_text, r'(on_intel[\s\S]*?sha256 ")[0-9a-f]+("\n)', rf'\g<1>{hashes["intel_dmg"]}\g<2>', "Homebrew Intel checksum")
    cask.write_text(cask_text, encoding="utf-8", newline="\n")

    scoop = root / "packaging/scoop/refract.json"
    scoop_data = json.loads(scoop.read_text(encoding="utf-8"))
    scoop_data["version"] = version
    scoop_data["architecture"]["64bit"]["url"] = f"{base}/{ASSETS['windows']}"
    scoop_data["architecture"]["64bit"]["hash"] = hashes["windows"]
    scoop.write_text(json.dumps(scoop_data, indent=2) + "\n", encoding="utf-8", newline="\n")

    nuspec = root / "packaging/chocolatey/refract.nuspec"
    replace(nuspec, r"(<version>)[^<]+(</version>)", rf"\g<1>{version}\g<2>")
    replace(nuspec, r"(<docsUrl>https://github.com/RefractMC/Refract_MC/releases/tag/v)[^<]+", rf"\g<1>{version}")
    replace(nuspec, r"(<releaseNotes>https://github.com/RefractMC/Refract_MC/releases/tag/v)[^<]+", rf"\g<1>{version}")
    install = root / "packaging/chocolatey/tools/chocolateyinstall.ps1"
    replace(install, r"releases/download/v[^/]+/Refract-Windows-x64\.exe", f"releases/download/v{version}/Refract-Windows-x64.exe")
    replace(install, r"checksum64\s*=\s*'[^']+'", f"checksum64     = '{hashes['windows']}'")

    nix = root / "packaging/nixpkgs/package.nix"
    replace(nix, r'version = "[^"]+";', f'version = "{version}";')
    replace(nix, r'(rev = "v[^"]+";\s+hash = ")[^"]+(";)', rf"\g<1>{source_sri}\g<2>")


if __name__ == "__main__":
    main()
