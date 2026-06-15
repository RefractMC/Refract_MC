import { join, basename, relative, resolve } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { BrowserWindow } from 'electron'
import { handleIpc } from './handle'
import { getConfig } from '../services/config'
import { downloadFile } from '../services/download'
import { resolveGameDir, getInstanceById, updateInstance } from '../services/instance-store'
import { installModpackFromFile } from '../services/modpack'
import { paths } from '../services/paths'
import {
  searchCurseForge,
  getCurseForgeFiles,
  getCurseForgeDownloadUrl,
  CF_CLASS,
  CF_LOADER,
} from '@refract/core'
import type { CFSearchOptions } from '@refract/core'
import type { InstalledMod } from '@refract/core'

function getApiKey(): string {
  const key = getConfig().curseforgeApiKey
  if (!key) throw new Error('CurseForge API key not configured. Add it in Settings → CurseForge API Key.')
  return key
}

function loaderToModLoaderType(loader?: string): number | undefined {
  if (!loader) return undefined
  return CF_LOADER[loader as keyof typeof CF_LOADER]
}

export function registerCurseForgeIpc(mainWindow?: BrowserWindow): void {
  handleIpc('curseforge.search', async (_event, opts) => {
    const apiKey = getApiKey()
    return searchCurseForge({ ...(opts as Omit<CFSearchOptions, 'apiKey'>), apiKey })
  })

  handleIpc('curseforge.searchMods', async (_event, query, gameVersion, loader, pageSize, index) => {
    const apiKey = getApiKey()
    return searchCurseForge({
      apiKey,
      classId: CF_CLASS.mods,
      query: query ? String(query) : undefined,
      gameVersion: gameVersion ? String(gameVersion) : undefined,
      modLoaderType: loaderToModLoaderType(loader ? String(loader) : undefined),
      pageSize: typeof pageSize === 'number' ? pageSize : 20,
      index: typeof index === 'number' ? index : 0,
    })
  })

  handleIpc('curseforge.searchModpacks', async (_event, query, gameVersion, pageSize, index) => {
    const apiKey = getApiKey()
    return searchCurseForge({
      apiKey,
      classId: CF_CLASS.modpacks,
      query: query ? String(query) : undefined,
      gameVersion: gameVersion ? String(gameVersion) : undefined,
      pageSize: typeof pageSize === 'number' ? pageSize : 20,
      index: typeof index === 'number' ? index : 0,
    })
  })

  handleIpc('curseforge.files', async (_event, modId, gameVersion, loader) => {
    const apiKey = getApiKey()
    return getCurseForgeFiles(
      Number(modId),
      apiKey,
      gameVersion ? String(gameVersion) : undefined,
      loaderToModLoaderType(loader ? String(loader) : undefined),
    )
  })

  handleIpc('curseforge.projectDetail', async (_event, modId) => {
    const apiKey = getApiKey()
    const mid = Number(modId)
    const headers = { 'x-api-key': apiKey, Accept: 'application/json' }
    const [projRes, descRes] = await Promise.all([
      fetch(`https://api.curseforge.com/v1/mods/${mid}`, { headers }),
      fetch(`https://api.curseforge.com/v1/mods/${mid}/description`, { headers }),
    ])
    if (!projRes.ok) throw new Error(`CurseForge API error: ${projRes.status}`)
    const proj = ((await projRes.json()) as { data: unknown }).data as import('@refract/core').CFProject & { screenshots?: import('@refract/core').CFScreenshot[] }
    const descData = descRes.ok ? ((await descRes.json()) as { data: string }).data : ''
    return { ...proj, screenshots: proj.screenshots ?? [], description: descData } as import('@refract/core').CFProjectDetail
  })

  handleIpc('curseforge.installModpack', async (_event, name, modId, fileId) => {
    const apiKey = getApiKey()
    const midNum = Number(modId)
    const fidNum = Number(fileId)
    const files = await getCurseForgeFiles(midNum, apiKey)
    const file = files.find(f => f.id === fidNum)
    if (!file) throw new Error(`CurseForge file ${fileId} not found`)
    let url = file.downloadUrl
    if (!url) url = await getCurseForgeDownloadUrl(midNum, fidNum, apiKey)
    if (!url) throw new Error(`No download URL available for file ${fileId}`)
    const cacheDir = paths.cache
    mkdirSync(cacheDir, { recursive: true })
    const tempPath = join(cacheDir, `cfpack-${Date.now()}.zip`)
    try {
      await downloadFile(url, tempPath)
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
      return await installModpackFromFile(tempPath, String(name), win, `cf:${modId}`, {
        modpack: { source: 'curseforge', projectId: String(midNum), versionId: String(fidNum) },
      })
    } finally {
      try { if (existsSync(tempPath)) rmSync(tempPath) } catch { /* ignore */ }
    }
  })

  handleIpc('curseforge.install', async (_event, instanceId, modId, fileId, displayName) => {
    const apiKey = getApiKey()
    const instance = getInstanceById(String(instanceId))
    if (!instance) throw new Error(`Instance not found: ${instanceId}`)

    const files = await getCurseForgeFiles(Number(modId), apiKey)
    const file = files.find(f => f.id === Number(fileId))
    if (!file) throw new Error(`CurseForge file ${fileId} not found`)

    let url = file.downloadUrl
    if (!url) {
      url = await getCurseForgeDownloadUrl(Number(modId), Number(fileId), apiKey)
    }
    if (!url) throw new Error(`No download URL available for ${displayName}`)

    const modsDir = join(resolveGameDir(String(instanceId)), 'mods')
    const safeName = basename(file.fileName)
    const dest = resolve(modsDir, safeName)
    if (relative(modsDir, dest).startsWith('..')) throw new Error(`Unsafe filename rejected: ${file.fileName}`)

    await downloadFile(url, dest)

    const mod: InstalledMod = {
      projectId: `cf:${modId}`,
      versionId: String(fileId),
      name:      String(displayName),
      fileName:  file.fileName,
      fileSize:  file.fileLength,
      loader:    instance.modLoader ?? 'unknown',
      gameVersion: file.gameVersions.find(v => !v.toLowerCase().startsWith('forge') && !v.toLowerCase().startsWith('fabric') && !v.toLowerCase().startsWith('neoforge') && !v.toLowerCase().startsWith('quilt')) ?? instance.minecraftVersion,
      installedAt: new Date().toISOString(),
    }

    const existing = instance.mods ?? []
    const mods = [mod, ...existing.filter(m => m.projectId !== mod.projectId)]
    updateInstance(String(instanceId), { mods })

    return mod
  })
}
