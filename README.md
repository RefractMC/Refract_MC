<p align="center">
  <img src="logo/refract-iris-256.png" width="112" alt="Refract logo" />
</p>

<h1 align="center">Refract</h1>

<p align="center">
  <strong>A fast, open-source Minecraft launcher built with Tauri and React.</strong>
</p>

<p align="center">
  🌐 <a href="docs/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  Organize instances, discover community content, manage Java, and launch Minecraft from one focused desktop app.
</p>

<p align="center">
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/github/v/release/RefractMC/Refract_MC?style=flat-square&color=5316D4" alt="Latest release" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/releases">
    <img src="https://img.shields.io/github/downloads/RefractMC/Refract_MC/total?style=flat-square&color=5316D4" alt="Total downloads" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/RefractMC/Refract_MC?style=flat-square&color=5316D4" alt="GPL-3.0 license" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/actions/workflows/development-builds.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/RefractMC/Refract_MC/development-builds.yml?branch=main&style=flat-square&label=builds&color=5316D4" alt="Development build status" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/actions/workflows/security-audit.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/RefractMC/Refract_MC/security-audit.yml?branch=main&style=flat-square&label=security&color=5316D4" alt="Security audit status" />
  </a>
</p>

<p align="center">
  <a href="https://refractmc.net"><strong>Website</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest"><strong>Latest release</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://discord.gg/tE8s5VaWmS"><strong>Discord</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

<p align="center">
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://i.postimg.cc/s27G22Qv/Screenshot-2026-07-10-192249.png" width="100%" alt="Refract launcher screenshot" />
  </a>
</p>

## Built around your Minecraft library

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Instances that stay organized</strong><br />
      Create, group, duplicate, export, pin, search, and filter instances.
      Choose install locations and import existing MultiMC or Prism libraries.
    </td>
    <td width="50%" valign="top">
      <strong>Content without browser hopping</strong><br />
      Install mods, modpacks, shaders, resource packs, and datapacks from
      Modrinth or CurseForge. Sort, update, and save reusable mod profiles.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Player tools in context</strong><br />
      Manage worlds and backups, browse screenshots, track servers with live
      status, and control resources or shaders per instance.
    </td>
    <td width="50%" valign="top">
      <strong>Accounts and Java handled</strong><br />
      Use Microsoft, offline, or Yggdrasil accounts. Refract finds or downloads
      the right Java runtime and offers optional performance presets.
    </td>
  </tr>
</table>

Refract also includes automatic updates, crash-report copying, customizable
themes, Discord Rich Presence, and Java Edition license verification.

## Download

### Linux and macOS install script

```sh
curl -fsSL https://refractmc.net/install.sh | sh
````

### Direct downloads

<p align="center">
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Windows-x64.exe">
    <img src="https://img.shields.io/badge/Download-Windows-5316D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Download Refract for Windows" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-macOS-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS-Apple_Silicon-5316D4?style=for-the-badge&logo=apple&logoColor=white" alt="Download Refract for Apple Silicon macOS" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-macOS-x64.dmg">
    <img src="https://img.shields.io/badge/macOS-Intel-5316D4?style=for-the-badge&logo=apple&logoColor=white" alt="Download Refract for Intel macOS" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Linux-x86_64.AppImage">
    <img src="https://img.shields.io/badge/Linux-AppImage-5316D4?style=for-the-badge&logo=linux&logoColor=white" alt="Download Refract AppImage for Linux" />
  </a>
</p>

| Platform              | Package                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11         | [Download `.exe`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Windows-x64.exe)            |
| macOS — Apple Silicon | [Download ARM64 `.dmg`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-macOS-arm64.dmg)      |
| macOS — Intel         | [Download Intel `.dmg`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-macOS-x64.dmg)        |
| Linux — AppImage      | [Download `.AppImage`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Linux-x86_64.AppImage) |
| Linux — Debian/Ubuntu | [Download `.deb`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Linux-amd64.deb)            |
| Linux — Fedora        | [Download `.rpm`](https://github.com/RefractMC/Refract_MC/releases/latest/download/Refract-Linux-x86_64.rpm)           |
| Linux — Arch/AUR      | [`yay -S refract-launcher-bin`](https://aur.archlinux.org/packages/refract-launcher-bin)                               |
| Other packages        | [View the latest release](https://github.com/RefractMC/Refract_MC/releases/latest)                                     |


> [!NOTE]
> macOS builds are currently unsigned. On first launch, right-click Refract,
> choose **Open**, and confirm the prompt.

## Built with

<p align="left">
  <img src="https://img.shields.io/badge/Tauri-5316D4?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" />
  <img src="https://img.shields.io/badge/React-5316D4?style=flat-square&logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5316D4?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Rust-5316D4?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-5316D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
</p>

The React renderer handles the launcher experience. Tauri and Rust provide the
native shell, secure credential storage, downloads, file operations, and
platform integration.

## Build from source

### Requirements

* [Node.js](https://nodejs.org/) 20 or newer
* [pnpm](https://pnpm.io/) 9 or newer
* [Rust](https://www.rust-lang.org/tools/install) stable
* The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

Windows packaging also requires WebView2 and the Microsoft C++ build tools.

### Setup

```bash
git clone https://github.com/RefractMC/Refract_MC.git
cd Refract_MC
pnpm install
pnpm dev
```

Create a local unsigned build with:

```bash
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification commands, signed builds,
project conventions, and pull request guidelines.

<details>
<summary><strong>Repository layout</strong></summary>

* `apps/renderer` contains the shared React renderer.
* `apps/tauri` contains the Tauri shell and Rust backend.
* `apps/electron-bridge` migrates older Electron installs to Tauri.
* `packages/core` contains shared launcher logic.
* `packages/plugin-api` contains the public plugin API.
* `locales` contains translation files.
* `docs` contains project documentation.

</details>

## Translations

Refract keeps user-facing strings in [`locales`](locales). To add a language,
copy `locales/en.json`, rename it with a BCP 47 language tag, translate the
values, and keep every JSON key unchanged.

The [translation guide](locales/README.md) explains locale registration,
parameterized strings, validation, and pull request naming.

## Community and support

* Report reproducible bugs through [GitHub Issues](https://github.com/RefractMC/Refract_MC/issues).
* Join the [Refract Discord](https://discord.gg/tE8s5VaWmS) for community help and project discussion.
* Read the [security policy](SECURITY.md) before reporting a vulnerability.
* Review the [contribution guide](CONTRIBUTING.md) before opening a pull request.

<p align="left">
  <a href="https://discord.gg/tE8s5VaWmS">
    <img src="https://discordapp.com/api/guilds/1507409148331954408/widget.png?style=banner3" alt="Join the Refract Discord" />
  </a>
</p>

## License

Refract is licensed under the [GNU General Public License v3.0](LICENSE).
