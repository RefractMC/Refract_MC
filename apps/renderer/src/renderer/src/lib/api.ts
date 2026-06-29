import type { CreateInstanceInput, Instance } from '@refract/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog'
import { logger } from './logger'
import { fetchMinecraftNews } from '../../../shared/minecraft-news'

export type RefractAPI = Window['api']
export type SafeAccount = Awaited<ReturnType<RefractAPI['auth']['accounts']>>[number]
export type DeviceLogin = Awaited<ReturnType<RefractAPI['auth']['microsoftBegin']>>
export type AppConfig = Awaited<ReturnType<RefractAPI['config']['get']>>

const CONFIG_KEY = 'refract.dev.config'
const INSTANCES_KEY = 'refract.dev.instances'
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'www.minecraft.net',
  'minecraft.net',
  'www.microsoft.com',
  'microsoft.com',
  'login.microsoftonline.com',
  'login.live.com',
  'modrinth.com',
  'www.curseforge.com',
  'curseforge.com',
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
  'codeberg.org',
  'www.codeberg.org',
  'discord.gg',
  'discord.com',
  'www.discord.com',
  'discordapp.com',
  'namemc.com',
  'www.namemc.com',
])

const DEFAULT_CONFIG: AppConfig = {
  activeAccountId: null,
  activeThemeId: 'dark',
  windowBounds: { width: 1280, height: 800 },
  defaultMemoryMb: 2048,
  onboardingDone: false,
  migrationNotice120Shown: false,
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

function validateExternalUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('External link is not allowed.')
  }
  return url.toString()
}

function openBrowserExternal(value: string): void {
  globalThis.open(validateExternalUrl(value), '_blank', 'noopener,noreferrer')
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
      add:     async () => { throw new Error('Skins require the desktop app.') },
      delete:  async () => undefined,
      getPath:    async () => '',
      getDataUrl:    async () => null,
      fileToDataUrl: async () => null,
      apply:   async () => { throw new Error('Skins require the desktop app.') },
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
        throw new Error('Microsoft login requires the desktop app. Browser preview supports guest profiles only.')
      },
      microsoftComplete: async () => {
        throw new Error('Microsoft login requires the desktop app. Browser preview supports guest profiles only.')
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
      yggdrasilLogin: async () => { throw new Error('Yggdrasil login requires the desktop app.') },
      fetchSkinTextureUrl: async () => null,
      browseSkin: async () => null,
      uploadSkin: async () => { throw new Error('Skin upload requires the desktop app.') },
      fetchCapes: async () => [],
      setCape: async () => { throw new Error('Cape management requires the desktop app.') },
    },
    theme: {
      list: async () => [],
      install: async () => {
        throw new Error('Theme import is available in the desktop app.')
      },
      delete: async () => undefined,
      browseBackgroundImage: async () => null,
    },
    updater: {
      onAvailable:  () => () => undefined,
      onProgress:   () => () => undefined,
      onDownloaded: () => () => undefined,
      install:  () => undefined,
      download: () => undefined,
    },
    launcher: {
      deleteAll: async () => { throw new Error('Delete all requires the desktop app.') },
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
      importMultiMc:  async () => { throw new Error('MultiMC import requires the desktop app.') },
      scanExternal:   async () => [],
      scanExternalFolder: async () => [],
      linkExternal:   async () => { throw new Error('Link requires the desktop app.') },
      importExternal: async () => { throw new Error('Import requires the desktop app.') },
    },
    window: {
      minimize: () => undefined,
      maximize: () => undefined,
      close: () => undefined,
      forceClose: () => undefined,
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
    news: {
      list: fetchMinecraftNews,
      open: async (url: string) => {
        openBrowserExternal(url)
      },
    },
    discord: {
      openInvite: async () => {
        openBrowserExternal('https://discord.gg/SUPuuTjMGU')
      },
    },
    external: {
      open: async (url: string) => {
        openBrowserExternal(url)
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
      install: async () => { throw new Error('Mod install requires the desktop app.') },
      uninstall: async () => { throw new Error('Mod uninstall requires the desktop app.') },
      gameVersions: async () => {
        const { fetchGameVersions } = await import('@refract/core')
        return fetchGameVersions()
      },
      contentInstall: async () => { throw new Error('Content install requires the desktop app.') },
      checkModUpdates: async () => [],
      applyModUpdates: async () => [],
    },
    mods: {
      list:           async () => [],
      planDeps:       async () => [],
      toggle:         async () => { throw new Error('Mod management requires the desktop app.') },
      delete:         async () => { throw new Error('Mod management requires the desktop app.') },
      installLocal:   async () => { throw new Error('Mod install requires the desktop app.') },
      profilesList:   async () => [],
      profilesSave:   async () => { throw new Error('Mod profiles require the desktop app.') },
      profilesApply:  async () => { throw new Error('Mod profiles require the desktop app.') },
      profilesDelete: async () => { throw new Error('Mod profiles require the desktop app.') },
      profilesRename: async () => { throw new Error('Mod profiles require the desktop app.') },
    },
    curseforge: {
      searchMods:     async () => { throw new Error('CurseForge requires the desktop app.') },
      searchModpacks: async () => { throw new Error('CurseForge requires the desktop app.') },
      files:          async () => { throw new Error('CurseForge requires the desktop app.') },
      install:        async () => { throw new Error('CurseForge requires the desktop app.') },
      projectDetail:  async () => { throw new Error('CurseForge requires the desktop app.') },
      installModpack: async () => { throw new Error('CurseForge requires the desktop app.') },
    },
    ftb: {
      search:         async () => [],
      modpack:        async () => { throw new Error('FTB requires the desktop app.') },
      installModpack: async () => { throw new Error('FTB requires the desktop app.') },
    },
    java: {
      managedList:  async () => [],
      requiredFor:  async () => 21,
      ensureFor:    async () => 21,
      download:     async () => { throw new Error('Java download requires the desktop app.') },
      delete:       async () => { throw new Error('Java delete requires the desktop app.') },
      browseExe:    async () => null,
      addCustom:    async () => { throw new Error('Java management requires the desktop app.') },
      removeCustom: async () => { throw new Error('Java management requires the desktop app.') },
      onProgress:   () => () => undefined,
    },
    friends: {
      list:       async () => [],
      add:        async () => { throw new Error('Friends require the desktop app.') },
      remove:     async () => undefined,
      updateNote: async () => undefined,
    },
    modpack: {
      install: async () => { throw new Error('Modpack install requires the desktop app.') },
      openFileDialog: async () => null,
      installFromFile: async () => { throw new Error('Modpack install requires the desktop app.') },
      checkUpdate: async () => null,
      update: async () => { throw new Error('Modpack update requires the desktop app.') },
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
      install: async () => { throw new Error('MC install requires the desktop app.') },
      repair: async () => { throw new Error('MC repair requires the desktop app.') },
      launch: async () => { throw new Error('MC launch requires the desktop app.') },
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

// Tauri is the native shell. Browser preview keeps a small localStorage-backed
// API for design and routing work outside the desktop app.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

if (!isTauri) {
  logger.warn('browserApi', 'Tauri API is unavailable; using browser preview storage.')
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

// ── dependency planning (Tauri) ──────────────────────────────────────────────
// Mirrors the native mod-deps service: transitive required + direct optional
// deps. Modrinth metadata is fetched in the WebView (CORS-open); CurseForge goes
// through the Rust proxy commands.

let javaScanPromise: ReturnType<RefractAPI['mc']['java']> | null = null

function scanJavaOnce(): ReturnType<RefractAPI['mc']['java']> {
  if (!javaScanPromise) {
    javaScanPromise = tinvoke('mc_java') as ReturnType<RefractAPI['mc']['java']>
    javaScanPromise.finally(() => { javaScanPromise = null })
  }
  return javaScanPromise
}

type ResolvedDep = {
  source: 'modrinth' | 'curseforge'; key: string; name: string
  type: 'required' | 'optional'; alreadyInstalled: boolean
  projectId?: string; versionId?: string; modId?: number; fileId?: number
}

async function modrinthNames(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  try {
    const res = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return {}
    const arr = (await res.json()) as Array<{ id: string; title: string }>
    return Object.fromEntries(arr.map(p => [p.id, p.title]))
  } catch { return {} }
}

async function planModrinthDeps(version: { dependencies?: Array<Record<string, unknown>> }, mc?: string, loader?: string, installed = new Set<string>()): Promise<ResolvedDep[]> {
  const { getProjectVersions } = await import('@refract/core')
  const out = new Map<string, ResolvedDep>()
  const visited = new Set<string>()
  async function walk(deps: Array<Record<string, unknown>> = []): Promise<void> {
    const req: string[] = [], opt: string[] = []
    for (const d of deps) {
      const pid = d.project_id as string | undefined
      if (!pid || pid.startsWith('cf:')) continue
      if (d.dependency_type === 'required') req.push(pid)
      else if (d.dependency_type === 'optional') opt.push(pid)
    }
    const names = await modrinthNames([...new Set([...req, ...opt])])
    for (const id of opt) if (!out.has(id)) out.set(id, { source: 'modrinth', key: id, name: names[id] ?? id, type: 'optional', alreadyInstalled: installed.has(id), projectId: id })
    for (const id of req) {
      if (visited.has(id)) continue
      visited.add(id)
      let versionId: string | undefined; let childDeps: Array<Record<string, unknown>> = []
      try { const vs = await getProjectVersions(id, mc, loader); versionId = vs[0]?.id; childDeps = (vs[0]?.dependencies ?? []) as Array<Record<string, unknown>> } catch { /* surface unresolved */ }
      out.set(id, { source: 'modrinth', key: id, name: names[id] ?? out.get(id)?.name ?? id, type: 'required', alreadyInstalled: installed.has(id), projectId: id, versionId })
      await walk(childDeps)
    }
  }
  await walk(version.dependencies)
  return [...out.values()]
}

async function planCurseforgeDeps(file: { dependencies?: Array<Record<string, unknown>> }, mc?: string, loader?: string, installed = new Set<string>()): Promise<ResolvedDep[]> {
  const out = new Map<string, ResolvedDep>()
  const visited = new Set<number>()
  const cfName = async (modId: number) => {
    try { return ((await tinvoke('curseforge_project_detail', { modId })) as { name?: string })?.name ?? `Mod ${modId}` } catch { return `Mod ${modId}` }
  }
  const cfBest = async (modId: number) => {
    try { return ((await tinvoke('curseforge_files', { modId, gameVersion: mc, loader })) as Array<Record<string, unknown>>)?.[0] } catch { return undefined }
  }
  async function walk(deps: Array<Record<string, unknown>> = []): Promise<void> {
    for (const d of deps) {
      const modId = d.modId as number
      const key = `cf:${modId}`
      if (d.relationType === 3) {
        if (visited.has(modId)) continue
        visited.add(modId)
        const best = await cfBest(modId)
        out.set(key, { source: 'curseforge', key, name: await cfName(modId), type: 'required', alreadyInstalled: installed.has(key), modId, fileId: best?.id as number | undefined })
        await walk((best?.dependencies ?? []) as Array<Record<string, unknown>>)
      } else if (d.relationType === 2) {
        if (out.has(key)) continue
        const best = await cfBest(modId)
        out.set(key, { source: 'curseforge', key, name: await cfName(modId), type: 'optional', alreadyInstalled: installed.has(key), modId, fileId: best?.id as number | undefined })
      }
    }
  }
  await walk(file.dependencies)
  return [...out.values()]
}

// ── updater (Tauri) ───────────────────────────────────────────────────────
// The renderer expects an event-style API (onAvailable → download → onProgress →
// onDownloaded → install). Map it onto tauri-plugin-updater: check once when the
// first listener attaches, then download()/install() drive the rest.
type UpdateHandle = { version: string; download: (cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>; install: () => Promise<void> }
const updAvailable: Array<(v: { version: string }) => void> = []
const updProgress: Array<(v: { percent: number }) => void> = []
const updDownloaded: Array<() => void> = []
let pendingUpdate: UpdateHandle | null = null
let updaterStarted = false
let lastNotified: string | null = null   // avoid re-banners for the same version
let updateDownloaded = false              // set once a manual Download completes
let installingOnQuit = false

const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000 // re-check every 30 min while open

async function runUpdateCheck(): Promise<void> {
  if (updateDownloaded || installingOnQuit) return // already have one / quitting
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = (await check()) as unknown as (UpdateHandle & { available?: boolean }) | null
    if (update && update.available !== false) {
      pendingUpdate = update
      if (lastNotified !== update.version) {
        lastNotified = update.version
        updAvailable.forEach(cb => cb({ version: update.version }))
      }
    }
  } catch (e) {
    logger.warn('updater:check', String(e))
  }
}

// Start the updater once a listener is attached: register the quit-installer,
// check immediately, then re-check periodically so a release pushed while the
// app is open is noticed without a restart.
function startUpdater(): void {
  if (updaterStarted) return
  updaterStarted = true
  void runUpdateCheck()
  setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS)
}

// "Auto-install on quit": if the user downloaded an update but didn't click
// Install, apply it as the app closes. (On Windows the installer relaunches into
// the new version — that's the platform behaviour.) If nothing was downloaded,
// the window closes normally.
async function registerQuitInstaller(): Promise<void> {
  try {
    const w = getCurrentWindow()
    await w.onCloseRequested(async (event) => {
      if (!updateDownloaded || installingOnQuit || !pendingUpdate) return
      installingOnQuit = true
      event.preventDefault()
      try {
        await pendingUpdate.install()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } catch (e) {
        logger.error('updater:quit-install', String(e))
        await w.close() // install failed — honour the quit anyway (installingOnQuit guards re-entry)
      }
    })
  } catch (e) {
    logger.warn('updater:quit-hook', String(e))
  }
}

function createTauriApi(): RefractAPI {
  const base = createBrowserApi()
  return {
    ...base,
    analytics: {
      track: (name, params) => { void tinvoke('analytics_track', { name, params }).catch(() => {}) },
    },
    activity: {
      ...base.activity,
      list: (() => tinvoke('activity_list')) as RefractAPI['activity']['list'],
      add: ((label: string) => tinvoke('activity_add', { label })) as RefractAPI['activity']['add'],
    },
    news: {
      list: (() => tinvoke('minecraft_news')) as RefractAPI['news']['list'],
      open: ((url: string) => tinvoke('open_minecraft_news_article', { url })) as RefractAPI['news']['open'],
    },
    discord: {
      openInvite: (() => tinvoke('open_discord_invite')) as RefractAPI['discord']['openInvite'],
    },
    external: {
      open: ((url: string) => tinvoke('open_external_link', { url })) as RefractAPI['external']['open'],
    },
    config: {
      ...base.config,
      get: (() => tinvoke('config_get')) as RefractAPI['config']['get'],
      set: ((key: string, value: unknown) => tinvoke('config_set', { key, value })) as RefractAPI['config']['set'],
    },
    theme: {
      ...base.theme,
      list: (() => tinvoke('theme_list')) as RefractAPI['theme']['list'],
      install: ((sourcePath: string) => tinvoke('theme_install', { sourcePath })) as RefractAPI['theme']['install'],
      delete: ((fileName: string) => tinvoke('theme_delete', { fileName })) as RefractAPI['theme']['delete'],
      browseBackgroundImage: (() => tinvoke('theme_browse_background_image')) as RefractAPI['theme']['browseBackgroundImage'],
    },
    system: {
      ...base.system,
      ramGb: (() => tinvoke('system_ram_gb')) as RefractAPI['system']['ramGb'],
    },
    log: {
      ...base.log,
      write: (entry) => { void tinvoke('log_write', { entry }).catch(() => {}) },
      read: ((limit?: number) => tinvoke('logs_read', { limit })) as RefractAPI['log']['read'],
      clear: (() => tinvoke('logs_clear')) as RefractAPI['log']['clear'],
    },
    friends: {
      ...base.friends,
      list: (() => tinvoke('friends_list')) as RefractAPI['friends']['list'],
      add: ((username: string) => tinvoke('friends_add', { username })) as RefractAPI['friends']['add'],
      remove: ((uuid: string) => tinvoke('friends_remove', { uuid })) as RefractAPI['friends']['remove'],
      updateNote: ((uuid: string, note: string) => tinvoke('friends_update_note', { uuid, note })) as RefractAPI['friends']['updateNote'],
    },
    skins: {
      ...base.skins,
      list: (() => tinvoke('skins_list')) as RefractAPI['skins']['list'],
      browse: (async () => {
        const p = await dialogOpen({ multiple: false, filters: [{ name: 'PNG Image', extensions: ['png'] }] })
        return typeof p === 'string' ? p : null
      }) as RefractAPI['skins']['browse'],
      add: ((name: string, sourcePath: string, variant: string) =>
        tinvoke('skins_add', { name, sourcePath, variant })) as RefractAPI['skins']['add'],
      delete: ((id: string) => tinvoke('skins_delete', { id })) as RefractAPI['skins']['delete'],
      getPath: ((filename: string) => tinvoke('skins_get_path', { filename })) as RefractAPI['skins']['getPath'],
      getDataUrl: ((filename: string) => tinvoke('skins_get_data_url', { filename })) as RefractAPI['skins']['getDataUrl'],
      fileToDataUrl: ((fullPath: string) => tinvoke('skins_file_to_data_url', { fullPath })) as RefractAPI['skins']['fileToDataUrl'],
      apply: ((skinId: string, accountUuid: string) => tinvoke('skins_apply', { skinId, accountUuid })) as RefractAPI['skins']['apply'],
    },
    launcher: {
      ...base.launcher,
      deleteAll: (() => tinvoke('launcher_delete_all')) as RefractAPI['launcher']['deleteAll'],
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
      importMultiMc: (async () => {
        const p = await dialogOpen({ directory: true, multiple: false, title: 'Select MultiMC / Prism Instance Folder' })
        return typeof p === 'string' ? await tinvoke('import_multimc_instance', { instanceFolder: p }) : null
      }) as RefractAPI['instance']['importMultiMc'],
      scanExternal: (() => tinvoke('scan_external_instances')) as RefractAPI['instance']['scanExternal'],
      scanExternalFolder: (async () => {
        const p = await dialogOpen({ directory: true, multiple: false, title: 'Select launcher or instances folder' })
        return typeof p === 'string' ? await tinvoke('scan_external_folder', { folder: p }) : []
      }) as RefractAPI['instance']['scanExternalFolder'],
      linkExternal: ((ext) => tinvoke('link_external_instance', { ext })) as RefractAPI['instance']['linkExternal'],
      importExternal: ((ext) => tinvoke('import_external_instance', { ext })) as RefractAPI['instance']['importExternal'],
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
      openFileDialog: (async () => {
        const p = await dialogOpen({ multiple: false, filters: [{ name: 'Modpack', extensions: ['mrpack', 'zip'] }] })
        return typeof p === 'string' ? p : null
      }) as RefractAPI['modpack']['openFileDialog'],
      installFromFile: ((filePath: string, name?: string, importId?: string) =>
        tinvoke('modpack_install_from_file', { filePath, name, importId })) as RefractAPI['modpack']['installFromFile'],
      checkUpdate: (async (instanceId: string) => {
        const inst = (await tinvoke('get_instance_by_id', { id: instanceId })) as (Instance & { modpackSource?: string; modpackProjectId?: string; modpackVersionId?: string }) | null
        if (!inst?.modpackSource || !inst.modpackProjectId) return null
        const current = inst.modpackVersionId
        try {
          if (inst.modpackSource === 'modrinth') {
            const { getProjectVersions } = await import('@refract/core')
            const latest = (await getProjectVersions(inst.modpackProjectId, inst.minecraftVersion, inst.modLoader))[0]
            if (!latest) return null
            return { hasUpdate: latest.id !== current, latestVersionId: latest.id, latestName: latest.version_number }
          }
          if (inst.modpackSource === 'ftb') {
            const pack = (await tinvoke('ftb_modpack', { id: Number(inst.modpackProjectId) })) as { versions?: Array<{ id: number; name: string; type: string }> }
            const versions = pack.versions ?? []
            const pool = versions.filter(v => v.type === 'release')
            const latest = (pool.length ? pool : versions).reduce<{ id: number; name: string } | null>((a, b) => (!a || b.id > a.id ? b : a), null)
            if (!latest) return null
            return { hasUpdate: String(latest.id) !== current, latestVersionId: String(latest.id), latestName: latest.name }
          }
          if (inst.modpackSource === 'curseforge') {
            const files = (await tinvoke('curseforge_files', { modId: Number(inst.modpackProjectId), gameVersion: inst.minecraftVersion, loader: inst.modLoader })) as Array<{ id: number; displayName: string }>
            const latest = files?.[0]
            if (!latest) return null
            return { hasUpdate: String(latest.id) !== current, latestVersionId: String(latest.id), latestName: latest.displayName }
          }
        } catch { return null }
        return null
      }) as RefractAPI['modpack']['checkUpdate'],
      update: (async (instanceId: string) => {
        const inst = (await tinvoke('get_instance_by_id', { id: instanceId })) as (Instance & { modpackSource?: string; modpackProjectId?: string }) | null
        if (!inst?.modpackSource || !inst.modpackProjectId) throw new Error('This instance is not linked to a modpack.')
        const info = await api.modpack.checkUpdate(instanceId)
        if (!info) throw new Error('Could not determine the latest version.')
        if (inst.modpackSource === 'modrinth') {
          await tinvoke('modpack_install', { name: inst.name, projectId: inst.modpackProjectId, versionId: info.latestVersionId, existingInstanceId: instanceId })
        } else if (inst.modpackSource === 'ftb') {
          await tinvoke('ftb_install_modpack', { name: inst.name, packId: Number(inst.modpackProjectId), versionId: Number(info.latestVersionId), existingInstanceId: instanceId })
        } else if (inst.modpackSource === 'curseforge') {
          await tinvoke('curseforge_install_modpack', { name: inst.name, modId: Number(inst.modpackProjectId), fileId: Number(info.latestVersionId), existingInstanceId: instanceId })
        }
      }) as RefractAPI['modpack']['update'],
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
        return tinvoke('install_mod_file', { instanceId, url: file.url, fileName: file.filename, mod, sha512: file.hashes?.sha512, sha1: file.hashes?.sha1 })
      }) as RefractAPI['modrinth']['install'],
      contentInstall: (async (instanceId: string, projectId: string, projectName: string, contentType: string, versionId?: string) => {
        const instance = await tinvoke('get_instance_by_id', { id: instanceId }) as Instance | null
        if (!instance) throw new Error(`Instance not found: ${instanceId}`)
        const { getProjectVersions, getPrimaryFile } = await import('@refract/core')
        const versions = await getProjectVersions(projectId, instance.minecraftVersion)
        let target = versionId ? versions.find(v => v.id === versionId) : versions[0]
        if (!target) target = versions[0]
        if (!target) throw new Error(`No compatible version of ${projectName} found.`)
        const file = getPrimaryFile(target)
        if (!file) throw new Error(`No download file found for ${projectName}.`)
        const recorded = instance.mods?.find(entry => entry.projectId === projectId && entry.contentType === contentType)
        const installed = await tinvoke('mods_list', { instanceId }) as Array<{ filename: string; type: string }>
        const recordedFileExists = !!recorded?.fileName && installed.some(entry =>
          entry.type === contentType
          && (entry.filename === recorded.fileName || entry.filename === `${recorded.fileName}.disabled`),
        )
        if (recorded?.versionId === target.id && recordedFileExists) {
          throw new Error(`${projectName} is already downloaded for this instance.`)
        }
        if (!recorded) {
          const knownFiles = new Set(versions.map(v => getPrimaryFile(v)?.filename).filter((name): name is string => !!name))
          if (installed.some(entry =>
            entry.type === contentType && (knownFiles.has(entry.filename) || (entry.filename.endsWith('.disabled') && knownFiles.has(entry.filename.slice(0, -'.disabled'.length)))),
          )) {
            throw new Error(`${projectName} is already downloaded for this instance.`)
          }
        }
        const mod = {
          projectId, versionId: target.id, name: projectName, fileName: file.filename, fileSize: file.size,
          loader: target.loaders[0] ?? 'unknown', gameVersion: target.game_versions[0] ?? instance.minecraftVersion,
          installedAt: new Date().toISOString(), contentType,
        }
        await tinvoke('install_content_file', { instanceId, url: file.url, fileName: file.filename, contentType, mod, sha512: file.hashes?.sha512, sha1: file.hashes?.sha1 })
      }) as RefractAPI['modrinth']['contentInstall'],
      checkModUpdates: ((instanceId: string, force?: boolean) => tinvoke('check_mod_updates', { instanceId, force })) as RefractAPI['modrinth']['checkModUpdates'],
      applyModUpdates: ((instanceId: string, updates: Array<{ filename: string; downloadUrl: string; newFilename: string }>) => tinvoke('apply_mod_updates', { instanceId, updates })) as RefractAPI['modrinth']['applyModUpdates'],
      uninstall: ((instanceId: string, projectId: string) => tinvoke('uninstall_mod', { instanceId, projectId })) as RefractAPI['modrinth']['uninstall'],
    },
    mods: {
      ...base.mods,
      list: ((instanceId: string) => tinvoke('mods_list', { instanceId })) as RefractAPI['mods']['list'],
      toggle: ((instanceId: string, filename: string, type: string) => tinvoke('mods_toggle', { instanceId, filename, type })) as RefractAPI['mods']['toggle'],
      delete: ((instanceId: string, filename: string, type: string) => tinvoke('mods_delete', { instanceId, filename, type })) as RefractAPI['mods']['delete'],
      installLocal: ((instanceId: string, srcPath: string) => tinvoke('mods_install_local', { instanceId, srcPath })) as RefractAPI['mods']['installLocal'],
      planDeps: (async (payload: unknown) => {
        const p = payload as { source: 'modrinth' | 'curseforge'; instanceId: string; version?: { dependencies?: Array<Record<string, unknown>> }; file?: { dependencies?: Array<Record<string, unknown>> } }
        const instance = (await tinvoke('get_instance_by_id', { id: p.instanceId })) as Instance | null
        const mc = instance?.minecraftVersion
        const loader = instance?.modLoader
        const entries = await tinvoke('mods_list', { instanceId: p.instanceId }) as Array<{ filename: string; type: string }>
        const installedFiles = new Set(entries
          .filter(entry => entry.type === 'mod')
          .flatMap(entry => entry.filename.endsWith('.disabled')
            ? [entry.filename, entry.filename.slice(0, -'.disabled'.length)]
            : [entry.filename, `${entry.filename}.disabled`]))
        const installed = new Set((instance?.mods ?? [])
          .filter(m => (!m.contentType || m.contentType === 'mod') && !!m.fileName && installedFiles.has(m.fileName))
          .map(m => m.projectId))
        return p.source === 'modrinth'
          ? planModrinthDeps(p.version ?? {}, mc, loader, installed)
          : planCurseforgeDeps(p.file ?? {}, mc, loader, installed)
      }) as RefractAPI['mods']['planDeps'],
      profilesList: ((instanceId: string) => tinvoke('mods_profiles_list', { instanceId })) as RefractAPI['mods']['profilesList'],
      profilesSave: ((instanceId: string, name: string, enabledFiles: string[]) => tinvoke('mods_profiles_save', { instanceId, name, enabledFiles })) as RefractAPI['mods']['profilesSave'],
      profilesApply: ((instanceId: string, profileId: string) => tinvoke('mods_profiles_apply', { instanceId, profileId })) as RefractAPI['mods']['profilesApply'],
      profilesDelete: ((instanceId: string, profileId: string) => tinvoke('mods_profiles_delete', { instanceId, profileId })) as RefractAPI['mods']['profilesDelete'],
      profilesRename: ((instanceId: string, profileId: string, newName: string) => tinvoke('mods_profiles_rename', { instanceId, profileId, newName })) as RefractAPI['mods']['profilesRename'],
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
      yggdrasilLogin: ((serverUrl: string, username: string, password: string) =>
        tinvoke('auth_yggdrasil_login', { serverUrl, username, password })) as RefractAPI['auth']['yggdrasilLogin'],
      fetchSkinTextureUrl: ((uuid: string) => tinvoke('fetch_skin_texture_url', { uuid })) as RefractAPI['auth']['fetchSkinTextureUrl'],
      uploadSkin: ((uuid: string, imagePath: string, variant: 'classic' | 'slim') => tinvoke('upload_skin', { uuid, imagePath, variant })) as RefractAPI['auth']['uploadSkin'],
      fetchCapes: ((uuid: string) => tinvoke('fetch_capes', { uuid })) as RefractAPI['auth']['fetchCapes'],
      setCape: ((uuid: string, capeId: string | null) => tinvoke('set_cape', { uuid, capeId })) as RefractAPI['auth']['setCape'],
      browseSkin: (async () => {
        const p = await dialogOpen({ multiple: false, filters: [{ name: 'PNG Image', extensions: ['png'] }] })
        return typeof p === 'string' ? p : null
      }) as RefractAPI['auth']['browseSkin'],
    },
    mc: {
      ...base.mc,
      java: scanJavaOnce as RefractAPI['mc']['java'],
      forgeVersions: ((mcVersion: string) => tinvoke('mc_forge_versions', { mcVersion })) as RefractAPI['mc']['forgeVersions'],
      neoforgeVersions: ((mcVersion: string) => tinvoke('mc_neoforge_versions', { mcVersion })) as RefractAPI['mc']['neoforgeVersions'],
      fabricVersions: ((mcVersion: string) => tinvoke('fabric_versions', { mcVersion })) as RefractAPI['mc']['fabricVersions'],
      quiltVersions: ((mcVersion: string) => tinvoke('quilt_versions', { mcVersion })) as RefractAPI['mc']['quiltVersions'],
      install: ((instanceId: string, versionId: string, versionUrl: string, modLoader?: string, modLoaderVersion?: string) =>
        tinvoke('install_minecraft', { instanceId, versionId, versionUrl, modLoader, modLoaderVersion })) as RefractAPI['mc']['install'],
      cancelInstall: ((instanceId?: string) => tinvoke('cancel_install', { instanceId })) as RefractAPI['mc']['cancelInstall'],
      launch: ((instanceId: string) => tinvoke('launch_minecraft', { instanceId })) as RefractAPI['mc']['launch'],
      stop: ((instanceId: string) => tinvoke('stop_minecraft', { instanceId })) as RefractAPI['mc']['stop'],
      isRunning: ((instanceId: string) => tinvoke('is_running', { instanceId })) as RefractAPI['mc']['isRunning'],
      worlds: ((instanceId: string) => tinvoke('mc_worlds', { instanceId })) as RefractAPI['mc']['worlds'],
      deleteWorld: ((instanceId: string, worldName: string) => tinvoke('mc_delete_world', { instanceId, worldName })) as RefractAPI['mc']['deleteWorld'],
      crashReport: ((instanceId: string) => tinvoke('mc_crash_report', { instanceId })) as RefractAPI['mc']['crashReport'],
      backupWorld: (async (instanceId: string, worldName: string) => {
        const dest = await dialogSave({ defaultPath: `${worldName}-backup.zip`, filters: [{ name: 'ZIP Archive', extensions: ['zip'] }] })
        if (!dest) return null
        return tinvoke('mc_backup_world', { instanceId, worldName, destPath: dest })
      }) as RefractAPI['mc']['backupWorld'],
      repair: ((instanceId: string) => tinvoke('mc_repair', { instanceId })) as RefractAPI['mc']['repair'],
      screenshots: ((instanceId: string) => tinvoke('mc_screenshots', { instanceId })) as RefractAPI['mc']['screenshots'],
      openScreenshot: ((instanceId: string, filename: string) => tinvoke('mc_open_screenshot', { instanceId, filename })) as RefractAPI['mc']['openScreenshot'],
      screenshotFull: ((instanceId: string, filename: string) => tinvoke('mc_screenshot_full', { instanceId, filename })) as RefractAPI['mc']['screenshotFull'],
      servers: ((instanceId: string) => tinvoke('mc_servers', { instanceId })) as RefractAPI['mc']['servers'],
      pingServer: ((ip: string) => tinvoke('ping_server', { ip })) as RefractAPI['mc']['pingServer'],
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
      // `destroy` was dropped from the desktop capability when it was hardened,
      // so route forceClose through the permitted graceful close() instead.
      forceClose: () => { void getCurrentWindow().close() },
      isMaximized: (() => getCurrentWindow().isMaximized()) as RefractAPI['window']['isMaximized'],
      onMaximizedChange: ((cb: (maximized: boolean) => void) => {
        let off: (() => void) | undefined
        const w = getCurrentWindow()
        void w.onResized(() => { void w.isMaximized().then(cb) }).then(u => { off = u })
        return () => off?.()
      }) as RefractAPI['window']['onMaximizedChange'],
    },
    updater: {
      ...base.updater,
      onAvailable: ((cb: (v: { version: string }) => void) => {
        updAvailable.push(cb)
        startUpdater() // check now + start the periodic re-check (once)
        return () => { const i = updAvailable.indexOf(cb); if (i >= 0) updAvailable.splice(i, 1) }
      }) as RefractAPI['updater']['onAvailable'],
      onProgress: ((cb: (v: { percent: number }) => void) => {
        updProgress.push(cb)
        return () => { const i = updProgress.indexOf(cb); if (i >= 0) updProgress.splice(i, 1) }
      }) as RefractAPI['updater']['onProgress'],
      onDownloaded: ((cb: () => void) => {
        updDownloaded.push(cb)
        return () => { const i = updDownloaded.indexOf(cb); if (i >= 0) updDownloaded.splice(i, 1) }
      }) as RefractAPI['updater']['onDownloaded'],
      download: (() => {
        if (!pendingUpdate) return
        const upd = pendingUpdate
        void (async () => {
          try {
            let total = 0
            let got = 0
            await upd.download((e) => {
              if (e.event === 'Started') total = e.data?.contentLength ?? 0
              else if (e.event === 'Progress') {
                got += e.data?.chunkLength ?? 0
                if (total > 0) updProgress.forEach(cb => cb({ percent: Math.round((got / total) * 100) }))
              }
            })
            updateDownloaded = true
            updDownloaded.forEach(cb => cb())
          } catch (e) {
            logger.error('updater:download', e)
          }
        })()
      }) as RefractAPI['updater']['download'],
      install: (() => {
        void (async () => {
          try {
            if (pendingUpdate) await pendingUpdate.install()
            const { relaunch } = await import('@tauri-apps/plugin-process')
            await relaunch()
          } catch (e) {
            logger.error('updater:install', e)
          }
        })()
      }) as RefractAPI['updater']['install'],
    },
  }
}

export const api: RefractAPI = wrapApi(
  isTauri ? createTauriApi() : createBrowserApi(),
)

/** True when a native file picker is available. */
export const supportsFilePicker = isTauri

/** True when the active runtime can send analytics events. */
export const analyticsAvailable = true

/**
 * Native file picker for mod/pack files (Tauri only) — returns absolute paths to
 * hand to `mods.installLocal`. Returns [] outside Tauri.
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
