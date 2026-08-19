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
from that checkout. If the pnpm dependency hash changes, let the failed fixed
output build print the expected hash, then update it deliberately.

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
