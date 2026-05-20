import { ipcMain, BrowserWindow } from 'electron'
import { logError } from '../services/logger'
import { handleIpc } from './handle'

export function registerWindowIpc(mainWindow: BrowserWindow): void {
  ipcMain.on('window:minimize', () => {
    try {
      mainWindow.minimize()
    } catch (error) {
      logError('ipc:window:minimize', error)
    }
  })

  ipcMain.on('window:maximize', () => {
    try {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
    } catch (error) {
      logError('ipc:window:maximize', error)
    }
  })

  ipcMain.on('window:close', () => {
    try {
      mainWindow.close()
    } catch (error) {
      logError('ipc:window:close', error)
    }
  })

  handleIpc('window:isMaximized', () => mainWindow.isMaximized())

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized-change', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized-change', false)
  })
}
