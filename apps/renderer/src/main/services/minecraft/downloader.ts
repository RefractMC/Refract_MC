import { join, relative, resolve, dirname } from 'path'
import { resolveInstanceDir } from '../instance-store'
import { existsSync, createWriteStream, mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createUnzip } from 'zlib'
import { pipeline } from 'stream/promises'
import https from 'https'
import http from 'http'
import { paths } from '../paths'
import { downloadFile, fetchJson, fetchText } from '../download'
import type { VersionJson, AssetIndex, Library } from '@refract/core'
import { isLibraryAllowed } from '@refract/core'

export interface InstallProgress {
  step: string
  current: number
  total: number
  percent: number
}

type ProgressCallback = (p: InstallProgress) => void

const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
const RESOURCES_URL = 'https://resources.download.minecraft.net'
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2'
const QUILT_META_URL  = 'https://meta.quiltmc.org/v3'

function mavenCoordToPath(name: string): string {
  const parts = name.split(':')
  const [group, artifact, version, classifierExt] = parts
  const groupPath = group.replace(/\./g, '/')
  let fname: string
  if (classifierExt) {
    const [classifier, ext] = classifierExt.split('@')
    fname = `${artifact}-${version}-${classifier}.${ext ?? 'jar'}`
  } else {
    fname = `${artifact}-${version}.jar`
  }
  return join(groupPath, artifact, version, fname)
}

export function versionJsonPath(versionId: string): string {
  return join(paths.versions, versionId, `${versionId}.json`)
}

export function clientJarPath(versionId: string): string {
  return join(paths.versions, versionId, `${versionId}.jar`)
}

export function nativesDir(instanceId: string): string {
  return join(resolveInstanceDir(instanceId), 'minecraft', 'natives')
}

// Forge and NeoForge version JSONs are keyed by loader + loader version so
// two instances on the same Minecraft version (e.g. Forge vs NeoForge, or two
// different Forge builds) never overwrite each other's JSON. When loaderVersion
// is omitted the folder is loader-only (used as a read fallback for older
// installs that didn't record their loader version).
export function forgeJsonPath(versionId: string, loader: 'forge' | 'neoforge', loaderVersion?: string): string {
  const tag = loaderVersion ? `${loader}-${loaderVersion}` : loader
  return join(paths.versions, `${versionId}-${tag}`, `${versionId}-${tag}.json`)
}

export function libraryPath(libPath: string): string {
  return join(paths.libraries, libPath)
}

async function downloadLibraries(
  libs: Library[],
  onProgress: ProgressCallback,
  step: string,
  signal?: AbortSignal
): Promise<void> {
  const allowed = libs.filter(lib => isLibraryAllowed(lib, OS))
  const total = allowed.length
  let current = 0

  for (const lib of allowed) {
    if (signal?.aborted) throw new Error('Install cancelled')
    current++
    onProgress({ step, current, total, percent: (current / total) * 100 })

    if (lib.downloads?.artifact) {
      if (!lib.downloads.artifact.url) continue // bundled in installer — extracted by copyMavenLibs
      const dest = resolve(paths.libraries, lib.downloads.artifact.path)
      if (relative(paths.libraries, dest).startsWith('..')) continue
      await downloadFile(lib.downloads.artifact.url, dest, undefined, signal, lib.downloads.artifact.sha1)
    } else if (lib.name && lib.url) {
      const relPath = mavenCoordToPath(lib.name)
      const dest = resolve(paths.libraries, relPath)
      if (relative(paths.libraries, dest).startsWith('..')) continue
      const baseUrl = lib.url.endsWith('/') ? lib.url : lib.url + '/'
      await downloadFile(baseUrl + relPath.replace(/\\/g, '/'), dest, undefined, signal)
    }
  }
}

async function extractNatives(libs: Library[], instanceId: string): Promise<void> {
  const nDir = nativesDir(instanceId)
  mkdirSync(nDir, { recursive: true })

  for (const lib of libs) {
    if (!lib.natives || !isLibraryAllowed(lib, OS)) continue
    const classifier = lib.natives[OS]?.replace('${arch}', process.arch === 'x64' ? '64' : '32')
    if (!classifier || !lib.downloads?.classifiers?.[classifier]) continue

    const artifact = lib.downloads.classifiers[classifier]
    const jarPath = libraryPath(artifact.path)
    await downloadFile(artifact.url, jarPath)
    await extractJar(jarPath, nDir, lib.extract?.exclude ?? [])
  }
}

function copyNativeFiles(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const full = join(src, entry.name)
    if (entry.isDirectory()) {
      copyNativeFiles(full, dst)
    } else if (/\.(dll|so|dylib|jnilib)$/i.test(entry.name)) {
      const target = join(dst, entry.name)
      if (!existsSync(target)) {
        try { copyFileSync(full, target) } catch { /* ignore */ }
      }
    }
  }
}

async function extractJar(jarPath: string, destDir: string, _exclude: string[]): Promise<void> {
  if (!existsSync(jarPath)) return
  mkdirSync(destDir, { recursive: true })

  const { execFile } = require('child_process') as typeof import('child_process')

  if (process.platform === 'win32') {
    const tmpDir = `${destDir}_tmp_${Date.now()}`
    const ps = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:_ZIP_SRC, $env:_ZIP_DST)'
    const env = { ...process.env, _ZIP_SRC: jarPath, _ZIP_DST: tmpDir }
    await new Promise<void>(res => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000, env }, () => res())
    })
    if (existsSync(tmpDir)) {
      copyNativeFiles(tmpDir, destDir)
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } else {
    // unzip -j flattens paths, -o overwrites, select native extensions
    await new Promise<void>(res => {
      execFile('unzip', ['-o', '-j', jarPath, '*.so', '*.dylib', '*.jnilib', '-d', destDir], { timeout: 60_000 }, () => res())
    })
  }
}

async function downloadAssets(
  versionJson: VersionJson,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const indexPath = join(paths.assets, 'indexes', `${versionJson.assetIndex.id}.json`)
  await downloadFile(versionJson.assetIndex.url, indexPath, undefined, signal)

  const index = JSON.parse(require('fs').readFileSync(indexPath, 'utf-8')) as AssetIndex
  const objects = Object.values(index.objects)
  const total = objects.length
  let current = 0

  // Download in batches of 10
  for (let i = 0; i < objects.length; i += 10) {
    if (signal?.aborted) throw new Error('Install cancelled')
    const batch = objects.slice(i, i + 10)
    await Promise.all(batch.map(async (obj) => {
      const prefix = obj.hash.slice(0, 2)
      const dest = join(paths.assets, 'objects', prefix, obj.hash)
      await downloadFile(`${RESOURCES_URL}/${prefix}/${obj.hash}`, dest, undefined, signal, obj.hash)
    }))
    current = Math.min(i + 10, total)
    onProgress({ step: 'Downloading assets', current, total, percent: (current / total) * 100 })
  }

  // Legacy/virtual indexes: the game can't read the hashed objects store, it
  // expects assets at their real names. Materialise them under assets/virtual/
  // <id> so old versions (which launch with --assetsDir ${game_assets}) get
  // their sounds, lang files and icons. pre-1.6's resources/ layout is then
  // derived from this at launch (see linkLegacyResources).
  if (index.virtual || index.map_to_resources) {
    const virtualDir = join(paths.assets, 'virtual', versionJson.assetIndex.id)
    for (const [name, obj] of Object.entries(index.objects)) {
      const src = join(paths.assets, 'objects', obj.hash.slice(0, 2), obj.hash)
      const dst = resolve(virtualDir, name)
      // The index is network-fetched: reject object names that escape the dir.
      if (relative(virtualDir, dst).startsWith('..')) continue
      if (!existsSync(src) || existsSync(dst)) continue
      mkdirSync(dirname(dst), { recursive: true })
      try { copyFileSync(src, dst) } catch { /* ignore */ }
    }
  }
}

// pre-1.6 versions (asset index with map_to_resources) read assets from
// <gameDir>/resources/ rather than via --assetsDir. Mirror the materialised
// virtual assets into the instance's resources dir just before launch.
export function linkLegacyResources(versionJson: VersionJson, gameDir: string): void {
  const indexPath = join(paths.assets, 'indexes', `${versionJson.assetIndex.id}.json`)
  if (!existsSync(indexPath)) return
  let index: AssetIndex
  try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) as AssetIndex } catch { return }
  if (!index.map_to_resources) return

  const resourcesDir = join(gameDir, 'resources')
  for (const [name, obj] of Object.entries(index.objects)) {
    const src = join(paths.assets, 'objects', obj.hash.slice(0, 2), obj.hash)
    const dst = resolve(resourcesDir, name)
    // The index is network-fetched: reject object names that escape the dir.
    if (relative(resourcesDir, dst).startsWith('..')) continue
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(dirname(dst), { recursive: true })
    try { copyFileSync(src, dst) } catch { /* ignore */ }
  }
}

export async function fetchFabricVersionJson(
  mcVersion: string,
  loaderVersion: string
): Promise<VersionJson> {
  return fetchJson<VersionJson>(
    `${FABRIC_META_URL}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`
  )
}

export async function fetchFabricLoaderVersions(mcVersion: string): Promise<Array<{ loader: { version: string }; intermediary: { version: string } }>> {
  return fetchJson(
    `${FABRIC_META_URL}/versions/loader/${mcVersion}`
  )
}

export async function fetchQuiltLoaderVersions(mcVersion: string): Promise<Array<{ loader: { version: string } }>> {
  return fetchJson(`${QUILT_META_URL}/versions/loader/${mcVersion}`)
}

async function fetchQuiltVersionJson(mcVersion: string, loaderVersion: string): Promise<VersionJson> {
  return fetchJson(`${QUILT_META_URL}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`)
}

interface ForgeInstallProfile {
  libraries?: Library[]
  processors?: Array<{ jar: string; classpath: string[]; args: string[]; outputs?: Record<string, string> }>
  data?: Record<string, { client: string; server: string }>
}

async function runForgeProcessors(
  installProfile: ForgeInstallProfile,
  versionId: string,
  instanceId: string,
  javaExe: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const { execFile } = require('child_process') as typeof import('child_process')
  const processors = installProfile.processors?.filter(p => !p.outputs || Object.keys(p.outputs).length > 0) ?? []
  const total = processors.length
  let done = 0

  for (const proc of processors) {
    done++
    onProgress?.({ step: `Running Forge processor (${done}/${total})`, current: done, total, percent: (done / total) * 100 })

    // Skip if all outputs already exist
    if (proc.outputs && Object.entries(proc.outputs).every(([k]) => {
      const out = resolveForgeData(k, installProfile.data ?? {}, versionId, instanceId)
      return out && existsSync(out)
    })) continue

    const jarPath = resolveLibPath(proc.jar)
    if (!existsSync(jarPath)) continue

    const sep = process.platform === 'win32' ? ';' : ':'
    const cp = [jarPath, ...proc.classpath.map(resolveLibPath)].join(sep)
    const args = proc.args.map(a => resolveForgeData(a, installProfile.data ?? {}, versionId, instanceId) ?? a)

    // A failed processor must abort the install — otherwise the client JAR is
    // left unpatched and the game crashes cryptically at launch instead of here.
    // maxBuffer is bumped so chatty processors don't trip a false ENOBUFS error.
    await new Promise<void>((res, rej) => {
      execFile(javaExe, ['-cp', cp, ...args], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          const tail = (stderr?.toString() ?? '').trim().slice(-600)
          rej(new Error(`Forge processor failed (${proc.jar}): ${tail || error.message}`))
        } else {
          res()
        }
      })
    })
  }
}

function resolveLibPath(coord: string): string {
  // Maven coord format: group:artifact:version or group:artifact:version:classifier
  const clean = coord.startsWith('[') ? coord.slice(1, -1) : coord
  const parts = clean.split(':')
  const [group, artifact, version, classifier] = parts
  const groupPath = group.replace(/\./g, '/')
  const fname = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`
  return join(paths.libraries, groupPath, artifact, version, fname)
}

function resolveForgeData(
  value: string,
  data: Record<string, { client: string; server: string }>,
  versionId: string,
  instanceId: string
): string | undefined {
  if (value.startsWith('{') && value.endsWith('}')) {
    const key = value.slice(1, -1)
    const entry = data[key]?.client ?? data[key]?.server
    if (entry) return resolveForgeData(entry, data, versionId, instanceId)
    return undefined
  }
  if (value.startsWith('[') && value.endsWith(']')) return resolveLibPath(value)
  if (value === '{MINECRAFT_JAR}') return clientJarPath(versionId)
  if (value === '{SIDE}') return 'client'
  return value
}

export async function fetchForgeVersionList(mcVersion: string): Promise<{ versions: string[]; recommended?: string }> {
  const [promoData, xml] = await Promise.all([
    fetchJson<{ promos: Record<string, string> }>(
      'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json'
    ),
    fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'),
  ])
  const recommended = promoData.promos[`${mcVersion}-recommended`]
  const prefix = `${mcVersion}-`
  const versions = [...xml.matchAll(/<version>([^<]*)<\/version>/g)]
    .map(m => m[1])
    .filter(v => v.startsWith(prefix))
    .map(v => v.slice(prefix.length))
    .reverse()
  return { versions, recommended }
}

export async function fetchNeoForgeVersionList(mcVersion: string): Promise<string[]> {
  // NeoForge versions are `<mcMinor>.<mcPatch>.<build>`; a 2-part MC version
  // (e.g. "1.21") has an implicit patch of 0 → "21.0.". Without the explicit
  // patch the prefix "21." also matched 1.21.1's "21.1.x" builds.
  const parts = mcVersion.split('.')
  const minor = parseInt(parts[1])
  const patch = parts.length >= 3 ? parseInt(parts[2]) : 0
  const prefix = `${minor}.${patch}.`

  const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')
  return [...xml.matchAll(/<version>(\d[^<]*)<\/version>/g)]
    .map(m => m[1])
    .filter(v => v.startsWith(prefix))
    .reverse()
}

async function fetchForgeLatestVersion(mcVersion: string): Promise<string> {
  const { versions, recommended } = await fetchForgeVersionList(mcVersion)
  const ver = recommended ?? versions[0]
  if (!ver) throw new Error(`No Forge version found for Minecraft ${mcVersion}. It may not be supported yet.`)
  return ver
}

async function fetchNeoForgeLatestVersion(mcVersion: string): Promise<string> {
  const versions = await fetchNeoForgeVersionList(mcVersion)
  if (!versions[0]) throw new Error(`No NeoForge version found for Minecraft ${mcVersion}. It may not be supported yet.`)
  return versions[0]
}

async function installForge(
  instanceId: string,
  versionId: string,
  forgeVersion: string,
  isNeoForge: boolean,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const report = (step: string, pct: number) =>
    onProgress?.({ step, current: pct, total: 100, percent: pct })

  const forgeId = `${versionId}-${forgeVersion}`
  const mavenBase = isNeoForge
    ? 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
    : 'https://maven.minecraftforge.net/net/minecraftforge/forge'
  const installerUrl = isNeoForge
    ? `${mavenBase}/${forgeVersion}/neoforge-${forgeVersion}-installer.jar`
    : `${mavenBase}/${forgeId}/forge-${forgeId}-installer.jar`

  const installerPath = join(paths.cache, `forge-installer-${forgeId}.jar`)
  const extractDir   = join(paths.cache, `forge-extract-${forgeId}`)

  // Remove any leftovers from a previous failed attempt so downloadFile
  // doesn't skip a partial/corrupt installer JAR
  try { rmSync(installerPath) } catch { /* ignore */ }
  try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }

  try {
    report('Downloading Forge installer', 0)
    await downloadFile(installerUrl, installerPath, ({ percent: p }) => report('Downloading Forge installer', p * 0.3), signal)

    // Extract installer (it's a ZIP/JAR)
    report('Extracting Forge installer', 30)
    mkdirSync(extractDir, { recursive: true })
    const { execFile } = require('child_process') as typeof import('child_process')
    if (process.platform === 'win32') {
      const ps = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:_ZIP_SRC, $env:_ZIP_DST)'
      const env = { ...process.env, _ZIP_SRC: installerPath, _ZIP_DST: extractDir }
      await new Promise<void>(res => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000, env }, () => res())
      })
    } else {
      await new Promise<void>(res => {
        execFile('unzip', ['-o', installerPath, '-d', extractDir], { timeout: 60_000 }, () => res())
      })
    }

    // Read version.json and install_profile.json from installer
    const versionJsonSrc = join(extractDir, 'version.json')
    const profileSrc     = join(extractDir, 'install_profile.json')
    if (!existsSync(versionJsonSrc)) throw new Error('Forge version.json not found in installer. Forge may not support this MC version.')

    const forgeJson = JSON.parse(readFileSync(versionJsonSrc, 'utf-8')) as VersionJson

    // Save loader version JSON, keyed by loader + version so Forge/NeoForge
    // installs on the same MC version don't clobber each other.
    const loaderJsonPath = forgeJsonPath(versionId, isNeoForge ? 'neoforge' : 'forge', forgeVersion)
    mkdirSync(dirname(loaderJsonPath), { recursive: true })
    writeFileSync(loaderJsonPath, JSON.stringify(forgeJson, null, 2))

    // Download Forge libraries
    report('Downloading Forge libraries', 35)
    await downloadLibraries(forgeJson.libraries, onProgress ?? (() => {}), 'Downloading Forge libraries', signal)

    // Also download install_profile libraries (the processor tools)
    if (existsSync(profileSrc)) {
      const profile = JSON.parse(readFileSync(profileSrc, 'utf-8')) as ForgeInstallProfile
      if (profile.libraries?.length) {
        report('Downloading Forge tools', 55)
        await downloadLibraries(profile.libraries, onProgress ?? (() => {}), 'Downloading Forge tools', signal)
      }

      // Copy embedded maven libraries from installer into our libraries dir
      const mavenDir = join(extractDir, 'maven')
      if (existsSync(mavenDir)) copyMavenLibs(mavenDir, paths.libraries)

      // Run Forge processors (patch the Minecraft client JAR). They must run on
      // a Java at least as new as the Minecraft version requires — picking the
      // first detected JDK could hand a Java 8 to a Forge that needs 17+.
      report('Running Forge processors', 70)
      const { detectJavaInstallations } = await import('@refract/core/java-manager')
      const javas = (await detectJavaInstallations()).sort((a, b) => b.version - a.version)
      let requiredJava = 8
      try {
        const vj = JSON.parse(readFileSync(versionJsonPath(versionId), 'utf-8')) as VersionJson
        requiredJava = vj.javaVersion?.majorVersion ?? 8
      } catch { /* fall back to 8 */ }
      const picked = javas.find(j => j.version >= requiredJava) ?? javas[0]
      const javaExe = picked ? join(picked.path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
      await runForgeProcessors(profile, versionId, instanceId, javaExe, onProgress)
    }

    report('Forge installed', 100)
  } finally {
    try { rmSync(installerPath) } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function copyMavenLibs(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(dstPath, { recursive: true })
      copyMavenLibs(srcPath, dstPath)
    } else if (!existsSync(dstPath)) {
      try { copyFileSync(srcPath, dstPath) } catch { /* ignore */ }
    }
  }
}

export async function installMinecraft(
  instanceId: string,
  versionId: string,
  versionUrl: string,
  modLoader?: string,
  modLoaderVersion?: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<{ modLoaderVersion?: string }> {
  const report = (p: InstallProgress) => onProgress?.(p)
  // The concrete loader version actually installed (may be auto-resolved
  // "latest" when the caller passed none) — returned so it can be persisted.
  let resolvedLoaderVersion: string | undefined = modLoaderVersion

  // 1. Download version JSON
  report({ step: 'Fetching version data', current: 0, total: 1, percent: 0 })
  const versionJson = await fetchJson<VersionJson>(versionUrl, signal)
  const vJsonPath = versionJsonPath(versionId)
  mkdirSync(require('path').dirname(vJsonPath), { recursive: true })
  require('fs').writeFileSync(vJsonPath, JSON.stringify(versionJson, null, 2))
  report({ step: 'Fetching version data', current: 1, total: 1, percent: 100 })

  // 2. Download client jar
  report({ step: 'Downloading client', current: 0, total: 1, percent: 0 })
  await downloadFile(versionJson.downloads.client.url, clientJarPath(versionId), undefined, signal, versionJson.downloads.client.sha1)
  report({ step: 'Downloading client', current: 1, total: 1, percent: 100 })

  // 3. Download vanilla libraries
  await downloadLibraries(versionJson.libraries, report, 'Downloading libraries', signal)

  // 4. Extract natives
  report({ step: 'Extracting natives', current: 0, total: 1, percent: 0 })
  await extractNatives(versionJson.libraries, instanceId)
  report({ step: 'Extracting natives', current: 1, total: 1, percent: 100 })

  // 5. Download assets
  await downloadAssets(versionJson, report, signal)

  // 6. Fabric loader
  if (modLoader === 'fabric') {
    report({ step: 'Installing Fabric loader', current: 0, total: 1, percent: 0 })

    let fabricLoaderVer = modLoaderVersion
    if (!fabricLoaderVer) {
      const loaders = await fetchFabricLoaderVersions(versionId)
      fabricLoaderVer = loaders[0]?.loader.version
      if (!fabricLoaderVer) throw new Error('No Fabric loader found for ' + versionId)
    }
    resolvedLoaderVersion = fabricLoaderVer

    const fabricJson = await fetchFabricVersionJson(versionId, fabricLoaderVer)
    const fabricJsonPath = join(paths.versions, `${versionId}-fabric`, `${versionId}-fabric.json`)
    mkdirSync(require('path').dirname(fabricJsonPath), { recursive: true })
    require('fs').writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2))

    await downloadLibraries(fabricJson.libraries, report, 'Downloading Fabric libraries', signal)
    report({ step: 'Installing Fabric loader', current: 1, total: 1, percent: 100 })
  }

  // 6b. Quilt loader
  if (modLoader === 'quilt') {
    report({ step: 'Installing Quilt loader', current: 0, total: 1, percent: 0 })

    let quiltLoaderVer = modLoaderVersion
    if (!quiltLoaderVer) {
      const loaders = await fetchQuiltLoaderVersions(versionId)
      quiltLoaderVer = loaders[0]?.loader.version
      if (!quiltLoaderVer) throw new Error('No Quilt loader found for ' + versionId)
    }
    resolvedLoaderVersion = quiltLoaderVer

    const quiltJson = await fetchQuiltVersionJson(versionId, quiltLoaderVer)
    const quiltJsonPath = join(paths.versions, `${versionId}-quilt`, `${versionId}-quilt.json`)
    mkdirSync(require('path').dirname(quiltJsonPath), { recursive: true })
    require('fs').writeFileSync(quiltJsonPath, JSON.stringify(quiltJson, null, 2))

    await downloadLibraries(quiltJson.libraries, report, 'Downloading Quilt libraries', signal)
    report({ step: 'Installing Quilt loader', current: 1, total: 1, percent: 100 })
  }

  // 7. Forge / NeoForge
  if (modLoader === 'forge' || modLoader === 'neoforge') {
    let forgeVer = modLoaderVersion
    if (!forgeVer) {
      report({ step: `Fetching latest ${modLoader === 'neoforge' ? 'NeoForge' : 'Forge'} version`, current: 0, total: 1, percent: 0 })
      forgeVer = modLoader === 'neoforge'
        ? await fetchNeoForgeLatestVersion(versionId)
        : await fetchForgeLatestVersion(versionId)
    }
    resolvedLoaderVersion = forgeVer
    await installForge(instanceId, versionId, forgeVer, modLoader === 'neoforge', onProgress, signal)
  }

  report({ step: 'Done', current: 1, total: 1, percent: 100 })
  return { modLoaderVersion: resolvedLoaderVersion }
}
