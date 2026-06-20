# Contributing to Refract

Thanks for helping improve Refract. This guide explains how to set up the project, make changes, and open a pull request.

## Project layout

- `apps/renderer` contains the shared React renderer.
- `apps/tauri` contains the Tauri shell and Rust backend.
- `packages/core` contains shared launcher logic.
- `packages/plugin-api` contains the public plugin API.
- `locales` contains translation files.

## Requirements

- Node.js 20 or newer.
- pnpm 9 or newer.
- Rust stable for Tauri work.
- Platform build tools required by Tauri.

On Windows, Tauri packaging also needs WebView2 and Microsoft C++ build tools.

## Setup

```bash
git clone https://github.com/RefractMC/Refract_MC.git
cd Refract_MC
pnpm install
```

## Run the app

```bash
pnpm dev
```

## Build commands

Local unsigned build:

```bash
pnpm build
```

Signed release build:

```bash
pnpm --filter @refract/tauri-poc build:signed
```

Signed Tauri builds require `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Checks before a pull request

Run the checks that match your change.

```bash
pnpm --filter @refract/renderer typecheck
pnpm --filter @refract/tauri-poc build:real
pnpm audit --prod
```

For Rust changes:

```bash
cd apps/tauri/src-tauri
cargo fmt
cargo check
```

For packaging changes:

```bash
pnpm --filter @refract/tauri-poc build
```

## Pull request rules

- Keep changes focused on one feature, fix, or cleanup.
- Include a short summary of what changed.
- List the commands you ran to verify the change.
- Add screenshots or screen recordings for visible UI changes.
- Do not commit secrets, tokens, private keys, build artifacts, or local logs.
- Do not rewrite unrelated code while fixing a small issue.
- Keep generated lockfile changes only when dependency resolution changed.

## Code style

- Prefer existing project patterns over new abstractions.
- Keep UI text in locale files when the text is user visible.
- Keep file and path handling defensive in native code.
- Use clear errors that can be shown to users.
- Avoid decorative symbols in docs and issue text.
- Use normal hyphens only. Do not use em dashes.

## Translations

Translation files live in `locales`.

To add a language:

1. Copy `locales/en.json`.
2. Rename it with a standard BCP 47 language code.
3. Translate values only.
4. Keep JSON keys unchanged.

## Security

Report sensitive security issues privately when possible. Do not open a public issue with exploit details, tokens, private keys, or user data.

Dependency audit fixes should include:

- The vulnerable package name.
- The patched version.
- The command used to verify the fix.
- The lockfile changes needed to make CI reproducible.

## Release notes

User-visible changes should update `CHANGELOG.md` when they are part of a release. Keep entries short and concrete.
