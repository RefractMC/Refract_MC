import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { registerAllIpcHandlers } from './ipc'
import { ensureAppDirs } from './services/paths'
import { loadConfig } from './services/config'
import { installProcessErrorLogging, logError } from './services/logger'

installProcessErrorLogging()

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  ensureAppDirs()
  loadConfig()
  if (process.platform === 'win32') app.setAppUserModelId('com.refract')
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') { window.webContents.toggleDevTools(); event.preventDefault() }
    })
  })

  const mainWindow = createWindow()
  registerAllIpcHandlers(mainWindow)

  ipcMain.on('updater:install', () => autoUpdater.quitAndInstall())

  if (!isDev) {
    autoUpdater.on('update-available', (info: { version: string }) => {
      mainWindow.webContents.send('updater:available', { version: info.version })
    })
    autoUpdater.on('download-progress', (p: { percent: number }) => {
      mainWindow.webContents.send('updater:progress', { percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', () => {
      mainWindow.webContents.send('updater:downloaded')
    })
    autoUpdater.checkForUpdates().catch(() => {})
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  logError('main:appReady', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
