#!/usr/bin/env python3
"""Static validation for committed or prepared package metadata."""

import base64
import binascii
import json
import re
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[2]
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
BASE = "https://github.com/RefractMC/Refract_MC"
FILES = (
    "packaging/homebrew/refract.rb",
    "packaging/scoop/refract.json",
    "packaging/chocolatey/refract.nuspec",
    "packaging/chocolatey/tools/chocolateyinstall.ps1",
    "packaging/nixpkgs/package.nix",
)


def one(text: str, pattern: str, label: str) -> str:
    matches = re.findall(pattern, text, flags=re.MULTILINE)
    if len(matches) != 1:
        raise SystemExit(f"Expected one {label}, found {len(matches)}")
    return matches[0]


def sha256_hex(value: str, label: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise SystemExit(f"{label} is not a SHA-256 digest")


def sha256_sri(value: str, label: str) -> None:
    try:
        decoded = base64.b64decode(value.removeprefix("sha256-"), validate=True)
    except (ValueError, binascii.Error):
        decoded = b""
    if (
        not value.startswith("sha256-")
        or len(decoded) != 32
        or value != "sha256-" + base64.b64encode(decoded).decode("ascii")
    ):
        raise SystemExit(f"{label} is not a canonical SHA-256 SRI hash")


def validate(texts: dict[str, str]) -> str:
    """Validate metadata together without writing files or fetching URLs."""
    scoop = json.loads(texts[FILES[1]])
    version = scoop["version"]
    if not isinstance(version, str) or not re.fullmatch(VERSION, version):
        raise SystemExit(f"invalid Scoop version: {version}")
    windows_url = f"{BASE}/releases/download/v{version}/Refract-Windows-x64.exe"
    windows = scoop["architecture"]["64bit"]
    if windows["url"] != windows_url:
        raise SystemExit("Scoop URL does not match its version")
    sha256_hex(windows["hash"], "Scoop hash")

    cask = texts[FILES[0]]
    if one(cask, r'^\s*version "([^"\n]+)"$', "Homebrew version") != version:
        raise SystemExit("Homebrew version does not match Scoop metadata")
    for architecture, asset in (("arm", "arm64"), ("intel", "x64")):
        block = one(cask, rf"  on_{architecture} do\n([\s\S]*?)\n  end", f"Homebrew {architecture} block")
        expected = f"{BASE}/releases/download/v#{{version}}/Refract-macOS-{asset}.dmg"
        if one(block, r'url "([^"\n]+)"', f"Homebrew {architecture} URL") != expected:
            raise SystemExit(f"Homebrew {architecture} URL does not match its release")
        digest = one(block, r'sha256 "([^"\n]+)"', f"Homebrew {architecture} checksum")
        sha256_hex(digest, f"Homebrew {architecture} hash")
    if len(re.findall(r"\bsha256\s", cask)) != 2:
        raise SystemExit("Homebrew must contain exactly two architecture checksums")

    nuspec = ElementTree.fromstring(texts[FILES[2]])
    namespace = {"n": "http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd"}
    metadata = nuspec.find("n:metadata", namespace)
    if metadata is None:
        raise SystemExit("Chocolatey metadata is missing")
    for field, expected in (
        ("version", version),
        ("docsUrl", f"{BASE}/releases/tag/v{version}"),
        ("releaseNotes", f"{BASE}/releases/tag/v{version}"),
    ):
        elements = metadata.findall(f"n:{field}", namespace)
        if len(elements) != 1 or elements[0].text != expected:
            raise SystemExit(f"Chocolatey {field} does not match Scoop metadata")
    install = texts[FILES[3]]
    for field, expected in (
        ("url64bit", windows_url),
        ("checksum64", windows["hash"]),
        ("checksumType64", "sha256"),
        ("silentArgs", "/S"),
    ):
        value = one(install, rf"^\s*{field}\s*=\s*'([^'\n]+)'\s*$", f"Chocolatey {field}")
        if value != expected:
            raise SystemExit(f"Chocolatey {field} does not match its release metadata")

    nix = texts[FILES[4]]
    if one(nix, r'^\s*version = "([^"\n]+)";', "Nix version") != version:
        raise SystemExit("Nix version does not match Scoop metadata")
    source = one(nix, r"\bsrc = fetchFromGitHub \{([\s\S]*?)\n  \};", "Nix source")
    for field, expected in (("owner", "RefractMC"), ("repo", "Refract_MC"), ("rev", "v${version}")):
        if one(source, rf'{field} = "([^"\n]+)";', f"Nix source {field}") != expected:
            raise SystemExit(f"Nix source {field} does not match its release metadata")
    sha256_sri(one(source, r'hash = "([^"\n]+)";', "Nix source hash"), "Nix source hash")
    dependencies = one(nix, r"\bpnpmDeps = fetchPnpmDeps \{([\s\S]*?)\n  \};", "Nix pnpm dependencies")
    sha256_sri(one(dependencies, r'hash = "([^"\n]+)";', "Nix pnpm hash"), "Nix pnpm hash")
    if not re.search(r"\bpnpm = pnpm_11;", dependencies) or not re.search(r"\bfetcherVersion = 4;", dependencies):
        raise SystemExit("Nix pnpm dependencies must use pnpm_11 and fetcherVersion 4")
    if not re.search(r"\binherit version src;", dependencies):
        raise SystemExit("Nix pnpm dependencies must use the release version and source")
    return version


def main() -> None:
    version = validate({name: (ROOT / name).read_text(encoding="utf-8") for name in FILES})
    print(f"Validated Homebrew, Scoop, Chocolatey, and nixpkgs metadata for {version}.")


if __name__ == "__main__":
    main()
