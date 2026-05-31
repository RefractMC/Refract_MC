import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { registerAllIpcHandlers } from './ipc'
import { ensureAppDirs } from './services/paths'
import { loadConfig } from './services/config'
import { installProcessErrorLogging, logError } from './services/logger'
import { notify } from './services/notifications'
import { listInstances } from './services/instance-store'
import { launchInstance } from './services/minecraft/launcher'

installProcessErrorLogging()

const isDev = !app.isPackaged
let isQuitting = false

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

  mainWindow.on('ready-to-show', () => mainWindow.show())

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

function buildTrayMenu(mainWindow: BrowserWindow, tray: Tray): void {
  const instances = listInstances()
  const last = instances[0] ?? null
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Refract', click: () => { mainWindow.show(); mainWindow.focus() } },
    { type: 'separator' },
    last
      ? { label: `▶  ${last.name}`, click: () => {
            mainWindow.show(); mainWindow.focus()
            launchInstance(last.id, mainWindow).catch(() => {})
          }}
      : { label: 'No instances yet', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))
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

  // ── System tray ─────────────────────────────────────────────────────────────
  const iconPath = join(__dirname, '../../resources/icon.png')
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  const tray = new Tray(trayIcon)
  tray.setToolTip('Refract')
  buildTrayMenu(mainWindow, tray)
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus() })
  mainWindow.on('show', () => buildTrayMenu(mainWindow, tray))

  // Close → hide to tray instead of quit
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  ipcMain.on('updater:install',  () => autoUpdater.quitAndInstall())
  ipcMain.on('updater:download', () => autoUpdater.downloadUpdate().catch(() => {}))

  if (!isDev) {
    autoUpdater.autoDownload = false          // user decides when to download
    autoUpdater.on('update-available', (info: { version: string }) => {
      mainWindow.webContents.send('updater:available', { version: info.version })
    })
    autoUpdater.on('download-progress', (p: { percent: number }) => {
      mainWindow.webContents.send('updater:progress', { percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', () => {
      mainWindow.webContents.send('updater:downloaded')
      notify('Refract update ready', 'Click "Restart ↺" in the title bar to apply the update.')
    })
    autoUpdater.checkForUpdates().catch(() => {})
  }

  app.on('activate', () => {
    mainWindow.show(); mainWindow.focus()
  })
}).catch((error) => {
  logError('main:appReady', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — the tray keeps the app alive
  }
})

app.on('before-quit', () => { isQuitting = true })
