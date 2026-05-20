import { join, basename, relative, resolve } from 'path'
import { paths } from './paths'
import { downloadFile } from './download'
import { updateInstance, getInstanceById } from './instance-store'
import type { InstalledMod } from '@refract/core'
import { getProjectVersions, getPrimaryFile } from '@refract/core'

export async function installMod(
  instanceId: string,
  projectId: string,
  projectName: string,
  versionId?: string
): Promise<InstalledMod> {
  const instance = getInstanceById(instanceId)
  if (!instance) throw new Error(`Instance not found: ${instanceId}`)

  const versions = await getProjectVersions(
    projectId,
    instance.minecraftVersion,
    instance.modLoader
  )

  let targetVersion = versionId ? versions.find(v => v.id === versionId) : versions[0]
  if (!targetVersion && versions.length > 0) targetVersion = versions[0]
  if (!targetVersion) {
    throw new Error(
      `No compatible version of ${projectName} found for MC ${instance.minecraftVersion} with ${instance.modLoader ?? 'vanilla'}`
    )
  }

  const file = getPrimaryFile(targetVersion)
  if (!file) throw new Error(`No download file found for ${projectName} ${targetVersion.version_number}`)

  const modsDir = join(paths.instances, instanceId, 'minecraft', 'mods')
  const safeName = basename(file.filename)
  const dest = resolve(modsDir, safeName)
  if (relative(modsDir, dest).startsWith('..')) {
    throw new Error(`Unsafe mod filename rejected: ${file.filename}`)
  }
  await downloadFile(file.url, dest)

  const mod: InstalledMod = {
    projectId,
    versionId: targetVersion.id,
    name: projectName,
    fileName: file.filename,
    fileSize: file.size,
    loader: targetVersion.loaders[0] ?? 'unknown',
    gameVersion: targetVersion.game_versions[0] ?? instance.minecraftVersion,
    installedAt: new Date().toISOString(),
  }

  const existing = instance.mods ?? []
  const mods = [mod, ...existing.filter(m => m.projectId !== projectId)]
  updateInstance(instanceId, { mods })

  return mod
}

export async function uninstallMod(instanceId: string, projectId: string): Promise<void> {
  const instance = getInstanceById(instanceId)
  if (!instance) throw new Error(`Instance not found: ${instanceId}`)

  const mod = instance.mods?.find(m => m.projectId === projectId)
  if (!mod) return

  const modsDir = join(paths.instances, instanceId, 'minecraft', 'mods')
  const modPath = resolve(modsDir, basename(mod.fileName))
  if (relative(modsDir, modPath).startsWith('..')) return
  try {
    const { unlinkSync, existsSync } = await import('fs')
    if (existsSync(modPath)) unlinkSync(modPath)
  } catch { /* non-critical */ }

  updateInstance(instanceId, { mods: (instance.mods ?? []).filter(m => m.projectId !== projectId) })
}
