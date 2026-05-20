import { handleIpc } from './handle'
import { installMod, uninstallMod } from '../services/modrinth'
import { searchMods, getProjectVersions, fetchGameVersions } from '@refract/core'

export function registerModrinthIpc(): void {
  handleIpc('modrinth.search', async (_event, query, gameVersion, loader, category, limit, offset) =>
    searchMods(
      String(query ?? ''),
      gameVersion ? String(gameVersion) : undefined,
      loader ? String(loader) : undefined,
      category ? String(category) : undefined,
      typeof limit === 'number' ? limit : 20,
      typeof offset === 'number' ? offset : 0
    )
  )

  handleIpc('modrinth.versions', async (_event, projectId, gameVersion, loader) =>
    getProjectVersions(
      String(projectId),
      gameVersion ? String(gameVersion) : undefined,
      loader ? String(loader) : undefined
    )
  )

  handleIpc('modrinth.install', async (_event, instanceId, projectId, projectName, versionId) =>
    installMod(
      String(instanceId),
      String(projectId),
      String(projectName),
      versionId ? String(versionId) : undefined
    )
  )

  handleIpc('modrinth.uninstall', async (_event, instanceId, projectId) =>
    uninstallMod(String(instanceId), String(projectId))
  )

  handleIpc('modrinth.gameVersions', () => fetchGameVersions())
}
