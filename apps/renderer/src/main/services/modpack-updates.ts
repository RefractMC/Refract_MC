import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { BrowserWindow } from 'electron'
import { paths } from './paths'
import { downloadFile } from './download'
import { getInstanceById } from './instance-store'
import { getConfig } from './config'
import { installModpack, installFtbModpack, installModpackFromFile } from './modpack'
import { getProjectVersions, getFtbModpack, getCurseForgeFiles, getCurseForgeDownloadUrl, CF_LOADER } from '@refract/core'

export interface ModpackUpdateInfo {
  hasUpdate: boolean
  latestVersionId: string
  latestName: string
}

/** Check whether a modpack-derived instance has a newer version available. */
export async function checkModpackUpdate(instanceId: string): Promise<ModpackUpdateInfo | null> {
  const inst = getInstanceById(instanceId)
  if (!inst?.modpackSource || !inst.modpackProjectId) return null
  const current = inst.modpackVersionId
  try {
    if (inst.modpackSource === 'modrinth') {
      const latest = (await getProjectVersions(inst.modpackProjectId, inst.minecraftVersion, inst.modLoader))[0]
      if (!latest) return null
      return { hasUpdate: latest.id !== current, latestVersionId: latest.id, latestName: latest.version_number }
    }
    if (inst.modpackSource === 'ftb') {
      const pack = await getFtbModpack(Number(inst.modpackProjectId))
      const pool = pack.versions.filter(v => v.type === 'release')
      const latest = (pool.length ? pool : pack.versions).reduce((a, b) => (b.id > a.id ? b : a))
      if (!latest) return null
      return { hasUpdate: String(latest.id) !== current, latestVersionId: String(latest.id), latestName: latest.name }
    }
    if (inst.modpackSource === 'curseforge') {
      const apiKey = getConfig().curseforgeApiKey
      if (!apiKey) return null
      const loaderType = inst.modLoader ? CF_LOADER[inst.modLoader as keyof typeof CF_LOADER] : undefined
      const latest = (await getCurseForgeFiles(Number(inst.modpackProjectId), apiKey, inst.minecraftVersion, loaderType))[0]
      if (!latest) return null
      return { hasUpdate: String(latest.id) !== current, latestVersionId: String(latest.id), latestName: latest.displayName }
    }
  } catch { return null }
  return null
}

/** Re-install the latest version into the existing instance (mods/overrides are
 *  replaced; worlds, screenshots, options and server list are preserved). */
export async function updateModpack(instanceId: string, mainWindow: BrowserWindow): Promise<void> {
  const inst = getInstanceById(instanceId)
  if (!inst?.modpackSource || !inst.modpackProjectId) throw new Error('This instance is not linked to a modpack.')
  const info = await checkModpackUpdate(instanceId)
  if (!info) throw new Error('Could not determine the latest version.')

  if (inst.modpackSource === 'modrinth') {
    await installModpack(inst.name, inst.modpackProjectId, info.latestVersionId, mainWindow, instanceId)
    return
  }
  if (inst.modpackSource === 'ftb') {
    await installFtbModpack(inst.name, Number(inst.modpackProjectId), Number(info.latestVersionId), mainWindow, instanceId)
    return
  }

  // CurseForge: download the latest file, then re-apply into the existing instance.
  const apiKey = getConfig().curseforgeApiKey
  if (!apiKey) throw new Error('CurseForge API key not configured.')
  const modId = Number(inst.modpackProjectId)
  const fileId = Number(info.latestVersionId)
  const files = await getCurseForgeFiles(modId, apiKey)
  const file = files.find(f => f.id === fileId)
  let url = file?.downloadUrl ?? null
  if (!url) url = await getCurseForgeDownloadUrl(modId, fileId, apiKey)
  if (!url) throw new Error('No download URL available for the latest CurseForge file.')
  mkdirSync(paths.cache, { recursive: true })
  const tmp = join(paths.cache, `cfpack-update-${Date.now()}.zip`)
  try {
    await downloadFile(url, tmp)
    await installModpackFromFile(tmp, inst.name, mainWindow, `cf:${modId}`, {
      existingInstanceId: instanceId,
      modpack: { source: 'curseforge', projectId: String(modId), versionId: String(fileId) },
    })
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp) } catch { /* ignore */ }
  }
}
