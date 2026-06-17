# Refract — Tauri proof‑of‑concept

A minimal **Tauri v2** shell that proves the migration pipeline end‑to‑end:

- a Rust backend (`src-tauri/`) exposing one **real ported command** — `config_get` / `config_set`
- a React + Vite frontend (`src/`) that calls it via `invoke()`
- the Rust command reads/writes the **same** `config.json` the Electron build uses
  (`%APPDATA%\Refract\config.json` on Windows), so the two builds share state during migration.

This is intentionally **separate** from the Electron app (`apps/renderer`). It exists to de‑risk the
port and get a velocity read, not to replace anything yet.

## What it demonstrates
Every core backend mechanic the full migration needs, each as a ported command/module:

| Primitive | Command(s) | Module |
|---|---|---|
| Request/response (read+write JSON) | `config_get` / `config_set` | `config.rs` |
| Bulk on-disk read (same format as Electron) | `instances_list` | `instances.rs`, `paths.rs` |
| Microsoft device-code OAuth + encrypted token storage | `auth_device_start` / `auth_device_poll` + Stronghold | `auth.rs` |

Plus: the renderer calls everything via `@tauri-apps/api`'s `invoke()` / `listen()` (the pattern all
~114 channels follow), Tailwind v4 + shadcn/ui rendering, and a `capabilities/` file granting the
Stronghold plugin. Compare the dev `refract-tauri.exe` size/RAM against the Electron build.

## Prerequisites (one‑time)
Rust is **not** installed in this repo yet. Install the toolchain, then the per‑platform Tauri deps:

```sh
# 1. Rust (run in the prompt with the ! prefix so output lands here):
!winget install Rustlang.Rustup        # or: https://rustup.rs
# Windows also needs the "Desktop development with C++" build tools and WebView2
# (WebView2 ships with Windows 11).

# 2. JS deps (from repo root):
pnpm install

# 3. Generate app icons once (Tauri needs them to bundle):
pnpm --filter @refract/tauri-poc tauri icon ../renderer/build/icon.png
```

## Run

```sh
pnpm --filter @refract/tauri-poc dev      # tauri dev — opens the window
pnpm --filter @refract/tauri-poc build    # tauri build — produces an installer
```

`tauri dev` runs `vite` (port 5180) and the Rust app against it. Edit `src-tauri/src/*.rs` and it
hot‑recompiles; edit `src/*.tsx` and Vite HMR applies instantly.

You can verify the **frontend half** without Rust:

```sh
pnpm --filter @refract/tauri-poc build:vite   # produces apps/tauri/dist/
```

## How the full migration would use this
- Each `apps/renderer/src/main/services/*.ts` becomes a Rust module with `#[tauri::command]`s
  (registered in `src-tauri/src/lib.rs`).
- Streaming flows (install progress, game logs, exit) move from `webContents.send(channel, …)` to
  Tauri's event system (`app.emit(...)` / `listen(...)`).
- The renderer's `lib/api.ts` swaps its `ipcRenderer.invoke` bridge for `invoke()` — the public
  `api.*` surface the components use stays the same, so routes/components don't change.

## Layout
```
apps/tauri/
  index.html, vite.config.ts, src/        # React frontend (invoke calls)
  src-tauri/
    Cargo.toml, build.rs, tauri.conf.json
    src/main.rs, src/lib.rs                # app entry + command registry
    src/config.rs                          # ported config service
```
