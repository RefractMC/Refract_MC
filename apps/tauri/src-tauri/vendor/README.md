# Vendored dependency patches

## libsodium-sys-stable 1.24.0

Source: the published [1.24.0 crate](https://crates.io/crates/libsodium-sys-stable/1.24.0),
SHA-256 `72b04bf6da2c98b727af37ab62cb505f4d751b975b034a9b9ad491d333b0564e`.
The upstream MIT and Apache licenses are included in the crate directory.

The only source change is the `build-dependencies.zip` requirement in `Cargo.toml`,
from `8.5` to `9.0.4`. The build script, Rust bindings, bundled libsodium source
archive and signature are unchanged. Cargo cache markers, upstream GitHub workflows,
`.gitignore` and the upstream lockfile are omitted. `Cargo.toml.orig` is retained
unchanged for comparison with upstream.

ZIP 9 fixes RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369.
The build script uses ZIP to extract signature-verified Windows MSVC libraries.
Even upstream 1.24.3 still requires ZIP 8, so a path patch is needed to remove
the vulnerable version without changing Stronghold or adding audit exceptions.

Remove this directory and the `[patch.crates-io]` entry once a compatible upstream
libsodium-sys-stable release uses patched ZIP. Update the lockfile and rerun the
Rust audit and platform regression checks when removing the patch.
