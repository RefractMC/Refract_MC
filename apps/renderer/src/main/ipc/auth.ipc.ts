import { ipcMain } from 'electron'
import {
  beginMicrosoftLogin,
  completeMicrosoftLogin,
  createOfflineAccount,
  getActiveAccount,
  listSafeAccounts,
  logoutAccount,
  setActiveAccount,
} from '../services/auth'

export function registerAuthIpc(): void {
  ipcMain.handle('auth.accounts', () => listSafeAccounts())
  ipcMain.handle('auth.active', () => getActiveAccount())
  ipcMain.handle('auth.microsoft.begin', () => beginMicrosoftLogin())
  ipcMain.handle('auth.microsoft.complete', (_event, deviceCode: string) => completeMicrosoftLogin(deviceCode))
  ipcMain.handle('auth.offline.create', (_event, username: string) => createOfflineAccount(username))
  ipcMain.handle('auth.setActive', (_event, uuid: string) => setActiveAccount(uuid))
  ipcMain.handle('auth.logout', (_event, uuid: string) => logoutAccount(uuid))
}
