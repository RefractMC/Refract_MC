# Refract Tauri app

This package is the desktop shell for Refract. It serves the shared React
renderer from `apps/renderer/src/renderer` and exposes native launcher features
through Rust commands in `src-tauri`.

## Layout

```text
apps/tauri/
  index.html
  vite.renderer.config.ts
  src-tauri/
    Cargo.toml
    tauri.conf.json
    tauri.local.conf.json
    src/
      main.rs
      lib.rs
      *.rs
```

The Rust backend owns local config, accounts, instance management, game install
and launch, themes, logs, updater hooks, and native file dialogs. The renderer
keeps a stable `api.*` surface in `apps/renderer/src/renderer/src/lib/api.ts`
so UI components do not call Tauri commands directly.

## Requirements

- Node.js 20 or newer.
- pnpm 9 or newer.
- Rust stable.
- Platform Tauri prerequisites for your OS.

On Windows, install WebView2 and Microsoft C++ build tools.

## Run

From the repo root:

```sh
pnpm install
pnpm dev
```

Package commands:

```sh
pnpm --filter @refract/tauri-poc dev
pnpm --filter @refract/tauri-poc build:real
pnpm --filter @refract/tauri-poc build
pnpm --filter @refract/tauri-poc build:signed
```

`build` uses `tauri.local.conf.json` for an unsigned local installer. `build:signed`
uses the production updater configuration and requires
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Checks

```sh
pnpm --filter @refract/renderer typecheck
pnpm --filter @refract/tauri-poc build:real
```

Rust checks:

```sh
cd apps/tauri/src-tauri
cargo fmt
cargo check
```
