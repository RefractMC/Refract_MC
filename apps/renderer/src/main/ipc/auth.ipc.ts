import {
  beginMicrosoftLogin,
  completeMicrosoftLogin,
  createOfflineAccount,
  getActiveAccount,
  listSafeAccounts,
  logoutAccount,
  setActiveAccount,
} from '../services/auth'
import { handleIpc } from './handle'

export function registerAuthIpc(): void {
  handleIpc('auth.accounts', () => listSafeAccounts())
  handleIpc('auth.active', () => getActiveAccount())
  handleIpc('auth.microsoft.begin', () => beginMicrosoftLogin())
  handleIpc('auth.microsoft.complete', (_event, deviceCode) => completeMicrosoftLogin(String(deviceCode)))
  handleIpc('auth.offline.create', (_event, username) => createOfflineAccount(String(username)))
  handleIpc('auth.setActive', (_event, uuid) => setActiveAccount(String(uuid)))
  handleIpc('auth.logout', (_event, uuid) => logoutAccount(String(uuid)))
}
