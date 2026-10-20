{ lib
, stdenv
, fetchFromGitHub
, rustPlatform
, cargo-tauri
, fetchPnpmDeps
, nodejs_24
, pnpm_11
, pnpmConfigHook
, pkg-config
, wrapGAppsHook4
, glib-networking
, libayatana-appindicator
, webkitgtk_4_1
, addDriverRunpath
, alsa-lib
, flite
, fontconfig
, jdk8
, jdk17
, jdk21
, jdk25
, libGL
, libjack2
, libpulseaudio
, libx11
, libxcursor
, libxext
, libxrandr
, libxxf86vm
, pipewire
, udev
, xdg-utils
, xrandr
}:

let
  version = "1.5.0";
  src = fetchFromGitHub {
    owner = "RefractMC";
    repo = "Refract_MC";
    rev = "v${version}";
    hash = "sha256-E7jYsBV/dPYdo4WbzzOGAEeVMsaX0uKViKhusTGjso8=";
  };
  runtimeLibraries = [
    addDriverRunpath.driverLink libGL libx11 libxcursor libxext libxrandr
    libxxf86vm stdenv.cc.cc alsa-lib flite libjack2 libpulseaudio pipewire udev
  ];
in
rustPlatform.buildRustPackage {
  pname = "refract";
  inherit version src;
  cargoRoot = "apps/tauri/src-tauri";
  buildAndTestSubdir = "apps/tauri/src-tauri";
  cargoLock.lockFile = "${src}/apps/tauri/src-tauri/Cargo.lock";
  # Release-profile tests rebuild every crate with LTO and unwinding.
  checkType = "debug";

  pnpmDeps = fetchPnpmDeps {
    pname = "refract";
    inherit version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-gHVRfdsvLxJarppTQ+jy6gBSQug8cbQpDiMZTRGX7Fs=";
  };

  nativeBuildInputs = [ cargo-tauri.hook nodejs_24 pkg-config pnpmConfigHook pnpm_11 wrapGAppsHook4 ];
  buildInputs = [ glib-networking libayatana-appindicator webkitgtk_4_1 ];

  env.REFRACT_UPDATER_ENABLED = "false";
  postPatch = ''
    substituteInPlace apps/tauri/src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
  '';

  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : ${lib.makeBinPath [ jdk8 jdk17 jdk21 jdk25 fontconfig xdg-utils xrandr ]}
      --set LD_LIBRARY_PATH ${lib.makeLibraryPath runtimeLibraries}
    )
  '';

  meta = {
    description = "Fast, open-source Minecraft launcher built with Tauri and React";
    homepage = "https://refractmc.net";
    license = lib.licenses.gpl3Only;
    mainProgram = "refract";
    platforms = lib.platforms.linux;
  };
}
