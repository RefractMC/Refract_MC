import { join, relative, resolve, basename, dirname } from 'path'
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { BrowserWindow } from 'electron'
import { paths } from './paths'
import { downloadFile } from './download'
import { getProjectVersions, getPrimaryFile, fetchVersionList } from '@refract/core'
import { createAndSaveInstance, updateInstance } from './instance-store'
import { installMinecraft } from './minecraft/downloader'
import type { Instance } from '@refract/core'

interface MrpackFile {
  path: string
  hashes: { sha512?: string; sha1?: string }
  env?: { client?: 'required' | 'optional' | 'unsupported'; server?: string }
  downloads: string[]
  fileSize: number
}

interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  summary?: string
  dependencies: Record<string, string>
  files: MrpackFile[]
}

type ContentType = 'resourcepack' | 'shader' | 'datapack'

const CONTENT_DIRS: Record<ContentType, string> = {
  resourcepack: 'resourcepacks',
  shader:       'shaderpacks',
  datapack:     'datapacks',
}

// ── ZIP extraction using built-in OS tools (no JDK required) ─────────────────

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })

  await new Promise<void>((res, rej) => {
    if (process.platform === 'win32') {
      // Expand-Archive is built into PowerShell 5.0+ (all Windows 10+ installs)
      const cmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 120_000 }, (err) => {
        if (err) rej(new Error(`ZIP extraction failed: ${err.message}`))
        else res()
      })
    } else {
      // unzip is available on macOS and most Linux distros
      execFile('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120_000 }, (err) => {
        if (err) rej(new Error(`ZIP extraction failed: ${err.message}`))
        else res()
      })
    }
  })

  // Post-extraction Zip Slip guard: remove any entries that escaped destDir
  validateExtractedDir(destDir, destDir)
}

function validateExtractedDir(dir: string, root: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (relative(root, resolve(full)).startsWith('..')) {
      rmSync(full, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      validateExtractedDir(full, root)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyDirSafe(src: string, destDir: string): void {
  if (!existsSync(src)) return
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(destDir, entry.name)
    if (relative(destDir, resolve(destPath)).startsWith('..')) continue
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true })
      copyDirSafe(srcPath, destPath)
    } else {
      mkdirSync(dirname(destPath), { recursive: true })
      copyFileSync(srcPath, destPath)
    }
  }
}

function loaderFromDeps(deps: Record<string, string>): Instance['modLoader'] {
  if ('fabric-loader' in deps) return 'fabric'
  if ('quilt-loader' in deps)  return 'quilt'
  if ('neoforge' in deps || 'neoForge' in deps) return 'neoforge'
  if ('forge' in deps) return 'forge'
  return undefined
}

function loaderVersionFromDeps(deps: Record<string, string>): string | undefined {
  return deps['fabric-loader'] ?? deps['quilt-loader'] ?? deps['neoforge'] ?? deps['forge']
}

function progress(mainWindow: BrowserWindow, projectId: string, step: string, percent: number): void {
  mainWindow.webContents.send('modpack:progress', { projectId, step, percent })
}

// ── Modpack install ────────────────────────────────────────────────────────────

export async function installModpack(
  instanceName: string,
  projectId: string,
  versionId: string | undefined,
  mainWindow: BrowserWindow
): Promise<Instance> {
  progress(mainWindow, projectId, 'Fetching version info', 2)
  const versions = await getProjectVersions(projectId)
  const version = versionId ? versions.find(v => v.id === versionId) : versions[0]
  if (!version) throw new Error('No compatible modpack version found.')

  const file = getPrimaryFile(version)
  if (!file) throw new Error('No download file found for this modpack version.')

  // Initial MC version + loader from Modrinth metadata (refined from manifest later)
  const mcVersion = version.game_versions[0] ?? '1.20.1'
  const rawLoader = version.loaders.find(l => l !== 'mrpack')
  const modLoader  = (rawLoader as Instance['modLoader']) ?? undefined

  progress(mainWindow, projectId, 'Creating instance', 4)
  const instance = createAndSaveInstance({
    name: instanceName,
    minecraftVersion: mcVersion,
    modLoader,
    memoryMb: 4096,
  })

  const gameDir   = join(paths.instances, instance.id, 'minecraft')
  mkdirSync(join(gameDir, 'mods'), { recursive: true })

  const tempDir   = join(paths.cache, `mrpack-${instance.id}`)
  const mrpackDl  = join(paths.cache, `${instance.id}.mrpack`)

  try {
    // ── 1. Download .mrpack ─────────────────────────────────────────────────
    progress(mainWindow, projectId, 'Downloading modpack archive', 5)
    if (existsSync(mrpackDl)) rmSync(mrpackDl)
    await downloadFile(file.url, mrpackDl, ({ percent: p }) => {
      progress(mainWindow, projectId, 'Downloading modpack archive', 5 + p * 0.2)
    })

    // ── 2. Extract archive ──────────────────────────────────────────────────
    progress(mainWindow, projectId, 'Extracting archive', 27)
    await extractZip(mrpackDl, tempDir)

    const indexPath = join(tempDir, 'modrinth.index.json')
    if (!existsSync(indexPath)) throw new Error('modrinth.index.json not found in modpack archive. The file may be corrupted or not a valid Modrinth modpack.')

    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as MrpackIndex

    // ── 3. Refine instance metadata from manifest ───────────────────────────
    const manifestMc     = index.dependencies?.minecraft ?? mcVersion
    const manifestLoader = loaderFromDeps(index.dependencies ?? {}) ?? modLoader
    const loaderVersion  = loaderVersionFromDeps(index.dependencies ?? {})

    if (manifestMc !== instance.minecraftVersion || manifestLoader !== instance.modLoader) {
      updateInstance(instance.id, { minecraftVersion: manifestMc, modLoader: manifestLoader })
      instance.minecraftVersion = manifestMc
      instance.modLoader = manifestLoader
    }

    // ── 4. Download mod files ───────────────────────────────────────────────
    const clientFiles = (index.files ?? []).filter(f => f.env?.client !== 'unsupported')
    const total = clientFiles.length
    let done = 0

    progress(mainWindow, projectId, `Downloading mod files (0/${total})`, 30)
    for (const f of clientFiles) {
      if (!f.downloads?.[0]) { done++; continue }
      const safePath  = f.path.replace(/\\/g, '/')
      const destPath  = resolve(gameDir, safePath)
      if (relative(gameDir, destPath).startsWith('..')) { done++; continue }
      mkdirSync(dirname(destPath), { recursive: true })
      try { await downloadFile(f.downloads[0], destPath) } catch { /* skip — CDN failures are non-fatal */ }
      done++
      progress(mainWindow, projectId, `Downloading mod files (${done}/${total})`, 30 + (done / Math.max(total, 1)) * 15)
    }

    // ── 5. Copy overrides ───────────────────────────────────────────────────
    progress(mainWindow, projectId, 'Copying overrides', 46)
    copyDirSafe(join(tempDir, 'overrides'), gameDir)
    copyDirSafe(join(tempDir, 'client-overrides'), gameDir)

    // ── 6. Install Minecraft (client jar, libraries, assets, loader) ────────
    progress(mainWindow, projectId, 'Looking up Minecraft version', 48)
    const versionList = await fetchVersionList()
    const mcEntry = versionList.find(v => v.id === manifestMc)
    if (!mcEntry) throw new Error(`Minecraft ${manifestMc} not found in Mojang manifest. Check your internet connection.`)

    await installMinecraft(
      instance.id,
      manifestMc,
      mcEntry.url,
      manifestLoader,
      loaderVersion,
      (p) => {
        // Map MC install progress (0-100) into the 50-98% slot
        progress(mainWindow, projectId, p.step, 50 + p.percent * 0.48)
      }
    )

    // ── 7. Finalize ─────────────────────────────────────────────────────────
    updateInstance(instance.id, { isInstalled: true })
    instance.isInstalled = true

    progress(mainWindow, projectId, 'Done', 100)
    mainWindow.webContents.send('modpack:done', { projectId, instanceId: instance.id })
    return instance

  } catch (err) {
    try { rmSync(join(paths.instances, instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
    mainWindow.webContents.send('modpack:done', { projectId, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    try { if (existsSync(mrpackDl)) rmSync(mrpackDl) } catch { /* ignore */ }
    try { if (existsSync(tempDir))  rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── Content pack install (resource packs, shaders, data packs) ───────────────

export async function installContentPack(
  instanceId: string,
  projectId: string,
  projectName: string,
  contentType: ContentType,
  versionId?: string
): Promise<void> {
  const { getInstanceById } = await import('./instance-store')
  const instance = getInstanceById(instanceId)
  if (!instance) throw new Error(`Instance not found: ${instanceId}`)

  const versions = await getProjectVersions(
    projectId,
    instance.minecraftVersion,
    contentType === 'shader' ? undefined : instance.modLoader
  )

  let target = versionId ? versions.find(v => v.id === versionId) : versions[0]
  if (!target && versions.length > 0) target = versions[0]
  if (!target) throw new Error(`No compatible version of ${projectName} found.`)

  const file = getPrimaryFile(target)
  if (!file) throw new Error(`No download file found for ${projectName}.`)

  const subDir    = CONTENT_DIRS[contentType]
  const destFolder = join(paths.instances, instanceId, 'minecraft', subDir)
  const safeName  = basename(file.filename)
  const destPath  = resolve(destFolder, safeName)
  if (relative(destFolder, destPath).startsWith('..')) throw new Error(`Unsafe filename: ${file.filename}`)

  mkdirSync(destFolder, { recursive: true })
  await downloadFile(file.url, destPath)
}
