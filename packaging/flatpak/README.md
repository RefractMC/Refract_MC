# Flatpak evaluation

Refract is not packaged as a Flatpak yet. A safe manifest needs a deliberate
portal and sandbox design before submission: the launcher downloads Minecraft
content, manages user-selected instance and Java directories, launches external
JVMs, opens folders, and optionally integrates with Discord. Granting broad
home-directory or host filesystem access would undermine those boundaries.

The current release remains available as an AppImage and through the other
package channels documented in [`docs/PACKAGING.md`](../../docs/PACKAGING.md).
Do not add a Flatpak manifest until instance storage, Java management, folder
opening, and network permissions can be implemented with portals or narrowly
scoped paths and reviewed on Flathub.
