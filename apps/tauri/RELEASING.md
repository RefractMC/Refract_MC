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

## 2. Build a signed installer

Bump the version in `apps/tauri/src-tauri/tauri.conf.json` (and the renderer
`package.json`), then build with the signing secrets in the environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME/.refract/updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<your password>"
pnpm build:signed   # run from apps/tauri
```

For GitHub Actions, define repository secrets with the same names. The Tauri
release workflow reads only those secrets and creates a draft release for review.

Output (under `src-tauri/target/release/bundle/`):
- `nsis/Refract_<version>_x64-setup.exe` — the installer
- `nsis/Refract_<version>_x64-setup.exe.sig` — its signature (`createUpdaterArtifacts` is on)

## 3. Publish to GitHub Releases

Create a release on `RefractMC/Refract_MC` (tag e.g. `v1.1.4`) and upload:
1. the `-setup.exe` installer
2. a `latest.json` manifest:

```json
{
  "version": "1.1.4",
  "notes": "What changed…",
  "pub_date": "2026-06-16T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste the FULL contents of the .sig file>",
      "url": "https://github.com/RefractMC/Refract_MC/releases/download/v1.1.4/Refract_1.1.4_x64-setup.exe"
    }
  }
}
```

The app's endpoint is `…/releases/latest/download/latest.json`, so the manifest
must live on the **latest** release. On next launch the app compares its version
to `latest.json`, shows the banner, and updates on click.

## #26 — migrating Electron users to the Tauri build

- **App id is the same** (`com.refract`) and the Tauri backend reads/writes the
  **same** `%APPDATA%/Refract` data dir, so **instances, config, Java, themes
  carry over automatically** — no migration step.
- **Accounts need a one-time re-login**: tokens live in the keyring-backed
  Stronghold vault here, not Electron's `safeStorage`, so the old encrypted tokens
  aren't readable. Offline accounts (no token) still work; Microsoft accounts must
  sign in again once.
- Ship the Tauri NSIS installer as the next version; users run it once over the
  Electron install (same install path/app id), then auto-update takes over.
