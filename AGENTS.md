# AGENTS.md

These instructions apply to the entire repository. There are currently no nested `AGENTS.md` files with narrower rules.

## Start here

For substantial work, read these files before editing:

1. `PROJECT_KNOWLEDGE.md` - architecture, runtime flows, persistent data, APIs, events, CI, releases, and known cautions.
2. `CONTRIBUTING.md` - contributor rules and verification expectations.
3. The closest package README, especially `apps/tauri/README.md` or `apps/electron-bridge/README.md`.
4. `apps/tauri/RELEASING.md` only for packaging, signing, updater, or release work.

Keep `PROJECT_KNOWLEDGE.md` accurate when a change modifies architecture, important commands, persisted data, security assumptions, or release workflows.

## Project in one minute

Refract is a pnpm monorepo for a Minecraft Java Edition launcher.

- `apps/renderer` is the shared React/TypeScript UI.
- `apps/tauri` is the production Tauri 2 shell and Rust backend.
- `apps/electron-bridge` is a Windows-only migration bridge for old Electron installs, not the main application.
- `packages/core` provides shared TypeScript models and helpers. Some Node-oriented files are historical; Rust is authoritative for production native behavior.
- `packages/plugin-api` is currently a minimal type contract, not a complete plugin runtime.
- `locales` contains the UI translations.
- `.github/workflows` and `packaging` own CI, releases, and Linux packaging.

The real renderer entry point is `apps/renderer/src/renderer/src/main.tsx`. The small `App.tsx` scaffold is not the mounted application.

## Architectural boundaries

### Renderer to native

UI code should use the typed `api.*` facade in:

- `apps/renderer/src/renderer/src/lib/api.ts`
- `apps/renderer/src/renderer/src/env.d.ts`

Do not add direct Tauri `invoke` calls inside pages or components. When adding or changing a native operation, update every relevant layer:

1. Rust command implementation in `apps/tauri/src-tauri/src`.
2. Command registration in `apps/tauri/src-tauri/src/lib.rs`.
3. Tauri mapping in `lib/api.ts`.
4. Type contract in `env.d.ts`.
5. Tauri capability configuration if a new plugin permission is required.
6. Browser-preview fallback when the feature needs a meaningful preview behavior.

Keep command names, camelCase argument names, result types, error behavior, event payloads, and listener cleanup synchronized across Rust and TypeScript.

### Browser preview is not native verification

`lib/api.ts` has a browser/localStorage fallback for UI preview. A feature working there does not verify native auth, filesystem, downloads, install, launch, dialogs, deep links, or updater behavior. Test native integration through Tauri.

### Persistent data is a compatibility surface

Production data lives under the platform Refract config directory and includes `config.json`, per-instance `instance.json` files, the instance registry, shared Minecraft assets/libraries/versions, managed Java, themes, logs, skins, friends, activity, and the Stronghold vault.

When changing persisted structures:

- Preserve forward and backward compatibility where practical.
- Supply defaults for new optional fields.
- Do not silently relocate or rename user data.
- Consider managed, custom-path, and linked external instances.
- Decide explicitly whether Settings' destructive reset should remove new data.
- Never put access tokens, refresh tokens, passwords, or signing secrets in JSON returned to the renderer.

The shared instance model begins in `packages/core/src/instance-manager/index.ts`, but Rust owns actual production reads and writes.

## Security invariants

- Auth tokens stay in Rust and are stored in Stronghold, protected by the OS keyring. They must never cross into the WebView or logs.
- Preserve defensive path handling and reject path traversal during imports, archive extraction, screenshots, worlds, mods, and exports.
- Preserve verified download behavior: temporary `.part` file, hash/size checking when available, and atomic rename to the final path.
- External URLs must be HTTPS and allowed by `apps/tauri/src-tauri/src/links.rs` or a stricter feature-specific validator.
- Keep the Content Security Policy and Tauri capability list narrow.
- Do not weaken the manual CurseForge restricted-file flow or bypass author distribution restrictions.
- Treat account data, local paths, logs, analytics identifiers, and API keys as sensitive.
- Never commit secrets, private keys, `.env` files, local logs, user data, or build artifacts.
- Do not remove dependency-audit ignores without checking whether the upstream constraint is actually resolved. Do not add new ignores without a documented reason.

For security-sensitive behavior, inspect `SECURITY.md`, `secrets.rs`, `auth.rs`, `downloader.rs`, and the relevant path-validation code.

## Implementation conventions

- Prefer existing project patterns over new abstractions.
- Keep a change focused. Avoid unrelated refactors or repository-wide formatting.
- Use clear errors that can be shown directly to users.
- Keep user-visible strings in locale files. English is the complete schema and fallback.
- When adding a locale key, add it to `locales/en.json` first and ensure Ukrainian and Simplified Chinese can safely fall back or are updated when appropriate.
- Preserve TanStack Query invalidation after mutations and unsubscribe native event listeners on cleanup.
- Preserve scroll locking, focus behavior, keyboard dismissal, and accessibility semantics when modifying dialogs.
- Reuse the theme tokens and shared UI components instead of introducing isolated visual systems.
- Do not hand-edit `routeTree.gen.ts`; let the TanStack Router Vite plugin regenerate it.
- Keep lockfile changes only when dependency resolution changed.
- Use ordinary hyphens in project documentation, not em dashes.

TypeScript formatting follows `.prettierrc`: no semicolons, single quotes, two-space indentation, ES5 trailing commas, and a 100-character print width.

## Change routing

Use this map to find the authoritative area before editing:

| Change | Start here | Also inspect |
| --- | --- | --- |
| Page or visible UI | `apps/renderer/src/renderer/src/routes` or `components` | Locale JSON, shared UI, theme tokens, API facade |
| Native feature | Relevant Rust module | `lib.rs`, `api.ts`, `env.d.ts`, capabilities |
| Instance schema | Core `Instance` type | Rust instance storage, create/edit UI, imports, modpacks |
| Install or launch | `mc_install.rs` or `launch.rs` | Downloader, Java, loaders, Library UI, events, logs |
| Content provider | Browse/content routes | Core types, `content.rs`, `mods.rs`, `modpack.rs`, API-key behavior |
| Setting | `config.rs` | `env.d.ts`, Settings UI, browser fallback, migration behavior |
| Native event | Emitting Rust module | `api.ts`, `env.d.ts`, component cleanup |
| Translation | `locales/*.json` | `i18n/index.ts`, language store, Settings selector |
| Release artifact | `.github/workflows/release-tauri.yml` | Tauri config, updater manifest, README links, AUR workflow |
| External URL | Caller plus URL validator | `links.rs`, CSP, sanitization, user intent |

## Commands

From the repository root:

```sh
pnpm install
pnpm dev
pnpm build
pnpm --filter @refract/renderer typecheck
pnpm --filter @refract/tauri-poc build:real
pnpm audit --prod
```

For Rust work, from `apps/tauri/src-tauri`:

```sh
cargo fmt --check
cargo check
cargo test
```

For the migration bridge:

```sh
pnpm --filter @refract/electron-bridge build
```

Use `pnpm --filter @refract/tauri-poc build` when packaging behavior is in scope. Do not run signed builds, create tags, publish releases, upload assets, push AUR changes, or post Discord announcements unless the user explicitly requests the external action.

Do not run `pnpm format` for a small change unless broad formatting is intended; it writes across the repository.

## Verification expectations

Choose checks proportional to the change and report exactly what ran.

- Renderer/UI: renderer typecheck and a Tauri smoke test when native behavior is involved.
- Rust: `cargo fmt --check`, `cargo check`, relevant unit tests, and an end-to-end UI call when practical.
- API/IPC: verify command registration, argument casing, result/error shapes, event payloads, and cleanup.
- Downloads/install/launch: exercise cancellation, retry, or failure as well as success; confirm no partial final files.
- Packaging/config: make a local unsigned build on the relevant operating system.
- Dependencies: verify both lockfile changes and applicable JavaScript/Rust audits.
- Localization: validate JSON, typecheck, and inspect overflow or layout in the UI.
- Visible changes: capture a screenshot or recording for the pull request when possible.

There is no dedicated JavaScript test suite in package scripts. Rust unit tests are embedded in several backend modules. CI does not replace targeted local testing.

## Git and worktree care

- Inspect `git status` before editing.
- Existing changes and untracked files belong to the user unless clearly created for the current task.
- Never discard, overwrite, stage, or commit unrelated changes.
- Do not use destructive Git operations unless explicitly requested.
- Do not amend commits, rewrite history, create a branch, commit, push, or open a pull request unless the user asks.
- Review the final diff for accidental generated files, logs, formatting churn, or secret material.

## Release and version cautions

- The production desktop version is synchronized through the Tauri/renderer/Rust release surfaces and the release tag.
- The root `package.json` version is older and is not the authoritative desktop release version.
- The package name `@refract/tauri-poc` is historical but still wired into scripts and workflows. Do not rename it casually.
- The updater public key in `tauri.conf.json` and `install.config.json` is public and intentional; private signing material must remain outside the repository.
- User-visible release work should update `CHANGELOG.md` with short, concrete entries.
- Read `apps/tauri/RELEASING.md` before changing signing, stable asset names, `latest.json`, AUR automation, or the Electron migration flow.

## Handoff

At the end of a task:

1. State the outcome first.
2. List the important files changed.
3. Report verification commands and results.
4. Call out anything not tested, remaining risk, or follow-up work.
5. Update `PROJECT_KNOWLEDGE.md` when the shared project model changed.
