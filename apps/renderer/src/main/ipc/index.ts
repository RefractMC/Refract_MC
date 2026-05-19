import { BrowserWindow } from 'electron'
import { registerWindowIpc } from './window.ipc'
import { registerConfigIpc } from './config.ipc'
import { registerInstanceIpc } from './instance.ipc'
import { registerThemeIpc } from './theme.ipc'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  registerWindowIpc(mainWindow)
  registerConfigIpc()
  registerInstanceIpc()
  registerThemeIpc()
}
