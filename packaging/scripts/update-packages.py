#!/usr/bin/env python3
"""Refresh package metadata from a published stable Refract GitHub release.

Requires Nix on x86_64 Linux. Downloads are only hashed, never executed. The Nix
dependency fetcher builds its pinned tooling and dependency snapshot.
Example: python packaging/scripts/update-packages.py v1.3.4 --check-only
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = "RefractMC/Refract_MC"
ASSETS = {
    "windows": "Refract-Windows-x64.exe",
    "arm_dmg": "Refract-macOS-arm64.dmg",
    "intel_dmg": "Refract-macOS-x64.dmg",
}
_validator_spec = importlib.util.spec_from_file_location(
    "validate_packages", Path(__file__).with_name("validate-packages.py")
)
validator = importlib.util.module_from_spec(_validator_spec)
_validator_spec.loader.exec_module(validator)
TAG = re.compile(rf"v(?P<version>{validator.VERSION})")
NIX = ["nix", "--extra-experimental-features", "nix-command flakes", "--log-format", "raw"]


def parse_tag(tag: str) -> str:
    match = TAG.fullmatch(tag)
    if not match:
        raise SystemExit("tag must be a stable vMAJOR.MINOR.PATCH without leading zeros or suffixes")
    return match.group("version")


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "refract-packaging",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def release_assets(tag: str) -> set[str]:
    data = json.loads(fetch(f"https://api.github.com/repos/{REPO}/releases/tags/{tag}"))
    if data.get("draft") or data.get("prerelease"):
        raise SystemExit(f"{tag} is not a published stable release")
    return {asset["name"] for asset in data.get("assets", [])}


def run_nix(arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    # Inherit NIX_REMOTE, TMPDIR and other caller configuration unchanged.
    try:
        result = subprocess.run(NIX + arguments, capture_output=True, text=True, check=False)
    except OSError as error:
        raise SystemExit(f"Nix is required to refresh package metadata: {error}") from error
    if check and result.returncode:
        raise SystemExit(f"Nix package metadata calculation failed:\n{result.stderr.strip()}")
    return result


def dependency_arguments(store_path: str, version: str) -> list[str]:
    return [
        "--impure", "--file", str(ROOT / "packaging/scripts/pnpm-deps.nix"),
        "--argstr", "source", store_path,
        "--argstr", "version", version,
        "--argstr", "lockFile", str(ROOT / "flake.lock"),
    ]


def dependency_derivation(store_path: str, version: str) -> str:
    derivation = run_nix([
        "eval", "--raw", *dependency_arguments(store_path, version), "--argstr", "hash", "",
        "drvPath",
    ]).stdout.strip()
    if not re.fullmatch(r"/nix/store/[0-9a-z]{32}-[^/\n]+\.drv", derivation):
        raise SystemExit("Nix returned an invalid pnpm dependency derivation path")
    return derivation


def nix_hashes(tag: str, version: str) -> tuple[str, str]:
    source = run_nix([
        "store", "prefetch-file", "--json", "--unpack",
        f"https://github.com/{REPO}/archive/refs/tags/{tag}.tar.gz",
    ])
    try:
        data = json.loads(source.stdout)
        source_hash = data["hash"]
        store_path = data["storePath"]
    except (ValueError, KeyError, TypeError) as error:
        raise SystemExit("Nix source prefetch returned invalid JSON metadata") from error
    if not isinstance(source_hash, str) or not isinstance(store_path, str):
        raise SystemExit("Nix source prefetch returned invalid hash or store path")
    validator.sha256_sri(source_hash, "Nix source hash")
    if not re.fullmatch(r"/nix/store/[0-9a-z]{32}-[^/\n]+", store_path):
        raise SystemExit("Nix source prefetch returned an invalid store path")

    derivation = dependency_derivation(store_path, version)
    expression = dependency_arguments(store_path, version)
    probe = run_nix(["build", "--no-link", *expression, "--argstr", "hash", ""], check=False)
    mismatch = re.findall(
        rf"hash mismatch in fixed-output derivation '{re.escape(derivation)}':\s+"
        r"specified:\s+sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\s+"
        r"got:\s+(sha256-[A-Za-z0-9+/]{43}=)(?=\s|$)",
        probe.stderr,
    )
    if probe.returncode == 0 or len(mismatch) != 1:
        raise SystemExit(
            "Could not determine the target pnpm dependency hash from its fixed-output mismatch:\n"
            + probe.stderr.strip()
        )
    dependency_hash = mismatch[0]
    validator.sha256_sri(dependency_hash, "Nix pnpm hash")
    # A dependency failure or unrelated 'got:' line can never publish metadata.
    run_nix(["build", "--no-link", *expression, "--argstr", "hash", dependency_hash])
    return source_hash, dependency_hash


def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"Expected one metadata match for {label}, found {count}")
    return updated


def prepare(version: str, hashes: dict[str, str], source_hash: str, dependency_hash: str) -> dict[str, str]:
    texts = {name: (ROOT / name).read_text(encoding="utf-8") for name in validator.FILES}
    cask, scoop, nuspec, install, nix = validator.FILES
    texts[cask] = sub_once(
        texts[cask], r'^  version "[^"\n]+"$', f'  version "{version}"', "Homebrew version"
    )
    for architecture, key in (("arm", "arm_dmg"), ("intel", "intel_dmg")):
        texts[cask] = sub_once(
            texts[cask],
            rf'(on_{architecture} do[\s\S]*?sha256 ")[^"\n]+(")',
            rf'\g<1>{hashes[key]}\g<2>',
            f"Homebrew {architecture} checksum",
        )

    base = f"https://github.com/{REPO}/releases/download/v{version}"
    scoop_data = json.loads(texts[scoop])
    scoop_data["version"] = version
    scoop_data["architecture"]["64bit"]["url"] = f"{base}/{ASSETS['windows']}"
    scoop_data["architecture"]["64bit"]["hash"] = hashes["windows"]
    texts[scoop] = json.dumps(scoop_data, indent=2) + "\n"

    for field, value in (
        ("version", version),
        ("docsUrl", f"https://github.com/{REPO}/releases/tag/v{version}"),
        ("releaseNotes", f"https://github.com/{REPO}/releases/tag/v{version}"),
    ):
        texts[nuspec] = sub_once(
            texts[nuspec], rf"(<{field}>)[^<]+(</{field}>)",
            rf"\g<1>{value}\g<2>", f"Chocolatey {field}",
        )
    for field, value in (
        ("url64bit", f"{base}/{ASSETS['windows']}"),
        ("checksum64", hashes["windows"]),
    ):
        texts[install] = sub_once(
            texts[install], rf"(^\s*{field}\s*=\s*')[^'\n]+(')",
            rf"\g<1>{value}\g<2>", f"Chocolatey {field}",
        )

    texts[nix] = sub_once(
        texts[nix], r'^  version = "[^"\n]+";', f'  version = "{version}";', "Nix version"
    )
    for field, fetcher, digest in (
        ("src", "fetchFromGitHub", source_hash),
        ("pnpmDeps", "fetchPnpmDeps", dependency_hash),
    ):
        block = validator.one(
            texts[nix], rf"(  {field} = {fetcher} \{{[\s\S]*?\n  \}};)", f"Nix {field} block"
        )
        updated = sub_once(block, r'(hash = ")[^"\n]+(")', rf"\g<1>{digest}\g<2>", f"Nix {field} hash")
        texts[nix] = texts[nix].replace(block, updated, 1)
    validator.validate(texts)
    return texts


def publish(texts: dict[str, str]) -> None:
    # Prepare all content before writes. Each replacement is atomic, but the set
    # of files is not a crash-proof filesystem transaction.
    pending = []
    try:
        for name, text in texts.items():
            destination = ROOT / name
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=destination.parent,
                prefix=f".{destination.name}.", suffix=".tmp", delete=False,
            ) as output:
                pending.append((Path(output.name), destination))
                output.write(text)
            os.chmod(output.name, destination.stat().st_mode)
        for temporary, destination in pending:
            os.replace(temporary, destination)
    finally:
        for temporary, _ in pending:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="published stable release tag, such as v1.3.4")
    parser.add_argument("--check-only", action="store_true", help="verify assets, Nix hashes and prepared metadata without modifying files")
    args = parser.parse_args()
    version = parse_tag(args.tag)
    available = release_assets(args.tag)
    missing = sorted(set(ASSETS.values()) - available)
    if missing:
        raise SystemExit(f"Release {args.tag} is missing stable assets: {', '.join(missing)}")

    base = f"https://github.com/{REPO}/releases/download/{args.tag}"
    hashes = {key: hashlib.sha256(fetch(f"{base}/{name}")).hexdigest() for key, name in ASSETS.items()}
    source_hash, dependency_hash = nix_hashes(args.tag, version)
    texts = prepare(version, hashes, source_hash, dependency_hash)
    print(f"version: {version}")
    for key, digest in hashes.items():
        print(f"{key}: {digest}")
    print(f"nix source: {source_hash}")
    print(f"nix pnpm: {dependency_hash}")
    if not args.check_only:
        publish(texts)


if __name__ == "__main__":
    main()
