# Changelog

## 0.5.1
- All instance cards now uniform — every card has PLAY, MODS, CONSOLE, and Edit
- Java detector now scans Minecraft launcher bundled runtimes (no more ENOENT)
- Forge/NeoForge: installer runs processors that patch the client JAR correctly

## 0.5.0
- Forge and NeoForge modloader install pipeline with processor support
- Mod manager inside each instance: list, enable/disable, delete mods
- Live console log reader for running Minecraft sessions
- Silent crashes now show an error toast with the exit code or message
- Persistent log file saved to AppData; viewable from Settings

## 0.4.0
- Full MC launch pipeline: download, extract natives, assets, Fabric support
- Mod browser powered by Modrinth (mods, shaders, resource packs, modpacks)
- Activity log panel on the Library page
- Modpack install from .mrpack files with automatic Minecraft setup

## 0.3.0
- Avatar and cover image picker for accounts and instances
- Sidebar profile picture reflects the active account and updates live
- Security fixes: path traversal, Zip Slip, HTTPS downgrade, token storage

## 0.2.0
- Instance tabs, delete from Edit dialog, live Minecraft version picker
- Microsoft OAuth device-code flow and offline account support
- PixelScene biome previews on instance cards

## 0.1.0
- Core IPC bridge, config service, and instance management
- App shell, sidebar, TitleBar, and theme engine with Minecraft palette
