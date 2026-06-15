import { join, relative, resolve, basename, dirname } from 'path'
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, readFileSync, openSync, closeSync, readSync, fstatSync, writeFileSync } from 'fs'
import { inflateRawSync } from 'zlib'
import { BrowserWindow } from 'electron'
import { paths } from './paths'
import { notify } from './notifications'
import { downloadFile } from './download'
import { getProjectVersions, getPrimaryFile, fetchVersionList } from '@refract/core'
import { getFtbModpack, getFtbVersion, ftbTargets, ftbIconUrl } from '@refract/core'
import { createAndSaveInstance, updateInstance, deleteInstance, resolveInstanceDir, getInstanceById } from './instance-store'
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

// ── ZIP extraction — pure Node.js, supports Windows long paths via \\?\ ───────

function winLong(p: string): string {
  if (process.platform !== 'win32') return p
  if (p.startsWith('\\\\')) return p
  return '\\\\?\\' + p.replace(/\//g, '\\')
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })

  const fd = openSync(zipPath, 'r')
  try {
    const fileSize = fstatSync(fd).size
    if (fileSize < 22) throw new Error('Not a valid ZIP file')

    // Locate EOCD by scanning from end
    const searchSize = Math.min(65557, fileSize)
    const tail = Buffer.alloc(searchSize)
    readSync(fd, tail, 0, searchSize, fileSize - searchSize)

    let eocdRel = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i+1] === 0x4b && tail[i+2] === 0x05 && tail[i+3] === 0x06) {
        eocdRel = i; break
      }
    }
    if (eocdRel < 0) throw new Error('ZIP: EOCD signature not found')

    const totalEntries = tail.readUInt16LE(eocdRel + 10)
    let cdPos = tail.readUInt32LE(eocdRel + 16)

    for (let i = 0; i < totalEntries; i++) {
      const cdhdr = Buffer.alloc(46)
      readSync(fd, cdhdr, 0, 46, cdPos)
      if (cdhdr.readUInt32LE(0) !== 0x02014b50) throw new Error(`ZIP: bad central directory entry at ${i}`)

      const method      = cdhdr.readUInt16LE(10)
      const compSize    = cdhdr.readUInt32LE(20)
      const uncompSize  = cdhdr.readUInt32LE(24)
      const fnLen       = cdhdr.readUInt16LE(28)
      const extraLen    = cdhdr.readUInt16LE(30)
      const commentLen  = cdhdr.readUInt16LE(32)
      const lhdrOffset  = cdhdr.readUInt32LE(42)

      const nameBuf = Buffer.alloc(fnLen)
      readSync(fd, nameBuf, 0, fnLen, cdPos + 46)
      const name = nameBuf.toString('utf8')
      cdPos += 46 + fnLen + extraLen + commentLen

      // Zip Slip guard
      const destPath = join(destDir, name)
      if (relative(destDir, resolve(destPath)).startsWith('..')) continue

      if (name.endsWith('/') || (compSize === 0 && uncompSize === 0 && !name.includes('.'))) {
        mkdirSync(winLong(destPath), { recursive: true })
        continue
      }

      mkdirSync(winLong(dirname(destPath)), { recursive: true })

      // Find data start via local file header
      const lhdr = Buffer.alloc(30)
      readSync(fd, lhdr, 0, 30, lhdrOffset)
      const dataStart = lhdrOffset + 30 + lhdr.readUInt16LE(26) + lhdr.readUInt16LE(28)

      const compBuf = Buffer.alloc(compSize)
      readSync(fd, compBuf, 0, compSize, dataStart)

      let data: Buffer
      if (method === 0) {
        data = compBuf
      } else if (method === 8) {
        data = inflateRawSync(compBuf)
      } else {
        throw new Error(`ZIP: unsupported compression method ${method} in "${name}"`)
      }

      writeFileSync(winLong(destPath), data)
    }
  } finally {
    closeSync(fd)
  }

  // Post-extraction Zip Slip guard on remainder
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
  mainWindow: BrowserWindow,
  existingInstanceId?: string
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

  progress(mainWindow, projectId, existingInstanceId ? 'Updating instance' : 'Creating instance', 4)
  const existing = existingInstanceId ? getInstanceById(existingInstanceId) : null
  if (existingInstanceId && !existing) throw new Error('Instance to update was not found.')
  const instance = existing ?? createAndSaveInstance({
    name: instanceName,
    minecraftVersion: mcVersion,
    modLoader,
    memoryMb: 4096,
    modpackSource: 'modrinth',
    modpackProjectId: projectId,
    modpackVersionId: version.id,
  })

  // Fetch modpack icon from Modrinth and store it on the instance
  try {
    const projectInfo = await fetch(`https://api.modrinth.com/v2/project/${projectId}`, {
      headers: { 'User-Agent': 'Refract/1.0 (github.com/ShevRuslan1)' },
    }).then(r => r.ok ? r.json() as Promise<{ icon_url?: string | null }> : null)
    if (projectInfo?.icon_url) {
      updateInstance(instance.id, { iconPath: projectInfo.icon_url })
      instance.iconPath = projectInfo.icon_url
    }
  } catch { /* non-fatal */ }

  const gameDir   = join(resolveInstanceDir(instance.id), 'minecraft')
  // On update, replace the old mod set (worlds/options/etc. are left untouched).
  if (existing) { try { rmSync(join(gameDir, 'mods'), { recursive: true, force: true }) } catch { /* ignore */ } }
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

    updateInstance(instance.id, { minecraftVersion: manifestMc, modLoader: manifestLoader, modLoaderVersion: loaderVersion })
    instance.minecraftVersion = manifestMc
    instance.modLoader = manifestLoader

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
    updateInstance(instance.id, { isInstalled: true, modpackSource: 'modrinth', modpackProjectId: projectId, modpackVersionId: version.id })
    instance.isInstalled = true

    progress(mainWindow, projectId, 'Done', 100)
    notify(existing ? 'Modpack updated' : 'Modpack installed', `${instance.name} is ready to play.`)
    mainWindow.webContents.send('modpack:done', { projectId, instanceId: instance.id })
    return instance

  } catch (err) {
    // Never delete the instance on a failed *update* — only roll back a fresh install.
    if (!existing) {
      try { rmSync(resolveInstanceDir(instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
      try { deleteInstance(instance.id, false) } catch { /* ignore */ }
    }
    mainWindow.webContents.send('modpack:done', { projectId, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    try { if (existsSync(mrpackDl)) rmSync(mrpackDl) } catch { /* ignore */ }
    try { if (existsSync(tempDir))  rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── FTB (Feed The Beast) modpack install ────────────────────────────────────────

export async function installFtbModpack(
  instanceName: string,
  packId: number,
  versionId: number,
  mainWindow: BrowserWindow,
  existingInstanceId?: string
): Promise<Instance> {
  const pid = `ftb:${packId}`
  progress(mainWindow, pid, 'Fetching version info', 2)
  const version = await getFtbVersion(packId, versionId)
  const { minecraft, modLoader, modLoaderVersion } = ftbTargets(version.targets)
  if (!minecraft) throw new Error('This FTB version has no Minecraft target.')

  progress(mainWindow, pid, existingInstanceId ? 'Updating instance' : 'Creating instance', 4)
  const existing = existingInstanceId ? getInstanceById(existingInstanceId) : null
  if (existingInstanceId && !existing) throw new Error('Instance to update was not found.')
  const instance = existing ?? createAndSaveInstance({
    name: instanceName,
    minecraftVersion: minecraft,
    modLoader,
    modLoaderVersion,
    memoryMb: 4096,
    modpackSource: 'ftb',
    modpackProjectId: String(packId),
    modpackVersionId: String(versionId),
  })

  // Pack icon (square art) for the instance card.
  try {
    const pack = await getFtbModpack(packId)
    const icon = ftbIconUrl(pack)
    if (icon) { updateInstance(instance.id, { iconPath: icon }); instance.iconPath = icon }
  } catch { /* non-fatal */ }

  const gameDir = join(resolveInstanceDir(instance.id), 'minecraft')
  mkdirSync(gameDir, { recursive: true })
  // On update, replace the old mod set (worlds/options/etc. are left untouched).
  if (existing) { try { rmSync(join(gameDir, 'mods'), { recursive: true, force: true }) } catch { /* ignore */ } }

  try {
    // ── Download every client file to its manifest path ─────────────────────
    // Files carry either a direct FTB CDN `url` or, for most mods, a CurseForge
    // reference (`url` empty + `curseforge: {project,file}`) that we resolve via
    // the CF download CDN. Skip server-only files and anything with no source.
    const files = version.files.filter(f => !f.serveronly && (f.url || f.curseforge))
    const total = files.length
    let done = 0
    progress(mainWindow, pid, `Downloading files (0/${total})`, 6)

    // Small concurrency keeps large packs (hundreds of files) reasonably quick
    // without hammering the CDN. A single file failing is non-fatal.
    const BATCH = 8
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map(async f => {
        const rel = `${f.path.replace(/^\.?\/*/, '').replace(/\\/g, '/')}/${f.name}`.replace(/\/+/g, '/')
        const destPath = resolve(gameDir, rel)
        if (relative(gameDir, destPath).startsWith('..')) return
        const destDir = dirname(destPath)
        mkdirSync(destDir, { recursive: true })
        if (f.url) {
          try { await downloadFile(f.url, destPath); return }
          catch {
            const mirror = f.mirrors?.[0]
            if (mirror) { try { await downloadFile(mirror, destPath); return } catch { /* fall through */ } }
          }
        }
        if (f.curseforge) {
          try { await downloadCurseForgeFile(f.curseforge.project, f.curseforge.file, destDir) } catch { /* skip */ }
        }
      }))
      done = Math.min(i + BATCH, total)
      progress(mainWindow, pid, `Downloading files (${done}/${total})`, 6 + (done / Math.max(total, 1)) * 42)
    }

    // ── Install Minecraft (client jar, libraries, assets, loader) ───────────
    progress(mainWindow, pid, 'Looking up Minecraft version', 49)
    const versionList = await fetchVersionList()
    const mcEntry = versionList.find(v => v.id === minecraft)
    if (!mcEntry) throw new Error(`Minecraft ${minecraft} not found in Mojang manifest. Check your internet connection.`)

    await installMinecraft(
      instance.id,
      minecraft,
      mcEntry.url,
      modLoader,
      modLoaderVersion,
      (p) => progress(mainWindow, pid, p.step, 50 + p.percent * 0.48)
    )

    updateInstance(instance.id, { isInstalled: true, modpackSource: 'ftb', modpackProjectId: String(packId), modpackVersionId: String(versionId) })
    instance.isInstalled = true

    progress(mainWindow, pid, 'Done', 100)
    notify(existing ? 'Modpack updated' : 'Modpack installed', `${instance.name} is ready to play.`)
    mainWindow.webContents.send('modpack:done', { projectId: pid, instanceId: instance.id })
    return instance

  } catch (err) {
    if (!existing) {
      try { rmSync(resolveInstanceDir(instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
      try { deleteInstance(instance.id, false) } catch { /* ignore */ }
    }
    mainWindow.webContents.send('modpack:done', { projectId: pid, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

// ── CurseForge manifest format ────────────────────────────────────────────────

interface CurseForgeManifest {
  manifestType?: string
  minecraft?: {
    version: string
    modLoaders?: Array<{ id: string; primary?: boolean }>
  }
  name?: string
  version?: string
  files?: Array<{ projectID: number; fileID: number; required?: boolean }>
  overrides?: string
}

function parseCurseForgeLoader(manifest: CurseForgeManifest): { modLoader?: Instance['modLoader']; modLoaderVersion?: string } {
  const loaderEntry = manifest.minecraft?.modLoaders?.find(l => l.primary) ?? manifest.minecraft?.modLoaders?.[0]
  if (!loaderEntry) return {}
  const [loaderName, loaderVer] = loaderEntry.id.split('-')
  const modLoader = (['forge','neoforge','fabric','quilt'].includes(loaderName) ? loaderName : undefined) as Instance['modLoader']
  return { modLoader, modLoaderVersion: loaderVer }
}

async function downloadCurseForgeFile(projectID: number, fileID: number, destDir: string): Promise<boolean> {
  // Try CurseForge CDN direct download (works for openly-redistributable mods)
  const url = `https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}/download`
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) return false
    const contentDisposition = res.headers.get('content-disposition') ?? ''
    const nameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i)
    const filename = nameMatch?.[1]?.trim() ?? `${projectID}-${fileID}.jar`
    const safeName = basename(filename).replace(/[^a-zA-Z0-9._\-]/g, '_')
    const dest = join(destDir, safeName)
    mkdirSync(destDir, { recursive: true })
    await downloadFile(url, dest)
    return true
  } catch {
    return false
  }
}

// ── File-based modpack import ─────────────────────────────────────────────────

export async function installModpackFromFile(
  filePath: string,
  instanceName: string,
  mainWindow: BrowserWindow,
  importId?: string,
  opts: { existingInstanceId?: string; modpack?: { source: 'curseforge'; projectId: string; versionId: string } } = {}
): Promise<Instance> {
  importId = importId ?? `file-import-${Date.now()}`
  const ext = filePath.toLowerCase()

  const report = (step: string, pct: number) =>
    mainWindow.webContents.send('modpack:progress', { projectId: importId, step, percent: pct })

  // ── Modrinth .mrpack ────────────────────────────────────────────────────────
  if (ext.endsWith('.mrpack')) {
    report('Extracting archive', 2)
    const tempDir = join(paths.cache, `mrpack-import-${Date.now()}`)
    try {
      await extractZip(filePath, tempDir)
      const indexPath = join(tempDir, 'modrinth.index.json')
      if (!existsSync(indexPath)) throw new Error('modrinth.index.json not found. Not a valid Modrinth modpack.')

      const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as MrpackIndex
      const mcVersion = index.dependencies?.minecraft ?? '1.20.1'
      const modLoader = loaderFromDeps(index.dependencies ?? {}) ?? undefined
      const loaderVersion = loaderVersionFromDeps(index.dependencies ?? {})
      const name = instanceName || index.name || 'Imported Modpack'

      report('Creating instance', 5)
      const instance = createAndSaveInstance({ name, minecraftVersion: mcVersion, modLoader, memoryMb: 4096 })
      const gameDir = join(resolveInstanceDir(instance.id), 'minecraft')
      mkdirSync(join(gameDir, 'mods'), { recursive: true })

      try {
        const clientFiles = (index.files ?? []).filter(f => f.env?.client !== 'unsupported')
        const total = clientFiles.length
        let done = 0
        report(`Downloading mod files (0/${total})`, 10)
        for (const f of clientFiles) {
          if (!f.downloads?.[0]) { done++; continue }
          const safePath = f.path.replace(/\\/g, '/')
          const destPath = resolve(gameDir, safePath)
          if (relative(gameDir, destPath).startsWith('..')) { done++; continue }
          mkdirSync(dirname(destPath), { recursive: true })
          try { await downloadFile(f.downloads[0], destPath) } catch { /* skip */ }
          done++
          report(`Downloading mod files (${done}/${total})`, 10 + (done / Math.max(total, 1)) * 20)
        }

        report('Copying overrides', 32)
        copyDirSafe(join(tempDir, 'overrides'), gameDir)
        copyDirSafe(join(tempDir, 'client-overrides'), gameDir)

        report('Looking up Minecraft version', 35)
        const versionList = await fetchVersionList()
        const mcEntry = versionList.find(v => v.id === mcVersion)
        if (!mcEntry) throw new Error(`Minecraft ${mcVersion} not found in Mojang manifest.`)

        await installMinecraft(instance.id, mcVersion, mcEntry.url, modLoader, loaderVersion, (p) => {
          report(p.step, 38 + p.percent * 0.6)
        })

        updateInstance(instance.id, { isInstalled: true, minecraftVersion: mcVersion, modLoader, modLoaderVersion: loaderVersion })
        report('Done', 100)
        mainWindow.webContents.send('modpack:done', { projectId: importId, instanceId: instance.id })
        return instance
      } catch (err) {
        try { rmSync(resolveInstanceDir(instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
        try { deleteInstance(instance.id, false) } catch { /* ignore */ }
        throw err
      }
    } finally {
      try { if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  // ── CurseForge ZIP ──────────────────────────────────────────────────────────
  const tempDir = join(paths.cache, `cfpack-import-${Date.now()}`)
  try {
    report('Extracting archive', 2)
    await extractZip(filePath, tempDir)

    const manifestPath = join(tempDir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CurseForgeManifest
      const mcVersion = manifest.minecraft?.version ?? '1.20.1'
      const { modLoader, modLoaderVersion } = parseCurseForgeLoader(manifest)
      const name = instanceName || manifest.name || 'Imported Modpack'

      report(opts.existingInstanceId ? 'Updating instance' : 'Creating instance', 5)
      const cfExisting = opts.existingInstanceId ? getInstanceById(opts.existingInstanceId) : null
      if (opts.existingInstanceId && !cfExisting) throw new Error('Instance to update was not found.')
      const instance = cfExisting ?? createAndSaveInstance({ name, minecraftVersion: mcVersion, modLoader, memoryMb: 4096, modpackSource: opts.modpack?.source, modpackProjectId: opts.modpack?.projectId, modpackVersionId: opts.modpack?.versionId })
      const gameDir = join(resolveInstanceDir(instance.id), 'minecraft')
      if (cfExisting) { try { rmSync(join(gameDir, 'mods'), { recursive: true, force: true }) } catch { /* ignore */ } }
      mkdirSync(join(gameDir, 'mods'), { recursive: true })

      try {
        const files = (manifest.files ?? []).filter(f => f.required !== false)
        const total = files.length
        let done = 0
        let skipped = 0
        report(`Downloading mods (0/${total})`, 10)
        for (const f of files) {
          const ok = await downloadCurseForgeFile(f.projectID, f.fileID, join(gameDir, 'mods'))
          if (!ok) skipped++
          done++
          report(`Downloading mods (${done}/${total})`, 10 + (done / Math.max(total, 1)) * 25)
        }
        if (skipped > 0) {
          mainWindow.webContents.send('modpack:progress', { projectId: importId, step: `${skipped} mod(s) could not be downloaded (CurseForge redistribution restriction). Download them manually.`, percent: 36 })
        }

        const overridesDir = join(tempDir, manifest.overrides ?? 'overrides')
        report('Copying overrides', 37)
        copyDirSafe(overridesDir, gameDir)

        report('Looking up Minecraft version', 40)
        const versionList = await fetchVersionList()
        const mcEntry = versionList.find(v => v.id === mcVersion)
        if (!mcEntry) throw new Error(`Minecraft ${mcVersion} not found in Mojang manifest.`)

        await installMinecraft(instance.id, mcVersion, mcEntry.url, modLoader, modLoaderVersion, (p) => {
          report(p.step, 42 + p.percent * 0.56)
        })

        updateInstance(instance.id, { isInstalled: true, minecraftVersion: mcVersion, modLoader, modLoaderVersion, modpackSource: opts.modpack?.source, modpackProjectId: opts.modpack?.projectId, modpackVersionId: opts.modpack?.versionId })
        report('Done', 100)
        mainWindow.webContents.send('modpack:done', { projectId: importId, instanceId: instance.id })
        return instance
      } catch (err) {
        if (!cfExisting) {
          try { rmSync(resolveInstanceDir(instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
          try { deleteInstance(instance.id, false) } catch { /* ignore */ }
        }
        throw err
      }
    }

    // ── Plain ZIP — copy contents into a new vanilla instance ─────────────────
    const name = instanceName || basename(filePath, '.zip') || 'Imported Pack'
    report('Creating instance', 5)
    const instance = createAndSaveInstance({ name, minecraftVersion: '1.21.1', memoryMb: 4096 })
    const gameDir = join(resolveInstanceDir(instance.id), 'minecraft')

    try {
      report('Copying files', 10)
      copyDirSafe(tempDir, gameDir)

      report('Looking up Minecraft version', 50)
      const versionList = await fetchVersionList()
      const mcEntry = versionList.find(v => v.id === '1.21.1')
      if (!mcEntry) throw new Error('Minecraft 1.21.1 not found in Mojang manifest.')

      await installMinecraft(instance.id, '1.21.1', mcEntry.url, undefined, undefined, (p) => {
        report(p.step, 52 + p.percent * 0.46)
      })

      updateInstance(instance.id, { isInstalled: true })
      report('Done', 100)
      mainWindow.webContents.send('modpack:done', { projectId: importId, instanceId: instance.id })
      return instance
    } catch (err) {
      try { rmSync(resolveInstanceDir(instance.id), { recursive: true, force: true }) } catch { /* ignore */ }
      try { deleteInstance(instance.id, false) } catch { /* ignore */ }
      throw err
    }
  } finally {
    try { if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
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
  const destFolder = join(resolveInstanceDir(instanceId), 'minecraft', subDir)
  const safeName  = basename(file.filename)
  const destPath  = resolve(destFolder, safeName)
  if (relative(destFolder, destPath).startsWith('..')) throw new Error(`Unsafe filename: ${file.filename}`)

  mkdirSync(destFolder, { recursive: true })
  await downloadFile(file.url, destPath)
}
