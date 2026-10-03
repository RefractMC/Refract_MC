# Security Policy

## Reporting vulnerabilities

Please report security issues privately through GitHub Security Advisories when possible. If that is unavailable, contact the maintainers before opening a public issue with exploit details.

Include the affected version or commit, platform, reproduction steps, impact, and any logs that help verify the issue.

## Dependency alert triage

Refract uses Dependabot and `cargo audit` to track dependency advisories. We update vulnerable dependencies when a compatible fixed version is available.

Some advisories can be blocked by upstream framework constraints. In those cases we document the exception in source control, keep the ignore as narrow as possible, and revisit it when upstream releases a viable update.

## Current documented exceptions

### `glib` / `RUSTSEC-2024-0429`

`glib 0.18.5` is pulled in by Tauri's Linux WebKitGTK/GTK3 backend:

```text
tauri -> tauri-runtime-wry / wry -> webkit2gtk / gtk -> glib
```

The fixed `glib` line starts at `0.20.0`, but the current upstream Tauri/Wry GTK3 stack is capped at `glib 0.18.x`. This means the project cannot directly update `glib` to a non-vulnerable version without an upstream backend update.

CI retains the targeted `RUSTSEC-2024-0429` exception. The resolved `gtk 0.18.2`
manifest still requires `glib 0.18`; remove this exception when a compatible
Tauri/Wry backend update resolves the affected dependency.

### `quick-xml` / `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195`

The resolved `plist 1.9.0` manifest requires `quick-xml 0.39.2`, resolving to
`0.39.4` through `tauri-utils`. The advisories require the `0.41` fix line.
These two existing CI exceptions cover that specific transitive dependency;
they are not permission to process untrusted XML with it. Refract uses this
chain for platform plist metadata. Review the fixed plist/Tauri dependency path
before removing the exceptions. See the [first advisory](https://rustsec.org/advisories/RUSTSEC-2026-0194)
and [second advisory](https://rustsec.org/advisories/RUSTSEC-2026-0195).

## Review record and ownership

Last reviewed: 2026-09-30. Owner: Refract maintainers. Next exception review:
2026-10-30, or the next Tauri/plist release evaluation, whichever comes first.
The Security Audit workflow runs on pull requests, main pushes, manual dispatch
and every Monday. Maintainers review failures and informational warnings before
a release. Record the upstream constraint and a new review date for any retained
exception; do not add blanket ignores to make the job pass.

Targeted fixes in the current lockfile:

- `anyhow 1.0.103` fixes [RUSTSEC-2026-0190](https://rustsec.org/advisories/RUSTSEC-2026-0190).
- `event-listener 5.4.2` fixes [RUSTSEC-2026-0221](https://rustsec.org/advisories/RUSTSEC-2026-0221).
- `rustls 0.23.45`, with its required `rustls-webpki 0.103.15`, fixes
  [GHSA-2mjx-qc3c-rqvc](https://github.com/rustls/rustls/security/advisories/GHSA-2mjx-qc3c-rqvc),
  reported as RUSTSEC-2026-0285 by the current audit database.

The September 30 audit, after updater/Tauri dependency integration, completed with
zero unignored vulnerabilities and three unmaintained
dependency warnings. These warnings remain visible in CI and have no compatible
patched version listed in the advisory database:

| Dependency | Resolved upstream owner | Follow-up |
| --- | --- | --- |
| `bincode 1.3.3`, `paste 1.0.15` | Stronghold / stronghold_engine | Evaluate supported Stronghold maintenance updates without changing vault compatibility blindly. |
| `proc-macro-error 1.0.4` | GTK3 / glib macros | Follow the same Tauri/Wry backend transition as the glib exception. |

The updater now resolves to Rust 2.13.1, requiring Tauri 2.12.0 and tauri-utils 2.10.0.
Its urlpattern 0.6.0 dependency removes the five previously reported unmaintained
`unic-*` packages from the lockfile. The glib/quick-xml versions and upstream manifest
constraints above remain unchanged, so their three scoped exceptions are retained.
The JavaScript updater is 2.13.0 with direct Tauri API 2.12.0; the production pnpm
audit reported no known vulnerabilities. No new audit ignore was added.

Validation: targeted `cargo tree -i` checks, `cargo test --locked` on Windows,
`pnpm audit --prod`, and `cargo audit --ignore RUSTSEC-2024-0429 --ignore
RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195`. Linux/macOS runtime testing is
still required; inspecting a cross-platform dependency graph is not execution.
