import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { paths } from './paths'

export interface AppConfig {
  activeAccountId: string | null
  activeThemeId: string
  windowBounds: { width: number; height: number; x?: number; y?: number }
  defaultMemoryMb: number
  onboardingDone: boolean
  curseforgeApiKey?: string
  minimizeToTray?: boolean
  startMinimized?: boolean
  launchMinimizesToTray?: boolean
  reopenOnGameExit?: boolean
  analyticsEnabled?: boolean      // anonymous usage analytics (opt-out; on by default)
  analyticsNoticeShown?: boolean  // first-run analytics notice has been dismissed
  accounts: Array<{
    uuid: string
    username: string
    type: 'microsoft' | 'offline' | 'yggdrasil'
    xuid?: string
    expiresAt?: number
    encryptedAccessToken?: string
    encryptedRefreshToken?: string
    yggdrasilServer?: string
  }>
}

function getConfigPath() { return join(paths.userData, 'config.json') }

const DEFAULTS: AppConfig = {
  activeAccountId: null,
  activeThemeId: 'dark',
  windowBounds: { width: 1280, height: 800 },
  defaultMemoryMb: 2048,
  onboardingDone: false,
  analyticsEnabled: true,
  analyticsNoticeShown: false,
  accounts: [],
}

let cache: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cache) return cache
  if (!existsSync(getConfigPath())) {
    cache = { ...DEFAULTS }
    saveConfig(cache)
    return cache
  }
  try {
    cache = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as AppConfig
    // merge in any missing defaults added in future versions
    cache = { ...DEFAULTS, ...cache }
    return cache
  } catch {
    cache = { ...DEFAULTS }
    return cache
  }
}

export function saveConfig(config: AppConfig): void {
  cache = config
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

export function getConfig(): AppConfig {
  return cache ?? loadConfig()
}

export function setConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  const config = getConfig()
  config[key] = value
  saveConfig(config)
}
