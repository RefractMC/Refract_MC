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

The CI audit uses a targeted ignore for `RUSTSEC-2024-0429` only. This exception should be removed as soon as Tauri/Wry provide a compatible path to `glib >= 0.20.0`.
