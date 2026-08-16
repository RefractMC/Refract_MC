{
  lib,
  stdenv,
  src,
  rustPlatform,
  cargo-tauri,
  fetchPnpmDeps,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  pkg-config,
  wrapGAppsHook4,
  glib-networking,
  libayatana-appindicator,
  webkitgtk_4_1,
  addDriverRunpath,
  alsa-lib,
  flite,
  fontconfig,
  jdk8,
  jdk17,
  jdk21,
  jdk25,
  libGL,
  libjack2,
  libpulseaudio,
  libx11,
  libxcursor,
  libxext,
  libxrandr,
  libxxf86vm,
  pipewire,
  udev,
  xdg-utils,
  xrandr,
  jdks ? [
    jdk8
    jdk17
    jdk21
    jdk25
  ],
}:

let
  runtimeLibraries = [
    addDriverRunpath.driverLink

    # LWJGL / GLFW
    libGL
    libx11
    libxcursor
    libxext
    libxrandr
    libxxf86vm
    stdenv.cc.cc

    # Minecraft audio, narration, and device discovery
    alsa-lib
    flite
    libjack2
    libpulseaudio
    pipewire
    udev
  ];
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "refract";
  version =
    (builtins.fromTOML (builtins.readFile (src + "/apps/tauri/src-tauri/Cargo.toml"))).package.version;

  inherit src;

  cargoRoot = "apps/tauri/src-tauri";
  buildAndTestSubdir = finalAttrs.cargoRoot;
  cargoLock.lockFile = src + "/apps/tauri/src-tauri/Cargo.lock";

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-02RHViN1e4IdCekrgl/q6m2lgLnM0wCQW8MJw8C/AKc=";
  };

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs_24
    pkg-config
    pnpmConfigHook
    pnpm_11
    wrapGAppsHook4
  ];

  buildInputs = [
    glib-networking
    libayatana-appindicator
    webkitgtk_4_1
  ];

  env.REFRACT_UPDATER_ENABLED = "false";

  postPatch = ''
    substituteInPlace apps/tauri/src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
  '';

  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : ${
        lib.makeBinPath (
          jdks
          ++ [
            fontconfig
            xdg-utils
            xrandr
          ]
        )
      }
      --set LD_LIBRARY_PATH ${lib.makeLibraryPath runtimeLibraries}
    )
  '';

  meta = {
    description = "Fast, open-source Minecraft launcher built with Tauri and React";
    homepage = "https://refractmc.net";
    license = lib.licenses.gpl3Only;
    mainProgram = "refract-tauri";
    platforms = lib.platforms.linux;
  };
})
