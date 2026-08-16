{
  description = "Refract Minecraft launcher";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          refract = pkgs.callPackage ./nix/package.nix { src = self; };
        in
        {
          inherit refract;
          default = refract;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              cargo-tauri
              fontconfig
              jdk8
              jdk17
              jdk21
              jdk25
              nodejs_24
              pkg-config
              pnpm_11
              rustc
              xdg-utils
              xrandr
            ];

            buildInputs = with pkgs; [
              glib-networking
              libayatana-appindicator
              webkitgtk_4_1
            ];

            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (
              with pkgs;
              [
                addDriverRunpath.driverLink
                alsa-lib
                flite
                libGL
                libayatana-appindicator
                libjack2
                libpulseaudio
                libx11
                libxcursor
                libxext
                libxrandr
                libxxf86vm
                pipewire
                stdenv.cc.cc
                udev
                webkitgtk_4_1
              ]
            );
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-tree);
    };
}
