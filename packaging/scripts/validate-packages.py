#!/usr/bin/env python3
"""Static validation for the package metadata committed in this repository."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TAG = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def main() -> None:
    scoop = json.loads((ROOT / "packaging/scoop/refract.json").read_text(encoding="utf-8"))
    version = scoop["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"invalid Scoop version: {version}")
    manifest_url = scoop["architecture"]["64bit"]["url"]
    if f"v{version}/Refract-Windows-x64.exe" not in manifest_url:
        raise SystemExit("Scoop URL does not match its version")
    if not re.fullmatch(r"[0-9a-f]{64}", scoop["architecture"]["64bit"]["hash"]):
        raise SystemExit("Scoop hash is not a SHA-256 digest")
    cask = (ROOT / "packaging/homebrew/refract.rb").read_text(encoding="utf-8")
    if f'version "{version}"' not in cask or cask.count("sha256 ") != 2:
        raise SystemExit("Homebrew cask version/checksum metadata is incomplete")
    nuspec = (ROOT / "packaging/chocolatey/refract.nuspec").read_text(encoding="utf-8")
    if f"<version>{version}</version>" not in nuspec:
        raise SystemExit("Chocolatey version does not match Scoop metadata")
    install = (ROOT / "packaging/chocolatey/tools/chocolateyinstall.ps1").read_text(encoding="utf-8")
    if "/S" not in install or "checksum64" not in install:
        raise SystemExit("Chocolatey NSIS install arguments/checksum are missing")
    nix = (ROOT / "packaging/nixpkgs/package.nix").read_text(encoding="utf-8")
    if f'version = "{version}";' not in nix or "fetchFromGitHub" not in nix:
        raise SystemExit("nixpkgs expression is missing a pinned source")
    print(f"Validated Homebrew, Scoop, Chocolatey, and nixpkgs metadata for {version}.")


if __name__ == "__main__":
    main()
