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

The executable is named `refract` on every platform (`mainBinaryName` in
`tauri.conf.json`): `/usr/bin/refract` in the `.deb` and `.rpm`, `usr/bin/refract`
inside the AppImage, `Refract.app/Contents/MacOS/refract`, and `refract.exe` on
Windows. The Cargo package keeps its internal name; nothing user-facing may
depend on it. The release workflow fails if a bundle does not contain the
canonical name. `install.config.json` at the repository root no longer names the
macOS executable: the installer reads it from the bundle, so the file stays valid
across the rename.

The updater’s signed `latest.json` uses separate `.app.tar.gz` aliases. Package
manifests intentionally use the installer/DMG aliases, not updater archives.
MSIX is not listed as a direct-download link until a trusted publisher
certificate is configured and a signed package has passed clean Windows install,
upgrade, uninstall, WebView2, and data-directory tests.

## Refreshing metadata

Run the generator on x86_64 Linux with Python 3 and a working Nix store, with the
`nix-command` and `flakes` experimental features enabled. From the repository
root, pass a published stable tag in canonical `vMAJOR.MINOR.PATCH` form. Leading
zeros, prerelease suffixes, and build suffixes are rejected. The GitHub release
must also be published and marked stable.

```sh
python packaging/scripts/update-packages.py v1.4.0
python packaging/scripts/validate-packages.py
```

The generator verifies the required assets and calculates their SHA-256 hashes
without executing them. Nix calculates the unpacked source hash for
`fetchFromGitHub` and builds the release's pnpm dependency store using the
generator checkout's locked Nixpkgs, `pnpm_11`, and `fetcherVersion = 4`. The
release dependency hash belongs to that exact tag's source, not the current
checkout's lockfile. All downloads, Nix commands, template checks, and generated
metadata validation finish before manifest writes begin.

Use `--check-only` to compute and print the release hashes without changing
manifests. It still needs network access and Nix builds. A pull request should
include the resulting manifest changes and the validation output.

The `Update package manifests` workflow installs Nix and opens a metadata pull
request after a stable release is published. A repository administrator must
enable **Settings > Actions > General > Workflow permissions > Allow GitHub
Actions to create and approve pull requests**, subject to organization policy.
The workflow already requests `contents: write` and `pull-requests: write`.
Changing the setting is a separate administrator action.

Current [GitHub token rules](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)
place checks from token-created or updated pull requests in an approval-required
state for `opened`, `synchronize`, and `reopened` events. A maintainer with write
access must select **Approve workflows to run**. Token pushes do not trigger
ordinary push workflows.

## Package checks and dependency changes

Run the offline package-script regressions and static metadata checks from the
repository root:

```sh
python -B -m unittest discover -s packaging/scripts -p 'test_*.py'
python -B packaging/scripts/validate-packages.py
REFRACT_NIX_INTEGRATION=1 python -B packaging/scripts/test_nix_integration.py
nix flake check --no-update-lock-file
nix build --no-link --print-build-logs --no-update-lock-file .#refract
```

The opt-in Nix test evaluates the generator's real dependency helper against a
small source fixture without fetching a release or building its dependencies.
It is skipped during ordinary offline test discovery.

`Packaging Checks` runs these checks for packaging, Nix, and dependency input
changes. It builds the x86_64-linux package, including frozen offline pnpm
installation, and evaluates the aarch64-linux package. Evaluation does not
verify an ARM build or launcher runtime behavior. CI detects stale dependency
hashes in the current flake and does not update them. Historical release
manifests receive static validation; the generator verifies their hashes when
refreshing metadata for a published tag.

After changing dependencies, the lockfile, or the Nix fetcher toolchain, refresh
the current flake's `pnpmDeps.hash` in `nix/package.nix` deliberately:

1. Temporarily set that hash to an empty string.
2. Run `nix build --no-link --print-build-logs .#refract.pnpmDeps`.
3. Copy the `got: sha256-...` value from the expected fixed-output hash mismatch
   into that field. Other build failures do not establish a checksum.
4. Repeat the dependency build, then run the full flake checks and package build.

Keep this current-source hash separate from the published release's
`packaging/nixpkgs/package.nix` hashes. Refresh the latter through the metadata
generator when targeting a published tag; never copy a current-worktree hash
into a package for a different source revision.

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
