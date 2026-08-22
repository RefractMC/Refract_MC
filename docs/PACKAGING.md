# Packaging and distribution

Refract’s official release pipeline builds signed or unsigned Tauri artifacts
for Windows, macOS, and Linux. Stable release aliases are byte-identical copies
of the generated bundles and are the URLs consumed by package manifests.

| Platform / repository | Status | Package name | Automated | Source |
| --- | --- | --- | --- | --- |
| GitHub Releases | Existing | Refract | Yes | official |
| Windows MSIX | Optional/manual; certificate-gated | `Refract-Windows-x64.msix` | Manual workflow | packaging/msix |
| AUR | Existing | `refract-launcher-bin` | Yes, on published releases | official |
| Homebrew Cask | Submitted upstream ([PR #282100](https://github.com/Homebrew/homebrew-cask/pull/282100)) | `refract` | Hashes can be refreshed by script | upstream review |
| Scoop | Submitted upstream ([PR #18562](https://github.com/ScoopInstaller/Extras/pull/18562)) | `refract` | Hashes can be refreshed by script | upstream review |
| Chocolatey | Ready for upstream submission | `refract` | Hashes can be refreshed by script | local package |
| nixpkgs | Partially prepared; submission needs maintainer follow-up | `refract` | Source/hash refresh script | upstream review |
| Flathub | Blocked pending sandbox design | — | No | evaluation only |

“Ready” means the repository contains reviewable metadata; it does not mean an
upstream repository has accepted or published the package.

## Release identity

The authoritative desktop version is synchronized in
`apps/tauri/src-tauri/tauri.conf.json`, `apps/tauri/src-tauri/Cargo.toml`, and
`apps/tauri/package.json`. The root `package.json` version is historical. The
bundle identifier and Linux desktop/application ID are `com.refract`, the macOS
application is `Refract.app`, and the Windows artifact is the Tauri NSIS
installer. The release workflow publishes
these stable aliases:

* `Refract-Windows-x64.exe`
* `Refract-macOS-arm64.dmg` and `Refract-macOS-x64.dmg`
* `Refract-Linux-x86_64.AppImage`, `Refract-Linux-amd64.deb`, and
  `Refract-Linux-x86_64.rpm`

The updater’s signed `latest.json` uses separate `.app.tar.gz` aliases. Package
manifests intentionally use the installer/DMG aliases, not updater archives.
MSIX is not listed as a direct-download link until a trusted publisher
certificate is configured and a signed package has passed clean Windows install,
upgrade, uninstall, WebView2, and data-directory tests.

## Refreshing metadata

From the repository root, pass a published stable tag. The script verifies the
release and all required assets, downloads them only to calculate SHA-256, and
fails before writing if anything is missing:

```sh
python packaging/scripts/update-packages.py v1.4.0
python packaging/scripts/validate-packages.py
```

Use `--check-only` to inspect a release without changing files. Never execute a
downloaded release artifact as part of metadata generation. A pull request should
include the resulting manifest changes and the validation output.

## Direct downloads versus package repositories

The `.deb`, `.rpm`, and `.AppImage` files are direct GitHub Release downloads;
they are not evidence that Refract is in Debian, Ubuntu, Fedora, or openSUSE
repositories. The AUR package is published automatically. Homebrew, Scoop,
Chocolatey, and nixpkgs require separate upstream submissions and review.

## Upstream notes

* Homebrew Cask: submit `packaging/homebrew/refract.rb` after running `brew audit --cask` and `brew style`. Current macOS releases are unsigned/not notarized, which may block official Cask acceptance until the existing signing hooks are configured.
* Scoop: submit `packaging/scoop/refract.json` to the appropriate community bucket; the GUI NSIS installer is not a candidate for Scoop’s CLI-focused main bucket without maintainer approval.
* Chocolatey: run `choco pack packaging/chocolatey/refract.nuspec`, then test the generated package with the real NSIS installer before submitting to the Community Repository.
* nixpkgs: follow [`packaging/nixpkgs/SUBMISSION.md`](../packaging/nixpkgs/SUBMISSION.md) and add the expression to a nixpkgs checkout for review.
* Flatpak: see [`packaging/flatpak/README.md`](../packaging/flatpak/README.md); no insecure broad filesystem manifest is provided.
