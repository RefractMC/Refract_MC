"""Release notes, updater metadata and Discord payloads from the tagged source."""

import argparse
import base64
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = os.environ.get("GITHUB_REPOSITORY", "RefractMC/Refract_MC")
UPDATERS = {
    "Refract-Windows-x64.exe": ("windows-x86_64", "windows-x86_64-nsis"),
    "Refract-macOS-arm64.app.tar.gz": ("darwin-aarch64", "darwin-aarch64-app"),
    "Refract-macOS-x64.app.tar.gz": ("darwin-x86_64", "darwin-x86_64-app"),
    "Refract-Linux-x86_64.AppImage": ("linux-x86_64", "linux-x86_64-appimage"),
    "Refract-Linux-amd64.deb": ("linux-x86_64-deb",),
    "Refract-Linux-x86_64.rpm": ("linux-x86_64-rpm",),
}
FILES = set(UPDATERS) | {"Refract-macOS-arm64.dmg", "Refract-macOS-x64.dmg"}


def parse_tag(tag):
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Expected a stable vMAJOR.MINOR.PATCH tag without leading zeros")
    return tag[1:]


def release_notes(tag, text):
    version = parse_tag(tag)
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line.rstrip() == f"## {version}"]
    if len(starts) != 1:
        raise ValueError(f"Expected exactly one changelog section for {version}")
    start = starts[0] + 1
    end = next((i for i in range(start, len(lines)) if lines[i].startswith("## ")), len(lines))
    section = "\n".join(lines[start:end]).strip()
    if not section or not any(line.strip() and not line.startswith("#") for line in section.splitlines()):
        raise ValueError(f"The changelog section for {version} is empty")
    return f"## Refract {version}\n\n{section}\n"


def version_metadata(tag, root=ROOT):
    version = parse_tag(tag)
    for name in ("apps/renderer/package.json", "apps/tauri/package.json", "apps/tauri/src-tauri/tauri.conf.json"):
        if json.loads((root / name).read_text(encoding="utf-8"))["version"] != version:
            raise ValueError(f"{name} does not match {tag}")
    for name in ("Cargo.toml", "Cargo.lock"):
        data = tomllib.loads((root / "apps/tauri/src-tauri" / name).read_text(encoding="utf-8"))
        packages = data["package"] if name.endswith("lock") else [data["package"]]
        if [p["version"] for p in packages if p["name"] == "refract-tauri"] != [version]:
            raise ValueError(f"{name} does not match {tag}")
    return release_notes(tag, (root / "CHANGELOG.md").read_text(encoding="utf-8"))


def manifest_for(tag, notes, directory):
    expected = FILES | {name + ".sig" for name in UPDATERS}
    actual = {p.name for p in directory.iterdir()}
    if actual != expected or any(
        not (directory / name).is_file() or not (directory / name).stat().st_size
        for name in expected
    ):
        raise ValueError("Expected exactly eight packages and six updater signatures")
    platforms = {}
    for name, keys in UPDATERS.items():
        signature = (directory / (name + ".sig")).read_text(encoding="utf-8").strip()
        if not base64.b64decode(signature, validate=True):
            raise ValueError(f"Empty updater signature: {name}")
        for key in keys:
            platforms[key] = {
                "signature": signature,
                "url": f"https://github.com/{REPO}/releases/download/{tag}/{name}",
            }
    return {"version": parse_tag(tag), "notes": notes, "platforms": platforms}


def draft_id(tag, notes, pages):
    releases = [release for page in pages for release in page]
    version = tuple(map(int, parse_tag(tag).split(".")))
    for release in releases:
        if not release["draft"] and not release["prerelease"]:
            if tuple(map(int, parse_tag(release["tag_name"]).split("."))) >= version:
                raise ValueError("Version must be newer than published stable releases")
    matches = [release for release in releases if release["tag_name"] == tag]
    if len(matches) > 1:
        raise ValueError("More than one release matches the tag")
    if matches:
        release = matches[0]
        if not release["draft"] or release["prerelease"] or release["body"].replace("\r\n", "\n").strip() != notes.strip():
            raise ValueError("Existing release must be an unpublished stable draft with matching notes")
        return release["id"]
    return ""


def discord_payload(tag, text, url=None):
    section = release_notes(tag, text).split("\n", 2)[2].strip()
    url = url or f"https://github.com/{REPO}/releases/tag/{tag}"
    if len(section.encode("utf-16-le")) // 2 > 3900:
        suffix = f"…\n\n[Full changelog]({url})"
        budget = 3900 - len(suffix.encode("utf-16-le")) // 2
        section = section.encode("utf-16-le")[:budget * 2].decode("utf-16-le", errors="ignore") + suffix
    return {"username": "Refract Releases", "embeds": [{
        "title": f"Refract {parse_tag(tag)} released", "url": url,
        "description": section, "color": 9131006, "footer": {"text": "Refract Launcher"},
    }]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("notes", "manifest", "draft", "verify", "discord"))
    parser.add_argument("tag")
    parser.add_argument("path", nargs="?", default=".")
    parser.add_argument("--url")
    args = parser.parse_args()
    try:
        if args.operation == "discord":
            parse_tag(args.tag)
            text = subprocess.check_output(["git", "show", f"{args.tag}:CHANGELOG.md"]).decode("utf-8")
            print(json.dumps(discord_payload(args.tag, text, args.url), ensure_ascii=False))
        else:
            notes = version_metadata(args.tag)
            if args.operation == "notes":
                print(notes, end="")
            elif args.operation == "manifest":
                print(json.dumps(manifest_for(args.tag, notes, Path(args.path)), ensure_ascii=False, indent=2))
            elif args.operation == "draft":
                print(draft_id(args.tag, notes, json.loads(Path(args.path).read_text(encoding="utf-8"))))
            else:
                release = json.loads(Path(args.path).read_text(encoding="utf-8"))
                if not release["isDraft"] or len(release["assets"]) != 9 or {a["name"] for a in release["assets"]} != FILES | {"latest.json"}:
                    raise ValueError("The final draft must contain exactly nine canonical assets")
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error)) from error
