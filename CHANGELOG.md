# Changelog

## 1.3.1

### Updates

* Fixed release finalization so the auto-updater manifest points to the stable installer assets.
* Added parallel downloads, post-install verification, and automatic resolution for blocked mod dependencies.
* Improved the startup loader, install dialog selection, pagination behavior, theme corner radii, and button hover feedback.
* Refined the Simplified Chinese translation for the latest content-management messages.
* Replaced the native font suggestion popup with Refract's searchable installed-font picker on Windows and Linux.

## 1.3.0
### Playing

* Added **Quick Play**, allowing you to launch directly into a server or world from the launcher.
* Added desktop shortcuts that launch a specific world or server in one click.
* Added **Play Offline** when Microsoft authentication servers are unavailable.
* Added per-instance window size, fullscreen, and launch hook settings.
* Added a warning when available system RAM is lower than the instance allocation.
* Added game options synchronization between instances.

### Instances & Content

* Added instance exports in the Modrinth **`.mrpack`** format.
* Added support for importing worlds from ZIP backups.
* Improved archive instance imports with automatic layout, mod loader, and Minecraft version detection.
* Added datapacks to content update checks.
* Fixed incomplete CurseForge modpack installations that could leave files missing.
* Added Java 25 detection.
* Failed game launches are now written to the launcher log.

### UI & Localization

* Added a Simplified Chinese translation and expanded UI localization.
* Replaced text-based loading states with skeleton loaders.
* Added an optional pixel cat companion to the home screen.
* Account sessions are now proactively validated on the accounts page.
* Fixed dialogs being covered by the sidebar on smaller windows.

### Linux

* Fixed intermittent UI freezes by disabling the WebKitGTK DMA-BUF renderer.
* Fixed the application opening in an extremely small window.
* Restored frameless window controls.
* The launcher now opens maximized on first launch across all platforms.

### Other

* Added one-line installation support through `install.config.json` using mget.
* Release assets now include stable, version-independent filenames for permanent download URLs.
* Added code-signing and notarization pipelines for Windows and macOS builds.
* Reduced release binary sizes and improved performance using LTO and stripped symbols.


## 1.2.0
- **Tauri desktop app** - Refract now ships as a Tauri app with the same app identity and the same launcher data folder, so existing instances, settings, themes, worlds, screenshots, options, and server lists carry over.
- **Electron-to-Tauri migration** - old Electron installs can update through a one-time bridge that downloads and starts the new Tauri installer; future updates are handled by the Tauri updater.
- **Account migration note** - Microsoft accounts need a one-time sign-in again because tokens now live in a new secure vault; offline accounts continue to work.
- **Native backend port** - install, launch, auth, Java management, mods, modpacks, worlds, screenshots, servers, skins, logs, activity, and Discord presence now run through the Rust/Tauri backend.
- **Updater and release flow** - added signed Tauri updater artifacts, latest.json support, release workflows, and bridge release automation.
- **UI polish** - refreshed top title bar, theme-aware chrome, sidebar controls, activity bell, theme manager, Minecraft News tab, Modrinth modpack changelogs, and packaged skin/friend heads.
- **Reliability and security** - hardened Tauri capabilities, download paths, runtime panic handling, update checks, Forge/NeoForge launch paths, import rollback, crash diagnostics, and dependency audit overrides.

## 1.1.3
- **Refreshed look** — a cleaner, flatter design across the app: a single consistent button style, calmer surfaces with the purple accent, and the pixel font and busy background effects retired.
- **FTB modpacks** — browse, search and install Feed The Beast packs (with a version picker) right alongside Modrinth and CurseForge.
- **Automatic Java** — Refract now downloads and picks the correct Java runtime for each version on demand, so launches and Forge/NeoForge installs no longer dead-end when the right Java isn't installed.
- **Mod dependency resolution** — installing a mod now pulls its required dependencies automatically (recursively, for both Modrinth and CurseForge), and lets you opt into optional ones.
- **Modpack updates** — instances created from a modpack show when a newer version is available and can update in place — your worlds, screenshots, options and server list are kept.
- **Custom groups** — create your own instance groups, drag to reorder them, and drag instances in; works even before a group has any instances.
- **Non-Latin instance names** — Ukrainian/Cyrillic (and other) instance names now launch reliably; the display name stays as you typed it.
- **Honest status bar** — shows real connection status, the installed Java version, and memory instead of placeholder readouts.
- **Fix:** Forge/NeoForge installs and Quilt launches now work; modpack mods that come from CurseForge download correctly.
- **Fix:** scrolling inside a mod/modpack popup no longer scrolls the page behind it.
- **Polish:** in-app dialogs for moving instances to a group and confirming deletes (no more native pop-ups), with full Ukrainian translations.

## 1.1.2
- **Collapse the sidebar from the sidebar** — a new « / » toggle in the sidebar header collapses the menu to an icon rail and back, no trip to Settings. It animates, syncs with the Settings → sidebar width control, and restores your last expanded width.
- **Clearer expired-login handling** — when your Microsoft (or Yggdrasil) session can no longer be refreshed, Refract now shows *"Your session expired — please sign in again"* and takes you to Accounts, where the affected account has a one-click **Sign in again** button, instead of surfacing a raw error on launch.
- **Anonymous usage analytics (opt-out)** — Refract now sends anonymous usage events (app opens, page views, launches/installs, errors) to help guide development. No personal data, accounts, or file paths are collected. It's on by default with a first-run notice and a **Settings → Privacy** toggle to turn it off at any time.

## 1.1.1
- **Sync instances from other launchers** — a new Sync panel detects instances from Prism Launcher, MultiMC, Modrinth, ATLauncher, CurseForge, and GDLauncher, and lets you link (launch in place) or import (copy into Refract) them.
- **Smooth page transitions** — navigating between pages now animates with a horizontal slide and blur.
- **Old Minecraft versions get their assets** — pre-1.7 / legacy versions now receive their sounds, language files, and menu icons (virtual/legacy asset trees are materialised on install).
- **Fix:** NeoForge / Forge launch reliability — clearer errors when an install is incomplete, a custom Java path pointing at a JDK folder now resolves to the right executable, the closest matching Java is chosen instead of the newest, and duplicate loader libraries no longer break older Forge.
- **Fix:** Running state now survives a launcher restart — Stop and the "already running" guard keep working if you reopen Refract while a game is still running.
- **Fix:** The 🔥 daily streak now rolls over at your local midnight instead of UTC, so late-evening sessions count on the right day.
- **Fix:** Sync panel works in all builds, is fully translated to Ukrainian, and uses the correct accent styling.
- **Fix:** Custom JVM arguments containing quoted values with spaces (e.g. a Windows path) are no longer split incorrectly.
- **Fix:** Downloads now follow modern HTTP redirects (307/308) and relative redirect URLs, fixing some mirror/CDN failures.
- **Fix:** Content added to a linked external instance now goes to that instance's own game folder; installs can be cancelled per-instance.
- **Security:** Renderer sandbox enabled, world/screenshot/asset file operations hardened against path traversal, production builds no longer open devtools, and untrusted HTML is stripped via an inert parser.

## 1.1.0
- **Fire streak** — Playtime panel shows a 🔥 daily streak counter with TikTok-style color tiers: light orange (1–30 days), fire red (31–90), purple (90+). Two streak saves per calendar month let you miss a day without breaking it.
- **Launch behavior settings** — New settings section: minimize to tray on close, start minimized, hide window on game launch, reopen automatically when the game exits.
- **Compact sidebar** — Compact mode now shows icons only with no text labels; switching widths animates smoothly.
- **Skin preview on friend avatar click** — Clicking a friend's avatar in the Friends panel opens a 3D skin viewer popup.
- **Full Ukrainian translation** — Accent color panel, launch behavior settings, and Playtime panel (day labels, streak, saves) fully translated.
- **Fix:** Forge installer no longer crashes with "Invalid URL" on libraries bundled inside the installer JAR.
- **Fix:** Microsoft login now correctly reads the Xbox User ID from the XSTS token response.
- **Fix:** Playtime panel shows full time including minutes (e.g. "2h 29m total" instead of "2h total").
- **Fix:** Tray quick-launch shows all pinned instances (up to 6) instead of only the first instance.
- **Fix:** Editing an instance's Minecraft version or mod loader now clears the install flag so INSTALL is shown correctly.
- **Fix:** Custom accent color no longer resets when switching themes or changing sidebar width.
- **Fix:** Removed misleading version chips from friend cards.

## 1.0.8
- **System tray (opt-in)** — Settings → Appearance → "Minimize to tray" toggle. When enabled, clicking ✕ hides the launcher to the system tray instead of quitting; double-click the tray icon to restore. Off by default
- **Instance templates** — 6 one-click presets in the Create Instance form: Vanilla, Fabric, NeoForge, Performance (Fabric + Aikar's JVM flags), 1.8.9 PvP, Speedrun. Each chip pre-fills loader, memory, and version
- **Animated background** — subtle slow-moving ambient glow behind the instance library that inherits your accent colour
- **CurseForge modpack detail view** — clicking a CF modpack card opens a full detail page (gallery, description, categories, links) before installing — same as Modrinth
- **CurseForge mod detail view** — same detail modal for mods in Browse Mods
- **Bulk instance operations** — Select button in the library header activates multi-select; bulk delete, move to group, or select all
- **Better crash dialog** — shows the last 20 game console lines above the crash report so you can see what happened before the crash
- **Skin face thumbnails** — the skin list on the Skins page shows a 2D face crop from the actual PNG instead of a generic icon
- **Browse Mods: remember filters** — selected game version and loader are saved and restored between sessions
- **Memory optimisation** — Three.js/skinview3d lazy-loads only when the Skins page is visited; V8 heap capped at 512 MB; GPU shader disk cache disabled
- **Fix: userData path pinned** — renaming the product name no longer causes user data (instances, accounts, settings) to disappear on upgrade
- **Fix: sidebar account button hover** — white tint and offset hover background corrected
- **Fix: page navigation lag** — Java detection cached (5 min), mod update checks deferred 8 s, settings Java scan deferred 3 s

## 1.0.7
- **Skin manager** — new Skins page in the sidebar: save a personal library of skin PNGs, preview them in a 3D rotating player model (powered by skinview3d), and upload directly to your Microsoft account with one click; Classic (Steve) and Slim (Alex) variants supported
- **3D skin viewer** — full Three.js-based player model in the Accounts page skin panel and the Skins library; skin textures loaded as base64 data URIs to work correctly in packaged Electron builds
- **Fix: close button fully quits** — clicking ✕ now exits the process; a single-instance lock also prevents duplicate launcher processes when re-opening
- **Fix: offline accounts can launch** — removed the incorrect "Buy Minecraft" block for offline/guest profiles; they can now launch instances and connect to offline-mode servers
- **Fix: sidebar Account nav removed** — clicking the avatar block at the top navigates to Accounts, reducing the nav to 3 items (Library, Browse Mods, Modpacks, Skins)
- **Fix: modpack install no longer blocks the UI** — download progress moved to a non-blocking 320px floating card at the bottom-right; browse, search, and navigate freely while a modpack installs
- **Fix: tab content cached in instance detail** — Worlds, Screenshots, Servers, and Updates tabs no longer re-fetch on every revisit; data is loaded once per dialog open
- **Fix: Minecraft version list cached** — version list is cached for 30 minutes in the main process; opening Create/Edit Instance is now instant after the first load
- **Fix: Modrinth game versions cached** — the version filter dropdown in Browse Mods caches for 1 hour
- **Fix: window title** — title bar and taskbar now show "Refract Launcher" instead of "Refract"
- **Fix: Ukrainian localization** — Yggdrasil auth section, CurseForge modpacks panel, Skins page, and account skin panel are now fully translated; "Install as Instance" shortened to "ВСТАНОВИТИ"

## 1.0.6
- **New Instance redesign** — completely rebuilt dialog with violet brand system, live preview card (pixel skyline, updates as you type), segmented mod loader control, GB memory slider that reads your system's actual RAM
- **Edit Instance redesign** — same brand system applied to the Edit dialog with matching live preview, JVM presets (Aikar's / Low-end), and danger-zone delete flow
- **Playtime stats panel** — per-instance bar chart and 7-day activity chart on the home page showing hours played
- **Mod dependency resolver** — when installing a mod from Browse Mods, Refract checks required dependencies and offers to install missing ones in the same step
- **Version release notes** — the version picker now shows a one-line "What's new" blurb from Mojang's patch notes when you select a Minecraft version
- **Recommended mods** — Browse Mods shows popular mods filtered to your most-recently-played instance's version and loader when search is empty
- **Ely.by / Yggdrasil fix** — login now retries both `/authserver/authenticate` and `/auth/authenticate` endpoints, fixing "Page not found" errors on Ely.by
- **Fix:** app now starts on the Instance Library instead of an "Unknown page" on fresh installs (switched to hash history routing)
- **Fix:** Discord invite link updated

## 1.0.5
- **System tray** — closing the window now minimises to the system tray instead of quitting; double-click to restore, right-click for a quick-launch menu with the last-played instance and Quit
- **Opt-in updates** — the launcher no longer downloads updates automatically; a chip appears in the title bar when a new version is found with an **Update** button to start the download and a **✕** to dismiss and stay on the current version
- **Mod search** — a search bar appears in the Mods tab when more than 6 mods are installed, filtering by name in real time
- **Notifications** — native OS notifications fire when a modpack finishes installing, when Minecraft crashes, and when an update download is ready
- **Playtime chart** — a 7-day mini bar chart appears in the instance detail header after the first play session; today's bar is shown in the accent colour
- **Instance-aware mod browser** — pick an instance from the Browse Mods page to see which mods are already **DOWNLOADED**, which have an **UPDATE** available, and which are **incompatible** with the instance's version or loader; selecting an instance auto-applies its MC version and loader as filters
- **Fix:** memory slider now caps to actual system RAM instead of always showing 32 GB as the maximum
- **Fix:** What's New panel now fetches release notes directly from CHANGELOG.md (always up to date) and scrolls instead of expanding the layout
- **Fix:** Ukrainian language now fully covers the instance detail modal (tabs, empty messages, buttons, profiles, server ping labels)
- **Fix:** Create/Edit instance dialogs widened to 640 px to accommodate longer Ukrainian text
- **Fix:** language segment buttons auto-size to their text; memory quick-pick buttons wrap on high-RAM machines

## 1.0.4
- **Custom accent color** — pick any colour in Settings → Appearance via preset swatches or a full colour picker; persisted across restarts with derived hi/lo/tint variants
- **Bulk mod operations** — checkboxes on every mod row; a bulk action bar appears with Enable / Disable / Delete and Select-all when any are ticked
- **JVM performance presets** — one-click "Aikar's flags" and "Low-end" preset buttons below the JVM args field in Edit Instance
- **World backup** — Backup button on each world row opens a Save dialog and zips the world folder to any location
- **Screenshot lightbox** — clicking a screenshot now opens a full-res in-app viewer instead of the OS photo app; Escape or click outside closes only the viewer, not the parent dialog
- **CurseForge modpacks** — Modpacks browser has a Modrinth / CurseForge source toggle; CurseForge modpacks download and install via the existing manifest.json pipeline (requires a CurseForge API key in Settings)
- **Sort in Browse Mods** — same sort dropdown as the Modpacks page (Most Downloaded, Newest, etc.) is now available on the Modrinth mod browser
- **Page jump** — pagination on Browse Mods and Modpacks now includes an editable page-number input; type a number and press Enter to jump directly
- **Custom instance location** — a Location field + Browse button in Create Instance lets you store any instance outside the default AppData folder
- **Custom Java path** — Settings → Java Runtime now has a text field and Browse button to register any java/java.exe executable; validates on add and shows a gold "custom" badge in the list
- **Hover glow** — all buttons in the app brighten on hover via a global CSS rule
- **Fix:** closing gallery images or screenshot lightbox no longer accidentally dismisses the parent modal (all backdrops now use target === currentTarget guard)
- **Fix:** What's New release notes are now auto-populated from CHANGELOG.md by CI after each build

## 1.0.3
- **Fix:** Nav icons showed as white squares in the installed app — SVGs are now embedded as data URIs at build time instead of referencing file paths, which broke under Electron's `file://` protocol

## 1.0.2
- **Auto-updater UI** — update download progress and a "Restart ↺" button now appear in the title bar when a new version is available; no more silent updates
- **Onboarding step 3** — after creating a first instance the onboarding now shows an "Install & play" slide that explains the INSTALL button and Java auto-download, closing the most common first-run confusion
- **Skin faces on account page** — saved Microsoft and Yggdrasil profiles now show the player's live Minecraft skin face instead of a blank initial; custom uploaded avatars still take priority
- **macOS build target** — release pipeline now produces universal DMG (x64 + arm64) in addition to Windows NSIS and Linux AppImage/deb
- **Community translations** — all UI strings moved to `locales/en.json` and `locales/uk.json`; new languages can be added by copying `en.json` and opening a PR (see `locales/README.md`)
- **Danger zone in Settings** — two-step confirmation to permanently delete all launcher data and exit

## 1.0.1
- **Server ping** — each saved server in the Servers tab shows live latency (colour-coded) and online/max player count; offline servers show a red dot
- **Mod profiles** — save and apply named sets of enabled mods per instance (e.g. "Survival", "Performance"); profiles are stored next to the instance and batch-enable/disable mods on apply
- **Danger zone** — new section at the bottom of Settings with a two-step confirmation to permanently delete all launcher data (instances, mods, themes, Java, cache) and exit
- **Community translations** — all UI strings extracted to `locales/en.json` and `locales/uk.json` with `{{param}}` template syntax; contributors can add a new language by copying `en.json` and opening a PR (see `locales/README.md`)

## 1.0.0
- **Instance detail view** — click any instance card to open a full-screen panel with tabs for Mods, Resource Packs, Shaders, Datapacks, Worlds, Screenshots, Servers, and Updates; modal is fixed at 860 px wide
- **Change instance image** — click the instance icon inside the detail view to replace it with any image from disk
- **Add mods from file** — "+ Add File" button in the detail view installs a local `.jar` directly into the instance mods folder
- **One-click mod updates** — Updates tab shows available Modrinth updates per mod; update individually or all at once
- **Servers tab** — reads `servers.dat` and lists all saved multiplayer servers with icon and IP copy button
- **Yggdrasil authentication** — sign in with any third-party Minecraft auth server (custom server owners / offline servers); stored and refreshed the same way as Microsoft tokens
- **Instance search and filter** — search bar on the Library page filters by name, mod loader, and Minecraft version simultaneously
- **Instance group drag-and-drop** — drag instance cards between groups to reorganise; ungrouped instances have their own section
- **Crash report auto-copy** — when Minecraft crashes the crash log is automatically copied to the clipboard; a "Copy Log" button is also shown in the crash dialog
- **SVG navigation icons** — pixel-art nav icons replaced with clean outlined SVG icons that inherit the active/inactive colour via CSS mask
- **Discord logo** — Discord button in the sidebar now shows the official Discord mark instead of an emoji

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
