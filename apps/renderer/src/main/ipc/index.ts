import { BrowserWindow } from 'electron'
import { registerWindowIpc } from './window.ipc'
import { registerConfigIpc } from './config.ipc'
import { registerInstanceIpc } from './instance.ipc'
import { registerThemeIpc } from './theme.ipc'
import { registerAuthIpc } from './auth.ipc'
import { registerLogIpc } from './log.ipc'
import { registerActivityIpc } from './activity.ipc'
import { registerModrinthIpc } from './modrinth.ipc'
import { registerMinecraftIpc } from './minecraft.ipc'
import { registerModpackIpc } from './modpack.ipc'
import { registerModsIpc } from './mods.ipc'
import { registerFriendsIpc } from './friends.ipc'
import { registerJavaIpc } from './java.ipc'
import { registerCurseForgeIpc } from './curseforge.ipc'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  registerLogIpc()
  registerWindowIpc(mainWindow)
  registerConfigIpc()
  registerInstanceIpc()
  registerThemeIpc()
  registerAuthIpc()
  registerActivityIpc()
  registerModrinthIpc()
  registerMinecraftIpc(mainWindow)
  registerModpackIpc(mainWindow)
  registerModsIpc()
  registerFriendsIpc()
  registerJavaIpc()
  registerCurseForgeIpc()
}
