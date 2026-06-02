import type { CreateInstanceInput, Instance } from '@refract/core'
import { logger } from './logger'

export type RefractAPI = Window['api']
export type SafeAccount = Awaited<ReturnType<RefractAPI['auth']['accounts']>>[number]
export type DeviceLogin = Awaited<ReturnType<RefractAPI['auth']['microsoftBegin']>>
export type AppConfig = Awaited<ReturnType<RefractAPI['config']['get']>>

const CONFIG_KEY = 'refract.dev.config'
const INSTANCES_KEY = 'refract.dev.instances'

const DEFAULT_CONFIG: AppConfig = {
  activeAccountId: null,
  activeThemeId: 'dark',
  windowBounds: { width: 1280, height: 800 },
  defaultMemoryMb: 2048,
  onboardingDone: false,
  accounts: [],
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch (error) {
    logger.error(`browserApi:${key}:read`, error)
    return fallback
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    logger.error(`browserApi:${key}:write`, error)
  }
}

function getConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, ...readJson<AppConfig>(CONFIG_KEY, DEFAULT_CONFIG) }
}

function saveConfig(config: AppConfig): void {
  writeJson(CONFIG_KEY, config)
}

function getInstances(): Instance[] {
  return readJson<Instance[]>(INSTANCES_KEY, [])
}

function saveInstances(instances: Instance[]): void {
  writeJson(INSTANCES_KEY, instances)
}

function toGuestAccount(username: string): SafeAccount {
  return {
    uuid: crypto.randomUUID(),
    username,
    type: 'offline',
    canManageContent: true,
    canPlayMinecraft: false,
    licenseStatus: 'guest',
  }
}

function createInstance(input: CreateInstanceInput): Instance {
  return {
    ...input,
    id: crypto.randomUUID(),
    totalTimePlayed: 0,
    createdAt: new Date().toISOString(),
  }
}

function createBrowserApi(): RefractAPI {
  return {
    system: {
      ramGb: async () => 16,
    },
    config: {
      get: async () => getConfig(),
      set: async (key, value) => {
        const config = getConfig()
        saveConfig({ ...config, [key]: value })
      },
    },
    log: {
      write: (entry) => {
        if (entry.level === 'error') logger.error(entry.source, entry.stack ? `${entry.message}\n${entry.stack}` : entry.message)
        else if (entry.level === 'warn') logger.warn(entry.source, entry.message)
        else logger.info(entry.source, entry.message)
      },
      read:  async () => [],
      clear: async () => undefined,
    },
    auth: {
      accounts: async () => getConfig().accounts,
      active: async () => {
        const config = getConfig()
        return config.accounts.find((account) => account.uuid === config.activeAccountId) ?? null
      },
      microsoftBegin: async (): Promise<DeviceLogin> => {
        throw new Error('Microsoft login requires the Electron app. Browser preview supports guest profiles only.')
      },
      microsoftComplete: async () => {
        throw new Error('Microsoft login requires the Electron app. Browser preview supports guest profiles only.')
      },
      createOffline: async (username) => {
        const trimmed = username.trim()
        if (!trimmed) throw new Error('Username is required.')
        const config = getConfig()
        const account = toGuestAccount(trimmed)
        saveConfig({
          ...config,
          accounts: [account, ...config.accounts],
          activeAccountId: account.uuid,
        })
        return account
      },
      renameOffline: async (uuid, username) => {
        const trimmed = username.trim()
        if (!trimmed) throw new Error('Username is required.')
        const config = getConfig()
        const account = config.accounts.find((a) => a.uuid === uuid)
        if (!account) throw new Error(`Account not found: ${uuid}`)
        account.username = trimmed
        saveConfig(config)
        return account
      },
      setActive: async (uuid) => {
        const config = getConfig()
        const account = config.accounts.find((candidate) => candidate.uuid === uuid)
        if (!account) throw new Error(`Account not found: ${uuid}`)
        saveConfig({ ...config, activeAccountId: uuid })
        return account
      },
      logout: async (uuid) => {
        const config = getConfig()
        const accounts = config.accounts.filter((account) => account.uuid !== uuid)
        saveConfig({
          ...config,
          accounts,
          activeAccountId: config.activeAccountId === uuid ? accounts[0]?.uuid ?? null : config.activeAccountId,
        })
      },
      yggdrasilLogin: async () => { throw new Error('Yggdrasil login requires the Electron app.') },
    },
    theme: {
      list: async () => [],
      install: async () => {
        throw new Error('Theme import is available in the Electron app.')
      },
      delete: async () => undefined,
    },
    updater: {
      onAvailable:  () => () => undefined,
      onProgress:   () => () => undefined,
      onDownloaded: () => () => undefined,
      install:  () => undefined,
      download: () => undefined,
    },
    launcher: {
      deleteAll: async () => { throw new Error('Delete all requires the Electron app.') },
    },
    instance: {
      list: async () => getInstances(),
      getById: async (id) => getInstances().find((instance) => instance.id === id) ?? null,
      create: async (input) => {
        const instance = createInstance(input as CreateInstanceInput)
        saveInstances([instance, ...getInstances()])
        return instance
      },
      update: async (id, patch) => {
        const instances = getInstances()
        const existing = instances.find((instance) => instance.id === id)
        if (!existing) throw new Error(`Instance not found: ${id}`)
        const updated = { ...existing, ...patch }
        saveInstances(instances.map((instance) => instance.id === id ? updated : instance))
        return updated
      },
      delete: async (id: string) => {
        saveInstances(getInstances().filter((instance) => instance.id !== id))
      },
      openFolder:    async () => undefined,
      browseFolder:  async () => null,
      export:        async () => null,
      duplicate:     async () => null,
      importMultiMc: async () => { throw new Error('MultiMC import requires the Electron app.') },
    },
    window: {
      minimize: () => undefined,
      maximize: () => undefined,
      close: () => undefined,
      isMaximized: async () => false,
      onMaximizedChange: () => () => undefined,
    },
    activity: {
      list: async () => readJson<Array<{ id: string; label: string; ts: number }>>('refract.activity', []),
      add: async (label: string) => {
        const entry = { id: crypto.randomUUID(), label, ts: Date.now() }
        const entries = [entry, ...readJson<typeof entry[]>('refract.activity', [])].slice(0, 50)
        writeJson('refract.activity', entries)
        return entry
      },
    },
    modrinth: {
      search: async (query: string, gameVersion?: string, loader?: string, category?: string, limit = 20, offset = 0) => {
        const { searchMods } = await import('@refract/core')
        return searchMods(query, gameVersion, loader, category, limit, offset)
      },
      searchContent: async (opts) => {
        const { searchContent } = await import('@refract/core')
        return searchContent(opts)
      },
      versions: async (projectId: string, gameVersion?: string, loader?: string) => {
        const { getProjectVersions } = await import('@refract/core')
        return getProjectVersions(projectId, gameVersion, loader)
      },
      install: async () => { throw new Error('Mod install requires the Electron app.') },
      uninstall: async () => { throw new Error('Mod uninstall requires the Electron app.') },
      gameVersions: async () => {
        const { fetchGameVersions } = await import('@refract/core')
        return fetchGameVersions()
      },
      contentInstall: async () => { throw new Error('Content install requires the Electron app.') },
      checkModUpdates: async () => [],
      applyModUpdates: async () => [],
    },
    mods: {
      list:           async () => [],
      toggle:         async () => { throw new Error('Mod management requires the Electron app.') },
      delete:         async () => { throw new Error('Mod management requires the Electron app.') },
      installLocal:   async () => { throw new Error('Mod install requires the Electron app.') },
      profilesList:   async () => [],
      profilesSave:   async () => { throw new Error('Mod profiles require the Electron app.') },
      profilesApply:  async () => { throw new Error('Mod profiles require the Electron app.') },
      profilesDelete: async () => { throw new Error('Mod profiles require the Electron app.') },
      profilesRename: async () => { throw new Error('Mod profiles require the Electron app.') },
    },
    curseforge: {
      searchMods:     async () => { throw new Error('CurseForge requires the Electron app.') },
      searchModpacks: async () => { throw new Error('CurseForge requires the Electron app.') },
      files:          async () => { throw new Error('CurseForge requires the Electron app.') },
      install:        async () => { throw new Error('CurseForge requires the Electron app.') },
      installModpack: async () => { throw new Error('CurseForge requires the Electron app.') },
    },
    java: {
      managedList:  async () => [],
      requiredFor:  async () => 21,
      download:     async () => { throw new Error('Java download requires the Electron app.') },
      delete:       async () => { throw new Error('Java delete requires the Electron app.') },
      browseExe:    async () => null,
      addCustom:    async () => { throw new Error('Java management requires the Electron app.') },
      removeCustom: async () => { throw new Error('Java management requires the Electron app.') },
      onProgress:   () => () => undefined,
    },
    friends: {
      list:       async () => [],
      add:        async () => { throw new Error('Friends require the Electron app.') },
      remove:     async () => undefined,
      updateNote: async () => undefined,
    },
    modpack: {
      install: async () => { throw new Error('Modpack install requires the Electron app.') },
      openFileDialog: async () => null,
      installFromFile: async () => { throw new Error('Modpack install requires the Electron app.') },
      onProgress: () => () => undefined,
      onDone: () => () => undefined,
    },
    mc: {
      versions: async () => {
        const { fetchVersionList } = await import('@refract/core')
        return fetchVersionList()
      },
      java: async () => [],
      isRunning: async () => false,
      install: async () => { throw new Error('MC install requires the Electron app.') },
      repair: async () => { throw new Error('MC repair requires the Electron app.') },
      launch: async () => { throw new Error('MC launch requires the Electron app.') },
      stop: async () => undefined,
      crashReport: async () => null,
      worlds: async () => [],
      deleteWorld: async () => undefined,
      screenshots: async () => [],
      openScreenshot:  async () => undefined,
      screenshotFull:  async () => null,
      servers:     async () => [],
      pingServer:  async () => null,
      backupWorld: async () => null,
      onProgress: () => () => undefined,
      onLog: () => () => undefined,
      onExit: () => () => undefined,
    },
  }
}

function wrapApi<T>(value: T, path = 'api'): T {
  if (typeof value === 'function') {
    return ((...args: unknown[]) => {
      try {
        const result = (value as (...innerArgs: unknown[]) => unknown)(...args)
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            logger.error(path, error)
            throw error
          })
        }
        return result
      } catch (error) {
        logger.error(path, error)
        throw error
      }
    }) as T
  }

  if (value && typeof value === 'object') {
    const wrapped: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      wrapped[key] = wrapApi(child, `${path}.${key}`)
    }
    return wrapped as T
  }

  return value
}

const electronApi = (window as Window & { api?: RefractAPI }).api

if (!electronApi) {
  logger.warn('browserApi', 'Electron preload API is unavailable; using browser preview storage.')
}

export const api: RefractAPI = wrapApi(electronApi ?? createBrowserApi())
