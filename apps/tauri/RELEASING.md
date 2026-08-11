# Releasing the Tauri build (auto-update)

The app self-updates via **tauri-plugin-updater**, pulling a manifest from GitHub
Releases. Update flow is already wired in the app (the titlebar shows an update
banner → Download → Install/relaunch). What's left is operational: a signing key,
a signed build, and publishing the manifest.

## 1. One-time: generate the signing key

The updater verifies downloads with a minisign keypair. Generate it once and keep
the **private** key + password secret (a password manager / CI secret — never
commit it):

```sh
pnpm dlx @tauri-apps/cli@latest signer generate -w "$HOME/.refract/updater.key"
```

This prints a **public key**. Paste it into
`apps/tauri/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing
`REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`. Commit that (the public key is not secret).

> Until a real public key is in place, `check()` will fail signature verification
> at runtime (no update shown) — the rest of the app is unaffected.

Operational rules for the private key:

- Store the private key only in a password manager and in GitHub Actions secrets.
- Do not put the private key in the repo, release artifacts, logs, issue comments,
  screenshots, or local scripts.
- Use `TAURI_SIGNING_PRIVATE_KEY` for the full private key contents, not a path.
- Use `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only for the key password.
- Limit repository admin and secret access to release maintainers.
- Rotate immediately if the private key or password may have been exposed:
  generate a new keypair, replace `plugins.updater.pubkey`, commit it, and ship
  one manual installer so future updates trust the new public key.

## 2. One-time: OS code signing & notarization

The updater key above only signs **updates** (minisign). Separately, the OS
checks installer signatures: unsigned builds trigger Windows SmartScreen
("unrecognized app") and macOS Gatekeeper ("damaged / unidentified developer").
The release workflow signs automatically **when the secrets below exist** and
builds unsigned otherwise, so nothing breaks while accounts are pending.

### Windows — Azure Trusted Signing (~$10/month)

1. Create an Azure account and a **Trusted Signing** resource
   (portal.azure.com → "Trusted Signing Accounts", Basic tier). Note the
   account name and the regional endpoint (e.g. `https://eus.codesigning.azure.net`).
2. Complete **identity validation** (individual or organization) inside the
   Trusted Signing resource, then create a **certificate profile** of type
   *Public Trust*. Note the profile name.
3. Create an **app registration** (Entra ID → App registrations) with a client
   secret, and grant it the *Trusted Signing Certificate Profile Signer* role
   on the Trusted Signing account (IAM → Add role assignment).
4. Add repository secrets:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — from the app registration
   - `AZURE_SIGNING_ENDPOINT` — the regional endpoint URL
   - `AZURE_SIGNING_ACCOUNT` — Trusted Signing account name
   - `AZURE_SIGNING_PROFILE` — certificate profile name

The workflow then installs `trusted-signing-cli` and signs the binary, the
NSIS installer, and the MSI. SmartScreen reputation accrues to the validated
identity, so warnings fade quickly after the first few thousand downloads.

> Free alternative: [SignPath.io](https://signpath.io) offers no-cost signing
> for approved open-source projects. It uses a different CI integration than
> what is wired here — if the Azure cost is a blocker, apply there and rework
> the signing step.

### macOS — Apple Developer Program ($99/year)

1. Enroll at developer.apple.com (individual is fine).
2. In Xcode or the developer portal, create a **Developer ID Application**
   certificate, export it (with private key) as a `.p12` with a password, and
   base64-encode it: `base64 -i cert.p12 | pbcopy`.
3. Create an **app-specific password** for notarization at appleid.apple.com →
   Sign-In and Security → App-Specific Passwords.
4. Add repository secrets:
   - `APPLE_CERTIFICATE` — base64 of the `.p12`
   - `APPLE_CERTIFICATE_PASSWORD` — the `.p12` export password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
   - `APPLE_ID` — the Apple ID email
   - `APPLE_PASSWORD` — the app-specific password
   - `APPLE_TEAM_ID` — 10-character team ID from the developer portal

With all six present, tauri-action signs the `.app`, enables the hardened
runtime (`bundle.macOS.hardenedRuntime` in `tauri.conf.json`), and submits the
DMG for notarization — after which the Gatekeeper right-click-to-open
workaround in the README can be removed.

## 3. Build signed installers

Bump the version in `apps/tauri/src-tauri/tauri.conf.json` and the package
versions, then push a `v*.*.*` tag or run the `Release (Tauri)` workflow
manually. The workflow builds release artifacts for:

- Windows x64
- macOS Apple Silicon
- macOS Intel
- Linux x64

For local testing, build on the target OS with the signing secrets in the
environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME/.refract/updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<your password>"
pnpm build:signed   # run from apps/tauri
```

For GitHub Actions, define repository secrets with the same names. The release
workflow reads only those secrets and creates a draft release for review.

Output (under `src-tauri/target/release/bundle/`, depending on OS):

- Windows: `nsis/*.exe`, `msi/*.msi`, plus `.sig` files
- macOS: `dmg/*.dmg`, `macos/*.app.tar.gz`, plus `.sig` files
- Linux: `appimage/*.AppImage`, `deb/*.deb`, `rpm/*.rpm`, plus `.sig` files

Release assets also include stable, version-independent download names. macOS
updater archives use `Refract-macOS-arm64.app.tar.gz` and
`Refract-macOS-x64.app.tar.gz`; `latest.json` must point to these archives, not
temporary GitHub asset-ID URLs. The RPM alias is always
`Refract-Linux-x86_64.rpm`, so website and package download links continue to
work across future releases.

## 4. Publish to GitHub Releases

The `Release (Tauri)` workflow uploads platform installers and the generated
`latest.json` updater manifest to the draft release. Review the assets, then
publish the draft and mark it as the latest release.

The generated manifest should contain every supported updater platform. Before
publishing, verify every URL returns HTTP 200, including both stable macOS
`.app.tar.gz` updater archives:

`latest.json` must be UTF-8 without a byte-order mark. The release finalizer
rejects BOM-prefixed files, malformed updater objects, and versions that do not
match the release tag. If repairing a published manifest manually, rewrite it
with `jq` before uploading it; do not use Windows PowerShell 5.1
`Set-Content -Encoding utf8`, which adds a BOM.

The release finalizer enforces this before replacing `latest.json` or deleting
versioned assets. Because the release is still a draft, it maps each manifest
URL filename to exactly one release asset and sends an authenticated HEAD request
through the GitHub API. Every final response must be HTTP 200 or finalization
stops with the existing assets intact.

```json
{
  "version": "1.2.0",
  "notes": "What changed…",
  "pub_date": "2026-06-23T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste the FULL contents of the .sig file>",
      "url": "https://github.com/RefractMC/Refract_MC/releases/download/v1.2.0/Refract_1.2.0_windows_x64-setup.exe"
    },
    "darwin-aarch64": {
      "signature": "<paste the FULL contents of the .sig file>",
      "url": "https://github.com/RefractMC/Refract_MC/releases/download/v1.2.0/Refract-macOS-arm64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<paste the FULL contents of the .sig file>",
      "url": "https://github.com/RefractMC/Refract_MC/releases/download/v1.2.0/Refract-macOS-x64.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "<paste the FULL contents of the .sig file>",
      "url": "https://github.com/RefractMC/Refract_MC/releases/download/v1.2.0/Refract_1.2.0_linux_x64.AppImage"
    }
  }
}
```

The app's endpoint is `…/releases/latest/download/latest.json`, so the release
with the manifest must be the **latest** release. On next launch the app compares
its version to `latest.json`, shows the banner, and updates on click.

## 5. Publish to the Arch User Repository

Arch users install the prebuilt package as `refract-launcher-bin`. Its source
files live in `packaging/aur`; the `Publish AUR package` workflow refreshes the
version, RPM checksum, and `.SRCINFO`, then pushes them to the AUR. It runs when
a stable GitHub release is published, not while the release is still a draft.
It can also be rerun manually with an existing published tag.

The AUR requires a dedicated SSH key registered to an AUR account:

1. Generate a dedicated Ed25519 key with `ssh-keygen -t ed25519 -f aur-refract`.
2. Add `aur-refract.pub` to the AUR account under **My Account → SSH Public Key**.
3. Add the full private key as the `AUR_SSH_PRIVATE_KEY` GitHub Actions secret.

The first successful push creates the `refract-launcher-bin` package. Later
stable releases update that same AUR repository automatically. The workflow
pins the SSH host fingerprint published by Arch and refuses drafts and
prereleases, so the package never points at private release assets.

## #26 - upgrading legacy installs to the Tauri build

- **App id is the same** (`com.refract`) and the Tauri backend reads/writes the
  **same** `%APPDATA%/Refract` data dir, so **instances, config, Java, themes
  carry over automatically** with no migration step.
- **Accounts need a one-time re-login**: tokens live in the keyring-backed
  Stronghold vault, so old encrypted tokens aren't readable. Offline accounts
  still work; Microsoft accounts must sign in again once.
- Manual fallback: ship the Tauri NSIS installer as the next version. Users run
  it once over the existing install at the same install path/app id, then
  auto-update takes over.
