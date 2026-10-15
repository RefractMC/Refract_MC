{
  source,
  version,
  hash ? "",
  lockFile ? ../../flake.lock,
}:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);
  nixpkgs = builtins.fetchTree lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
  pkgs = import nixpkgs {
    system = "x86_64-linux";
  };
in
pkgs.fetchPnpmDeps {
  pname = "refract";
  inherit version hash;
  src = builtins.storePath source;
  pnpm = pkgs.pnpm_11;
  fetcherVersion = 4;
}
