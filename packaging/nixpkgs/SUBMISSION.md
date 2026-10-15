# nixpkgs submission

`package.nix` is a source-built starting point for a nixpkgs pull request. It
does not replace the repository flake: nixpkgs packages must build from a
reviewable source revision and use fixed-output dependency hashes.

## Local checks

After adding the expression to a nixpkgs checkout (for example as
`pkgs/by-name/re/refract/package.nix`) and wiring it through the normal
nixpkgs package set, run:

```sh
nix build .#refract
nixpkgs-fmt pkgs/by-name/re/refract/package.nix
```

For a non-flake checkout, use the corresponding `nix-build -A refract` command
from that checkout. Refresh a published release's source and pnpm dependency
hashes with `python packaging/scripts/update-packages.py vMAJOR.MINOR.PATCH`
from the Refract repository root on x86_64 Linux with Python 3 and working Nix. The
generator uses that exact tag's source and the Refract checkout's locked
Nixpkgs with `pnpm_11` and `fetcherVersion = 4`; `--check-only` computes the
hashes without changing manifests. See [packaging instructions](../../docs/PACKAGING.md).

The repository flake's `nix/package.nix` dependency hash belongs to the current
source and must be maintained separately. After moving this expression into
a different nixpkgs checkout, verify its pnpm dependency hash against that
checkout's toolchain. If it changes, temporarily clear that hash, let the
expected fixed-output mismatch report the new value, then rebuild successfully
with it. Do not treat unrelated download or build errors as a new checksum.

## Review notes

The package builds the Tauri/Rust application from source. It needs the pinned
Cargo lockfile and pnpm dependency snapshot, WebKitGTK 4.1, GTK/app-indicator,
GLib networking, and the runtime libraries used by LWJGL/GLFW. Java 8, 17, 21,
and 25 are placed on the wrapped runtime `PATH`; the launcher still manages
Minecraft instances and Java selection itself. No Java runtime is bundled into
the package.

The build disables Tauri updater artifact generation because nixpkgs packages
must not publish or self-update from the upstream GitHub release channel. The
desktop file and icon are installed by the Tauri bundler. Network access is
needed only while populating fixed-output Cargo/pnpm dependencies; the actual
build remains sandbox-compatible.

Before submission, re-check the current nixpkgs Tauri helper names and package
policy. Do not switch this expression to a prebuilt GitHub binary without an
explicit nixpkgs exception.
