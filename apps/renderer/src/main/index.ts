import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { registerAllIpcHandlers } from './ipc'
import { ensureAppDirs } from './services/paths'
import { loadConfig, getConfig } from './services/config'
import { installProcessErrorLogging, logError } from './services/logger'
import { notify } from './services/notifications'
import { listInstances } from './services/instance-store'
import { launchInstance } from './services/minecraft/launcher'
import { initAnalytics } from './services/analytics'

installProcessErrorLogging()

// Reduce GPU/renderer memory footprint
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512')

// Pin userData to "Refract" so renaming productName never loses user data
app.setPath('userData', join(app.getPath('appData'), 'Refract'))

// Prevent a second instance from spawning — focus the existing window instead
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

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
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => { if (!getConfig().startMinimized) mainWindow.show() })

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
  const pinned = instances.filter(i => i.pinned).slice(0, 6)
  const quickLaunch = pinned.length > 0 ? pinned : instances.slice(0, 1)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Refract', click: () => { mainWindow.show(); mainWindow.focus() } },
    { type: 'separator' },
    ...(quickLaunch.length > 0
      ? quickLaunch.map(inst => ({
          label: `▶  ${inst.name}`,
          click: () => { mainWindow.show(); mainWindow.focus(); launchInstance(inst.id, mainWindow).catch(() => {}) },
        }))
      : [{ label: 'No instances yet', enabled: false } as Electron.MenuItemConstructorOptions]),
    { type: 'separator' as const },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))
}

app.whenReady().then(() => {
  ensureAppDirs()
  loadConfig()
  initAnalytics()
  if (process.platform === 'win32') app.setAppUserModelId('com.refract')
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (event, input) => {
      if (isDev && input.key === 'F12') { window.webContents.toggleDevTools(); event.preventDefault() }
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

  // ✕ behaviour depends on the "Minimize to tray" setting
  app.on('second-instance', () => { mainWindow.show(); mainWindow.focus() })
  mainWindow.on('close', (e) => {
    if (!isQuitting && getConfig().minimizeToTray) {
      e.preventDefault()
      mainWindow.hide()
    } else {
      isQuitting = true
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
  if (process.platform !== 'darwin' && !getConfig().minimizeToTray) app.quit()
})

app.on('before-quit', () => { isQuitting = true })
