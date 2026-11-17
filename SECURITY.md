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

### `crypto-bigint` / `RUSTSEC-2026-0387`

Stronghold 2.1.0 requires iota-crypto 0.23.2, whose k256 0.13 dependency requires
elliptic-curve 0.13 and crypto-bigint 0.5. The [timing advisory](https://rustsec.org/advisories/RUSTSEC-2026-0387)
requires crypto-bigint >=0.7.6; no compatible Stronghold release permits that
line. Refract's `secrets.rs` uses Stronghold's key-value store and encrypted
snapshots with a random OS-keyring master key. It does not invoke Stronghold's
elliptic-curve signing or derivation procedures. This limits exposure but does
not fix the affected library. Keep the exception scoped to this advisory and
reassess before adding any curve procedures. Remove it after a compatible
upstream update; do not migrate vault formats solely to silence the audit.

### Development-only `picomatch` / `GHSA-fc5q-39xc-vjpf`

[The advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) affects picomatch
through 4.0.7, the latest published version on 2026-11-17, with no patched release.
It concerns event-loop exhaustion from attacker-supplied repeated extglob patterns.
The dependency is confined to ESLint, TypeScript ESLint, Vite and router build
tools, which consume repository-owned configuration and patterns. It is absent
from the production dependency graph. The full CI audit ignores only this ID;
a separate `pnpm audit --prod` has no ignore, so a future production dependency
would still fail CI. Do not expose these tools to untrusted glob inputs. Remove
the exception when a patched compatible release is available.

### Resolved XML and ZIP exceptions

The 2026-11-17 lockfile uses plist 1.10.4 with quick-xml 0.42.0 and
libsodium-sys-stable 1.24.6 with ZIP 9.5.1. The quick-xml 0.39 and ZIP 8 dependency
lines are gone. CI removes RUSTSEC-2026-0194, RUSTSEC-2026-0195,
RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 from its ignore list.

## Review record and ownership

Last reviewed: 2026-11-17. Owner: Refract maintainers. Next exception review:
2026-12-17, or the next relevant upstream release, whichever comes first.
The Security Audit workflow runs on pull requests, main pushes, manual dispatch
and every Monday. Maintainers review failures and informational warnings before
a release. Record the upstream constraint and a new review date for any retained
exception; do not add blanket ignores to make the job pass.

The review records below are historical; the current exceptions above and the
workflow are authoritative.

Targeted fixes recorded in September:

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

The updater now resolves to Rust 2.13.2 alongside Tauri 2.12.1 and tauri-utils 2.10.1.
Its urlpattern 0.6.0 dependency removes the five previously reported unmaintained
`unic-*` packages from the lockfile. The glib/quick-xml versions and upstream manifest
constraints above remain unchanged, so their three scoped exceptions are retained.
The unused JavaScript updater package has been removed; the renderer uses
Refract's native updater commands with direct Tauri API 2.12.0. The production
pnpm audit reported no known vulnerabilities. No new audit ignore was added.

Validation: targeted `cargo tree -i` checks, `cargo test --locked` on Windows,
`pnpm audit --prod`, and `cargo audit --ignore RUSTSEC-2024-0429 --ignore
RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195`. Linux/macOS runtime testing is
still required; inspecting a cross-platform dependency graph is not execution.

## JavaScript tooling review - 2026-10-03

The full `pnpm audit`, including development tools, identified five advisories.
The workspace overrides now require `js-yaml >=4.3.2` and `brace-expansion 5.0.12`.
These resolve [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh)
and the brace-expansion recursion and CPU exhaustion advisories.
The TypeScript ESLint parser and plugin now use 8.71.0, which supports the existing
ESLint 8.57 and TypeScript 5.9 versions and replaces the old globby/micromatch/braces
dependency path with tinyglobby. The unpatched
[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) is removed from
the lockfile rather than ignored. The full JavaScript audit reports no known
vulnerabilities. The existing Rust exceptions above remain unchanged.

## JavaScript serialization and source-map review - 2026-10-05

The main-push audit reported two Seroval advisories and one source-map-js advisory.
The workspace now requires `seroval >=1.6.8` within version 1 and
`source-map-js >=1.2.2` within version 1. The lockfile resolves those exact versions.
Seroval remains compatible with router-core's `^1.5.4` requirement and the existing
seroval-plugins `^1.0` peer requirement. Other dependency versions remain unchanged.

Seroval resolves the upstream [thenable-assimilation advisory](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-p6vx-979v-rg4c)
and [typed-array allocation advisory](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-jp82-f5mq-hwhp).
source-map-js uses the upstream [1.2.2 security release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)
for the [indexed source-map advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
No audit exception was added.

Both the full `pnpm audit` and `pnpm audit --prod` report no known vulnerabilities.
Frozen-lockfile installation, renderer typecheck, renderer regressions (44 passed),
IPC/locale validation, full lint (zero errors, 20 existing warnings) and the production
renderer build passed with the patched graph. The existing Rust exceptions remain
unchanged; native runtime and UI smoke testing remain separate acceptance work.

## Optional HTTP/3 dependency review - 2026-10-12

The refreshed Rust audit database identified five advisories in locked
`quinn-proto 0.11.15`. The lockfile now resolves `quinn-proto 0.11.18`, which fixes
RUSTSEC-2026-0338 through RUSTSEC-2026-0342 and avoids the 0.11.17 regression
reported in [RUSTSEC-2026-0343](https://rustsec.org/advisories/RUSTSEC-2026-0343).
Its required random-number dependencies were updated with it. This is reqwest's
optional HTTP/3 dependency; `cargo tree -i quinn-proto --target all` confirms it
is not enabled in Refract's production feature graph. The direct `rand 0.8`
dependency used by Stronghold remains unchanged. No audit exception was added.

## TLS dependency review - 2026-10-15

The lockfile now resolves `rustls 0.23.46`, addressing
[RUSTSEC-2026-0346](https://rustsec.org/advisories/RUSTSEC-2026-0346),
[RUSTSEC-2026-0347](https://rustsec.org/advisories/RUSTSEC-2026-0347),
[RUSTSEC-2026-0348](https://rustsec.org/advisories/RUSTSEC-2026-0348), and
[RUSTSEC-2026-0349](https://rustsec.org/advisories/RUSTSEC-2026-0349).
These cover session-value debug output, rejected ECH handling, optional Brotli
certificate decompression, and key-share prediction before server authentication.
Runtime exposure depends on the enabled features and connection configuration.
The patch fits the existing dependency constraints; no manifest change or new
audit exception is required. The existing glib and quick-xml exceptions remain.

Validation: `cargo audit --ignore RUSTSEC-2024-0429 --ignore
RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195` against a refreshed advisory database
reports zero unignored vulnerabilities and the same three unmaintained dependency
warnings (`bincode`, `paste`, and `proc-macro-error`).

## ZIP dependency review - 2026-10-16

Refract uses ZIP 9.0.4 for runtime archives. The updater's optional ZIP feature
is disabled because releases use raw Windows installers and Linux AppImages;
macOS tar.gz support, TLS and proxy support remain enabled.

CI temporarily ignores [RUSTSEC-2026-0367](https://rustsec.org/advisories/RUSTSEC-2026-0367),
[RUSTSEC-2026-0368](https://rustsec.org/advisories/RUSTSEC-2026-0368) and
[RUSTSEC-2026-0369](https://rustsec.org/advisories/RUSTSEC-2026-0369) for ZIP 8.6.0,
which remains a build dependency of Stronghold's libsodium-sys-stable 1.24.0.
[Upstream 1.24.3](https://github.com/jedisct1/libsodium-sys-stable/blob/master/Cargo.toml)
still requires ZIP 8.6. Its build script verifies minisign signatures before
extracting Windows MSVC libraries. These signed build inputs limit exposure;
the extraction bugs remain unresolved if a malicious archive has a valid signature.
Audit ignores apply by advisory ID, so review them if another ZIP dependency is added.

Owner: Refract maintainers. Review by 2026-10-30 or the next upstream release,
whichever comes first. Remove these three exceptions when a compatible
libsodium-sys-stable release permits ZIP >=9, update the lockfile, and rerun the audit.

## Dependency integration review - 2026-11-17

The dependency PR integration raises Seroval's floor to 1.6.11 and Zod's to 4.6.6.
TypeScript ESLint 8.73.0 depends on minimatch 11.0.1 directly. These address
GHSA-f86p-h4j2-7qgj, GHSA-9wx9-5pv9-3349, GHSA-mrhx-c7xc-m3w5 and
GHSA-g3hv-75wg-m249 without forcing a cross-major minimatch override.

The Rust lockfile updates ctutils to 0.4.8, quinn-proto to 0.11.19, quinn-udp to
0.5.16, rustls-webpki to 0.103.17, both webpki root packages to 1.0.12, ZIP to
9.5.1, plist to 1.10.4, libsodium-sys-stable to 1.24.6, and rustix to 1.1.6.
These address the newly reported TLS distrust, QUIC, archive, timing and xattr
findings. async-executor 1.14.1 also replaces the yanked 1.14.0 release.

Validation uses `pnpm audit --prod` with no exceptions, then configures
`pnpm audit --ignore GHSA-fc5q-39xc-vjpf` in the disposable CI checkout and runs
`pnpm audit` again (pnpm 11's `--ignore` writes configuration). Rust uses
`cargo audit --ignore RUSTSEC-2024-0429 --ignore RUSTSEC-2026-0387`.
The Rust audit retains visible maintenance warnings for
bincode, chrono, paste, proc-macro-error, zbus_names, zvariant and zvariant_derive.
The exceptions at the top of this document describe the remaining risks; passing
these scoped audits does not mean every dependency is free of known advisories.
