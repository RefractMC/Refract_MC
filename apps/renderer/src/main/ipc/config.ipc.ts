import { totalmem } from 'os'
import { getConfig, setConfig, type AppConfig } from '../services/config'
import { listSafeAccounts } from '../services/auth'
import { handleIpc } from './handle'

export function registerConfigIpc(): void {
  handleIpc('config.get', () => {
    const config = getConfig()
    // strip encrypted token fields before sending to renderer
    return {
      ...config,
      accounts: listSafeAccounts(),
    }
  })

  handleIpc('config.set', (_event, key, value) => {
    setConfig(key as keyof AppConfig, value as AppConfig[keyof AppConfig])
  })

  handleIpc('system.ramGb', () => Math.floor(totalmem() / (1024 ** 3)))
}
