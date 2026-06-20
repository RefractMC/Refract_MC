<p align="center">
  <img alt="Refract Logo" src="logo/refract-iris-256.png" width="18%">
</p>

<p align="center">
  Refract is a fast, modern, open-source Minecraft launcher built with Tauri and React.<br />
  <br />
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/github/v/release/RefractMC/Refract_MC?style=for-the-badge&color=5316D4" alt="Latest Release" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/stargazers">
    <img src="https://img.shields.io/github/stars/RefractMC/Refract_MC?style=for-the-badge&color=5316D4" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/releases">
    <img src="https://img.shields.io/github/downloads/RefractMC/Refract_MC/total?style=for-the-badge&color=5316D4" alt="Total Downloads" />
  </a>
  <a href="https://discord.gg/tE8s5VaWmS">
    <img src="https://img.shields.io/badge/Discord-Join%20Refract-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" />
  </a>
  <br />
  <a href="https://github.com/RefractMC/Refract_MC/actions/workflows/security-audit.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/RefractMC/Refract_MC/security-audit.yml?branch=main&style=for-the-badge&label=Security%20Audit&color=5316D4" alt="Security Audit" />
  </a>
  <a href="https://github.com/RefractMC/Refract_MC/actions/workflows/development-builds.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/RefractMC/Refract_MC/development-builds.yml?branch=main&style=for-the-badge&label=Development%20Builds&color=5316D4" alt="Development Builds" />
  </a>
</p>

<p align="center">
  <img src="logo/screenshot.png" alt="Refract screenshot" width="80%" />
</p>

---

## Supported Operating Systems

<p align="center">
  <img src="https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows Support" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Support" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux Support" />
</p>

<p align="center">
  Built for cross-platform performance. Fully compatible with <b>Windows 10/11</b>, <b>macOS (Intel & Apple Silicon)</b>, and major <b>Linux distributions</b>.
</p>

---

## Features

- **Instance Management:** Create, group, duplicate, export, and delete instances. Supports custom install locations per instance, drag-and-drop group reordering, search/filter by mod loader and version, and pinning favorites.
- **Mod & Content Browsing:** Browse and install mods, resource packs, shaders, datapacks, and modpacks directly from Modrinth and CurseForge. Includes sorting, one-click updates, bulk toggles, and savable mod profiles.
- **Instance Details:** Dedicated tabs for Worlds (with one-click backups), Screenshots (with an in-app full-res zoom viewer), Servers (live ping and player count), and resource/shader management.
- **Accounts:** Microsoft device-code login with Java Edition license verification, offline/guest profiles, and Yggdrasil authentication for custom auth servers (e.g: Ely.by).
- **Java Management:** Automatically downloads the correct JRE (8, 17, or 21), allows custom executable registration, and includes one-click JVM performance presets (Aikar's flags, Low-end).
- **Launcher Extras:** Auto-updater, customizable accent colors and themes (Dark/Light), crash report auto-copy, MultiMC/Prism instance import, and Discord Rich Presence.

---

## Downloads

Get the matching binary for your platform. These buttons automatically point to the latest stable release infrastructure.

<p align="left">
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20Windows-setup.exe-5316D4?style=flat-square&logo=windows11&logoColor=white" alt="Download Windows" height="28"/>
  </a>
  <br /><br />
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20macOS%20(M1/M2/M3)-arm64.dmg-5316D4?style=flat-square&logo=apple&logoColor=white" alt="Download macOS ARM" height="28"/>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20macOS%20(Intel)-x64.dmg-5316D4?style=flat-square&logo=apple&logoColor=white" alt="Download macOS Intel" height="28"/>
  </a>
  <br /><br />
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20Linux-AppImage-5316D4?style=flat-square&logo=linux&logoColor=white" alt="Download Linux AppImage" height="28"/>
  </a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://github.com/RefractMC/Refract_MC/releases/latest">
    <img src="https://img.shields.io/badge/Download%20for%20Ubuntu/Debian-.deb-5316D4?style=flat-square&logo=ubuntu&logoColor=white" alt="Download Linux Debian" height="28"/>
  </a>
</p>

> **Note for macOS users:** The DMG payload is currently unsigned. To bypass Apple Gatekeeper on initial launch, right-click the application icon and select **Open**.

---

## Community & Support

Feel free to open a GitHub issue if you hit a bug or want to suggest a feature. You can also join our interactive hub to chat with other community members and get live troubleshooting help:

[![Refract Discord Banner](https://discordapp.com/api/guilds/1507409148331954408/widget.png?style=banner3)]([https://discord.gg/7Q5sGzhUQJ](https://discord.gg/DQQCwuDjRs))

---

## Translations

All interface strings live in [`locales/en.json`](locales/en.json). To add a new localization target:

1. Copy `locales/en.json` and title it using the standard [BCP 47 language code](https://en.wikipedia.org/wiki/IETF_language_tag) (e.g: `fr.json`).
2. Translate the values directly—leave the JSON keys completely unmodified.
3. Open a pull request against the main branch.

Review [`locales/README.md`](locales/README.md) for the deep contribution guide.

---

## Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+

### Setup
```bash
git clone [https://github.com/RefractMC/Refract_MC.git](https://github.com/RefractMC/Refract_MC.git)
cd Refract_MC
pnpm install
pnpm dev
