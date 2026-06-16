import type { CreateInstanceInput, Instance } from '@refract/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog'
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
    skins: {
      list:    async () => [],
      browse:  async () => null,
      add:     async () => { throw new Error('Skins require the Electron app.') },
      delete:  async () => undefined,
      getPath:    async () => '',
      getDataUrl:    async () => null,
      fileToDataUrl: async () => null,
      apply:   async () => { throw new Error('Skins require the Electron app.') },
    },
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
    analytics: {
      track: () => undefined,
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
      fetchSkinTextureUrl: async () => null,
      browseSkin: async () => null,
      uploadSkin: async () => { throw new Error('Skin upload requires the Electron app.') },
      fetchCapes: async () => [],
      setCape: async () => { throw new Error('Cape management requires the Electron app.') },
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
      importMultiMc:  async () => { throw new Error('MultiMC import requires the Electron app.') },
      scanExternal:   async () => [],
      linkExternal:   async () => { throw new Error('Link requires the Electron app.') },
      importExternal: async () => { throw new Error('Import requires the Electron app.') },
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
      planDeps:       async () => [],
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
      projectDetail:  async () => { throw new Error('CurseForge requires the Electron app.') },
      installModpack: async () => { throw new Error('CurseForge requires the Electron app.') },
    },
    ftb: {
      search:         async () => [],
      modpack:        async () => { throw new Error('FTB requires the Electron app.') },
      installModpack: async () => { throw new Error('FTB requires the Electron app.') },
    },
    java: {
      managedList:  async () => [],
      requiredFor:  async () => 21,
      ensureFor:    async () => 21,
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
      checkUpdate: async () => null,
      update: async () => { throw new Error('Modpack update requires the Electron app.') },
      onProgress: () => () => undefined,
      onDone: () => () => undefined,
    },
    mc: {
      versions: async () => {
        const { fetchVersionList } = await import('@refract/core')
        return fetchVersionList()
      },
      forgeVersions: async () => ({ versions: [] }),
      neoforgeVersions: async () => [],
      fabricVersions: async () => [],
      quiltVersions: async () => [],
      cancelInstall: async () => undefined,
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

// Running inside the Tauri shell during migration: there's no Electron preload,
// so build the API from Tauri commands. Domains not yet ported reuse the browser
// fallback (so nothing crashes); ported ones call into Rust via invoke().
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

if (!electronApi && !isTauri) {
  logger.warn('browserApi', 'Electron preload API is unavailable; using browser preview storage.')
}

// Tauri rejects invoke() with a plain string (the Rust Err). The UI checks
// `e instanceof Error`, so a bare string surfaces as "Unknown error" and hides
// the real message — wrap every call so failures reject with a real Error.
function tinvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return invoke(cmd, args).catch((e: unknown) => {
    if (e instanceof Error) throw e
    throw new Error(typeof e === 'string' ? e : e == null ? 'Unknown error' : JSON.stringify(e))
  })
}

function createTauriApi(): RefractAPI {
  const base = createBrowserApi()
  return {
    ...base,
    config: {
      ...base.config,
      get: (() => tinvoke('config_get')) as RefractAPI['config']['get'],
      set: ((key: string, value: unknown) => tinvoke('config_set', { key, value })) as RefractAPI['config']['set'],
    },
    instance: {
      ...base.instance,
      list: (() => tinvoke('instances_list')) as RefractAPI['instance']['list'],
      getById: ((id: string) => tinvoke('get_instance_by_id', { id })) as RefractAPI['instance']['getById'],
      create: ((input: CreateInstanceInput) => tinvoke('create_instance', { input })) as RefractAPI['instance']['create'],
      update: ((id: string, patch: Partial<Instance>) => tinvoke('update_instance', { id, patch })) as RefractAPI['instance']['update'],
      delete: ((id: string) => tinvoke('delete_instance', { id })) as RefractAPI['instance']['delete'],
      openFolder: ((id: string) => tinvoke('open_instance_folder', { id })) as RefractAPI['instance']['openFolder'],
      duplicate: ((id: string) => tinvoke('duplicate_instance', { id })) as RefractAPI['instance']['duplicate'],
      browseFolder: (async () => {
        const p = await dialogOpen({ directory: true, multiple: false })
        return typeof p === 'string' ? p : null
      }) as RefractAPI['instance']['browseFolder'],
      export: (async (id: string) => {
        const dest = await dialogSave({ defaultPath: 'instance.zip', filters: [{ name: 'ZIP Archive', extensions: ['zip'] }] })
        if (!dest) return null
        return tinvoke('export_instance', { id, destPath: dest })
      }) as RefractAPI['instance']['export'],
    },
    // Modrinth stays on the fallback — its API is CORS-open, so the WebView
    // reaches it directly. CurseForge (key + no CORS) and FTB go through Rust.
    curseforge: {
      ...base.curseforge,
      searchMods: ((query?: string, gameVersion?: string, _loader?: string, pageSize?: number, index?: number) =>
        tinvoke('curseforge_search', { classId: 6, query, gameVersion, pageSize, index })) as RefractAPI['curseforge']['searchMods'],
      searchModpacks: ((query?: string, gameVersion?: string, pageSize?: number, index?: number) =>
        tinvoke('curseforge_search', { classId: 4471, query, gameVersion, pageSize, index })) as RefractAPI['curseforge']['searchModpacks'],
      files: ((modId: number, gameVersion?: string, loader?: string) =>
        tinvoke('curseforge_files', { modId, gameVersion, loader })) as RefractAPI['curseforge']['files'],
      projectDetail: ((modId: number) => tinvoke('curseforge_project_detail', { modId })) as RefractAPI['curseforge']['projectDetail'],
      install: (async (instanceId: string, modId: number, fileId: number, displayName: string) => {
        const instance = await tinvoke('get_instance_by_id', { id: instanceId }) as Instance | null
        if (!instance) throw new Error(`Instance not found: ${instanceId}`)
        const files = await tinvoke('curseforge_files', { modId }) as Array<Record<string, unknown>>
        const file = files.find(f => f.id === fileId)
        if (!file) throw new Error(`CurseForge file ${fileId} not found`)
        let url = file.downloadUrl as string | undefined
        if (!url) url = await tinvoke('curseforge_download_url', { modId, fileId }) as string
        if (!url) throw new Error(`No download URL available for ${displayName}`)
        const gameVersions = (file.gameVersions as string[] | undefined) ?? []
        const gameVersion = gameVersions.find(v => !/^(forge|fabric|neoforge|quilt)/i.test(v)) ?? instance.minecraftVersion
        const mod = {
          projectId: `cf:${modId}`, versionId: String(fileId), name: displayName,
          fileName: file.fileName as string, fileSize: file.fileLength as number,
          loader: instance.modLoader ?? 'unknown', gameVersion, installedAt: new Date().toISOString(),
        }
        return tinvoke('install_mod_file', { instanceId, url, fileName: file.fileName, mod })
      }) as RefractAPI['curseforge']['install'],
      installModpack: ((name: string, modId: number, fileId: number) =>
        tinvoke('curseforge_install_modpack', { name, modId, fileId })) as RefractAPI['curseforge']['installModpack'],
    },
    ftb: {
      ...base.ftb,
      search: ((query?: string, limit?: number) => tinvoke('ftb_search', { query, limit })) as RefractAPI['ftb']['search'],
      modpack: ((id: number) => tinvoke('ftb_modpack', { id })) as RefractAPI['ftb']['modpack'],
      installModpack: ((name: string, packId: number, versionId: number) =>
        tinvoke('ftb_install_modpack', { name, packId, versionId })) as RefractAPI['ftb']['installModpack'],
    },
    // Modpack install (Modrinth .mrpack / CF / FTB) — each downloads files,
    // reuses install_minecraft, and streams modpack://progress + modpack://done.
    modpack: {
      ...base.modpack,
      install: ((name: string, projectId: string, versionId?: string) =>
        tinvoke('modpack_install', { name, projectId, versionId })) as RefractAPI['modpack']['install'],
      onProgress: ((cb: (data: { projectId: string; step: string; percent: number }) => void) => {
        let off: (() => void) | undefined
        void listen<{ projectId: string; step: string; percent: number }>('modpack://progress', e => cb(e.payload)).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['modpack']['onProgress'],
      onDone: ((cb: (data: { projectId: string; instanceId?: string; error?: string }) => void) => {
        let off: (() => void) | undefined
        void listen<{ projectId: string; instanceId?: string; error?: string }>('modpack://done', e => cb(e.payload)).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['modpack']['onDone'],
    },
    // Modrinth metadata is fetched in the WebView (CORS-open core helpers); only
    // the file download + instance.json write happen in Rust.
    modrinth: {
      ...base.modrinth,
      install: (async (instanceId: string, projectId: string, projectName: string, versionId?: string) => {
        const instance = await tinvoke('get_instance_by_id', { id: instanceId }) as Instance | null
        if (!instance) throw new Error(`Instance not found: ${instanceId}`)
        const { getProjectVersions, getPrimaryFile } = await import('@refract/core')
        const versions = await getProjectVersions(projectId, instance.minecraftVersion, instance.modLoader)
        let target = versionId ? versions.find(v => v.id === versionId) : versions[0]
        if (!target) target = versions[0]
        if (!target) throw new Error(`No compatible version of ${projectName} found for MC ${instance.minecraftVersion} with ${instance.modLoader ?? 'vanilla'}`)
        const file = getPrimaryFile(target)
        if (!file) throw new Error(`No download file found for ${projectName} ${target.version_number}`)
        const mod = {
          projectId, versionId: target.id, name: projectName, fileName: file.filename, fileSize: file.size,
          loader: target.loaders[0] ?? 'unknown', gameVersion: target.game_versions[0] ?? instance.minecraftVersion,
          installedAt: new Date().toISOString(),
        }
        return tinvoke('install_mod_file', { instanceId, url: file.url, fileName: file.filename, mod })
      }) as RefractAPI['modrinth']['install'],
      uninstall: ((instanceId: string, projectId: string) => tinvoke('uninstall_mod', { instanceId, projectId })) as RefractAPI['modrinth']['uninstall'],
    },
    mods: {
      ...base.mods,
      list: ((instanceId: string) => tinvoke('mods_list', { instanceId })) as RefractAPI['mods']['list'],
      toggle: ((instanceId: string, filename: string, type: string) => tinvoke('mods_toggle', { instanceId, filename, type })) as RefractAPI['mods']['toggle'],
      delete: ((instanceId: string, filename: string, type: string) => tinvoke('mods_delete', { instanceId, filename, type })) as RefractAPI['mods']['delete'],
      installLocal: ((instanceId: string, srcPath: string) => tinvoke('mods_install_local', { instanceId, srcPath })) as RefractAPI['mods']['installLocal'],
    },
    // Accounts live in the same config.json the launcher reads; Microsoft tokens
    // are handled entirely in Rust (never returned to JS) — these commands return
    // only safe account records / device-code prompts.
    auth: {
      ...base.auth,
      accounts: (() => tinvoke('auth_accounts')) as RefractAPI['auth']['accounts'],
      active: (() => tinvoke('auth_active')) as RefractAPI['auth']['active'],
      microsoftBegin: (() => tinvoke('auth_microsoft_begin')) as RefractAPI['auth']['microsoftBegin'],
      microsoftComplete: ((deviceCode: string) => tinvoke('auth_microsoft_complete', { deviceCode })) as RefractAPI['auth']['microsoftComplete'],
      createOffline: ((username: string) => tinvoke('auth_create_offline', { username })) as RefractAPI['auth']['createOffline'],
      renameOffline: ((uuid: string, username: string) => tinvoke('auth_rename_offline', { uuid, username })) as RefractAPI['auth']['renameOffline'],
      setActive: ((uuid: string) => tinvoke('auth_set_active', { uuid })) as RefractAPI['auth']['setActive'],
      logout: ((uuid: string) => tinvoke('auth_logout', { uuid })) as RefractAPI['auth']['logout'],
    },
    mc: {
      ...base.mc,
      java: (() => tinvoke('mc_java')) as RefractAPI['mc']['java'],
      install: ((instanceId: string, versionId: string, versionUrl: string, modLoader?: string, modLoaderVersion?: string) =>
        tinvoke('install_minecraft', { instanceId, versionId, versionUrl, modLoader, modLoaderVersion })) as RefractAPI['mc']['install'],
      launch: ((instanceId: string) => tinvoke('launch_minecraft', { instanceId })) as RefractAPI['mc']['launch'],
      stop: ((instanceId: string) => tinvoke('stop_minecraft', { instanceId })) as RefractAPI['mc']['stop'],
      isRunning: ((instanceId: string) => tinvoke('is_running', { instanceId })) as RefractAPI['mc']['isRunning'],
      // Renderer expects a synchronous unsubscribe; listen() resolves async, so
      // each wrapper detaches once its listener is actually attached.
      onProgress: ((cb: (data: { instanceId: string; step: string; current: number; total: number; percent: number }) => void) => {
        let off: (() => void) | undefined
        void listen<{ instanceId: string; step: string; current: number; total: number; percent: number }>(
          'mc://progress', e => cb(e.payload),
        ).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['mc']['onProgress'],
      onLog: ((cb: (data: { instanceId: string; line: string; stream: string }) => void) => {
        let off: (() => void) | undefined
        void listen<{ instanceId: string; line: string; stream: string }>('mc://log', e => cb(e.payload)).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['mc']['onLog'],
      onExit: ((cb: (data: { instanceId: string; code: number | null; error?: string }) => void) => {
        let off: (() => void) | undefined
        void listen<{ instanceId: string; code: number | null; error?: string }>('mc://exit', e => cb(e.payload)).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['mc']['onExit'],
    },
    // Managed (auto-downloaded) Java runtimes. browseExe/addCustom/removeCustom
    // (custom-path management) stay on the fallback until ported.
    java: {
      ...base.java,
      managedList: (() => tinvoke('java_managed_list')) as RefractAPI['java']['managedList'],
      requiredFor: ((mcVersion: string) => tinvoke('java_required_for', { mcVersion })) as RefractAPI['java']['requiredFor'],
      ensureFor: ((mcVersion: string) => tinvoke('java_ensure_for', { mcVersion })) as RefractAPI['java']['ensureFor'],
      download: ((major: number) => tinvoke('java_download', { major })) as RefractAPI['java']['download'],
      delete: ((major: number) => tinvoke('java_delete', { major })) as RefractAPI['java']['delete'],
      addCustom: ((javaPath: string) => tinvoke('java_add_custom', { javaPath })) as RefractAPI['java']['addCustom'],
      removeCustom: ((javaPath: string) => tinvoke('java_remove_custom', { javaPath })) as RefractAPI['java']['removeCustom'],
      browseExe: (async () => {
        const p = await dialogOpen({ multiple: false, title: 'Select Java executable' })
        return typeof p === 'string' ? p : null
      }) as RefractAPI['java']['browseExe'],
      onProgress: ((cb: (data: { major: number; step: string; percent: number }) => void) => {
        let off: (() => void) | undefined
        void listen<{ major: number; step: string; percent: number }>('java://progress', e => cb(e.payload)).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['java']['onProgress'],
    },
    // Custom-titlebar controls — the Tauri window is frameless (decorations:false),
    // so these drive the native window via Tauri's window API.
    window: {
      ...base.window,
      minimize: () => { void getCurrentWindow().minimize() },
      maximize: () => { void getCurrentWindow().toggleMaximize() },
      close: () => { void getCurrentWindow().close() },
      isMaximized: (() => getCurrentWindow().isMaximized()) as RefractAPI['window']['isMaximized'],
      onMaximizedChange: ((cb: (maximized: boolean) => void) => {
        let off: (() => void) | undefined
        const w = getCurrentWindow()
        void w.onResized(() => { void w.isMaximized().then(cb) }).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['window']['onMaximizedChange'],
    },
  }
}

export const api: RefractAPI = wrapApi(
  electronApi ?? (isTauri ? createTauriApi() : createBrowserApi()),
)

/** True when a native file picker is available (Tauri). */
export const supportsFilePicker = isTauri

/**
 * Native file picker for mod/pack files (Tauri only) — returns absolute paths to
 * hand to `mods.installLocal`. Returns [] outside Tauri (Electron uses drag-drop).
 */
export async function pickModFiles(): Promise<string[]> {
  if (!isTauri) return []
  const sel = await dialogOpen({ multiple: true, filters: [{ name: 'Mods & packs', extensions: ['jar', 'zip'] }] })
  if (!sel) return []
  return Array.isArray(sel) ? sel : [sel]
}

/**
 * Subscribe to instance-export progress (Tauri only). Returns a sync unsubscribe.
 * No-op outside Tauri so callers can use it unconditionally.
 */
export function onExportProgress(
  cb: (data: { id: string; current: number; total: number; percent: number }) => void,
): () => void {
  if (!isTauri) return () => {}
  let off: (() => void) | undefined
  void listen<{ id: string; current: number; total: number; percent: number }>('instance://export-progress', e => cb(e.payload)).then(u => { off = u })
  return () => off?.()
}
