import { join, basename } from 'path'
import { readdirSync, existsSync, rmSync, createReadStream } from 'fs'
import { createHash } from 'crypto'
import { handleIpc } from './handle'
import { installMod, uninstallMod } from '../services/modrinth'
import { downloadFile } from '../services/download'
import { resolveInstanceDir, getInstanceById } from '../services/instance-store'
import { searchMods, searchContent, getProjectVersions, fetchGameVersions } from '@refract/core'
import type { ModrinthSearchOptions, ModrinthVersion } from '@refract/core'

let gameVersionsCache: { data: Awaited<ReturnType<typeof fetchGameVersions>>; at: number } | null = null
const GV_TTL = 60 * 60 * 1000  // 1 hour

interface UpdateInfo { filename: string; downloadUrl: string; newFilename: string }
interface UpdateResult { filename: string; success: boolean; error?: string }
interface ModUpdateEntry {
  filename: string
  projectId: string
  latestVersionId: string
  latestVersionName: string
  latestFilename: string
  downloadUrl: string
  hasUpdate: boolean
}

async function sha512File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Refract/1.0 (github.com/ShevRuslan1)' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json() as Promise<T>
}

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

  handleIpc('modrinth.gameVersions', async () => {
    if (gameVersionsCache && Date.now() - gameVersionsCache.at < GV_TTL) return gameVersionsCache.data
    const data = await fetchGameVersions()
    gameVersionsCache = { data, at: Date.now() }
    return data
  })

  handleIpc('modrinth.searchContent', async (_event, opts) =>
    searchContent(opts as ModrinthSearchOptions)
  )

  handleIpc('modrinth.checkModUpdates', async (_event, instanceId) => {
    const instance = getInstanceById(String(instanceId))
    if (!instance) return []
    const modsDir = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'mods')
    if (!existsSync(modsDir)) return []

    const jars = readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'))
    if (jars.length === 0) return []

    const fileInfos = await Promise.all(
      jars.map(async filename => {
        try {
          const hash = await sha512File(join(modsDir, filename))
          return { filename, hash }
        } catch { return null }
      })
    )
    const valid = fileInfos.filter((f): f is { filename: string; hash: string } => f !== null)
    if (valid.length === 0) return []

    const hashes = valid.map(f => f.hash)
    const hashToFile = new Map(valid.map(f => [f.hash, f.filename]))

    const updateMap = await postJson<Record<string, ModrinthVersion>>(
      'https://api.modrinth.com/v2/version_files/update',
      {
        hashes,
        algorithm: 'sha512',
        loaders: instance.modLoader ? [instance.modLoader] : undefined,
        game_versions: [instance.minecraftVersion],
      }
    )

    const results: ModUpdateEntry[] = []
    for (const [inputHash, latestVersion] of Object.entries(updateMap)) {
      const filename = hashToFile.get(inputHash)
      if (!filename) continue
      const primaryFile = latestVersion.files.find(f => f.primary) ?? latestVersion.files[0]
      if (!primaryFile) continue
      const latestHash = primaryFile.hashes.sha512
      results.push({
        filename,
        projectId: latestVersion.project_id,
        latestVersionId: latestVersion.id,
        latestVersionName: latestVersion.version_number,
        latestFilename: primaryFile.filename,
        downloadUrl: primaryFile.url,
        hasUpdate: latestHash !== inputHash,
      })
    }
    return results
  })

  handleIpc('modrinth.applyModUpdates', async (_event, instanceId, updates) => {
    const modsDir = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'mods')
    const results: UpdateResult[] = []
    for (const u of (updates as UpdateInfo[])) {
      try {
        const newPath = join(modsDir, basename(u.newFilename))
        await downloadFile(u.downloadUrl, newPath)
        const oldPath = join(modsDir, u.filename)
        if (existsSync(oldPath) && oldPath !== newPath) rmSync(oldPath)
        results.push({ filename: u.filename, success: true })
      } catch (e) {
        results.push({ filename: u.filename, success: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return results
  })
}
