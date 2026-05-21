import { join, relative, resolve } from 'path'
import { existsSync, createWriteStream, mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createUnzip } from 'zlib'
import { pipeline } from 'stream/promises'
import https from 'https'
import http from 'http'
import { paths } from '../paths'
import { downloadFile, fetchJson } from '../download'
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
  return join(paths.instances, instanceId, 'minecraft', 'natives')
}

export function libraryPath(libPath: string): string {
  return join(paths.libraries, libPath)
}

async function downloadLibraries(
  libs: Library[],
  onProgress: ProgressCallback,
  step: string
): Promise<void> {
  const allowed = libs.filter(lib => isLibraryAllowed(lib, OS))
  const total = allowed.length
  let current = 0

  for (const lib of allowed) {
    current++
    onProgress({ step, current, total, percent: (current / total) * 100 })

    if (lib.downloads?.artifact) {
      const dest = resolve(paths.libraries, lib.downloads.artifact.path)
      if (relative(paths.libraries, dest).startsWith('..')) continue
      await downloadFile(lib.downloads.artifact.url, dest)
    } else if (lib.name && lib.url) {
      const relPath = mavenCoordToPath(lib.name)
      const dest = resolve(paths.libraries, relPath)
      if (relative(paths.libraries, dest).startsWith('..')) continue
      const baseUrl = lib.url.endsWith('/') ? lib.url : lib.url + '/'
      await downloadFile(baseUrl + relPath.replace(/\\/g, '/'), dest)
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
    // Extract to a temp dir via .NET ZipFile (works with any extension, no JDK needed)
    const tmpDir = `${destDir}_tmp_${Date.now()}`
    const ps = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath.replace(/'/g, "''")}', '${tmpDir.replace(/'/g, "''")}')`,
    ].join('; ')
    await new Promise<void>(res => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000 }, () => res())
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
  onProgress: ProgressCallback
): Promise<void> {
  const indexPath = join(paths.assets, 'indexes', `${versionJson.assetIndex.id}.json`)
  await downloadFile(versionJson.assetIndex.url, indexPath)

  const index = JSON.parse(require('fs').readFileSync(indexPath, 'utf-8')) as AssetIndex
  const objects = Object.values(index.objects)
  const total = objects.length
  let current = 0

  // Download in batches of 10
  for (let i = 0; i < objects.length; i += 10) {
    const batch = objects.slice(i, i + 10)
    await Promise.all(batch.map(async (obj) => {
      const prefix = obj.hash.slice(0, 2)
      const dest = join(paths.assets, 'objects', prefix, obj.hash)
      await downloadFile(`${RESOURCES_URL}/${prefix}/${obj.hash}`, dest)
    }))
    current = Math.min(i + 10, total)
    onProgress({ step: 'Downloading assets', current, total, percent: (current / total) * 100 })
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

    await new Promise<void>(res => {
      execFile(javaExe, ['-cp', cp, ...args], { timeout: 120_000 }, () => res())
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

async function installForge(
  instanceId: string,
  versionId: string,
  forgeVersion: string,
  isNeoForge: boolean,
  onProgress?: ProgressCallback
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

  report('Downloading Forge installer', 0)
  await downloadFile(installerUrl, installerPath, ({ percent: p }) => report('Downloading Forge installer', p * 0.3))

  // Extract installer (it's a ZIP/JAR)
  report('Extracting Forge installer', 30)
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const { execFile } = require('child_process') as typeof import('child_process')
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${installerPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
    ].join('; ')
    await new Promise<void>(res => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000 }, () => res())
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

  // Save forge version JSON (used by launcher to build classpath/mainClass)
  const forgeJsonDir  = join(paths.versions, `${versionId}-forge`)
  const forgeJsonPath = join(forgeJsonDir, `${versionId}-forge.json`)
  mkdirSync(forgeJsonDir, { recursive: true })
  writeFileSync(forgeJsonPath, JSON.stringify(forgeJson, null, 2))

  // Download Forge libraries
  report('Downloading Forge libraries', 35)
  await downloadLibraries(forgeJson.libraries, onProgress, 'Downloading Forge libraries')

  // Also download install_profile libraries (the processor tools)
  if (existsSync(profileSrc)) {
    const profile = JSON.parse(readFileSync(profileSrc, 'utf-8')) as ForgeInstallProfile
    if (profile.libraries?.length) {
      report('Downloading Forge tools', 55)
      await downloadLibraries(profile.libraries, onProgress, 'Downloading Forge tools')
    }

    // Copy embedded maven libraries from installer into our libraries dir
    const mavenDir = join(extractDir, 'maven')
    if (existsSync(mavenDir)) copyMavenLibs(mavenDir, paths.libraries)

    // Run Forge processors (patch the Minecraft client JAR)
    report('Running Forge processors', 70)
    const { detectJavaInstallations } = await import('@refract/core/java-manager')
    const javas = await detectJavaInstallations()
    const javaExe = javas[0] ? join(javas[0].path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    await runForgeProcessors(profile, versionId, instanceId, javaExe, onProgress)
  }

  // Cleanup
  try { rmSync(installerPath) } catch { /* ignore */ }
  try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }

  report('Forge installed', 100)
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
  onProgress?: ProgressCallback
): Promise<void> {
  const report = (p: InstallProgress) => onProgress?.(p)

  // 1. Download version JSON
  report({ step: 'Fetching version data', current: 0, total: 1, percent: 0 })
  const versionJson = await fetchJson<VersionJson>(versionUrl)
  const vJsonPath = versionJsonPath(versionId)
  mkdirSync(require('path').dirname(vJsonPath), { recursive: true })
  require('fs').writeFileSync(vJsonPath, JSON.stringify(versionJson, null, 2))
  report({ step: 'Fetching version data', current: 1, total: 1, percent: 100 })

  // 2. Download client jar
  report({ step: 'Downloading client', current: 0, total: 1, percent: 0 })
  await downloadFile(versionJson.downloads.client.url, clientJarPath(versionId))
  report({ step: 'Downloading client', current: 1, total: 1, percent: 100 })

  // 3. Download vanilla libraries
  await downloadLibraries(versionJson.libraries, report, 'Downloading libraries')

  // 4. Extract natives
  report({ step: 'Extracting natives', current: 0, total: 1, percent: 0 })
  await extractNatives(versionJson.libraries, instanceId)
  report({ step: 'Extracting natives', current: 1, total: 1, percent: 100 })

  // 5. Download assets
  await downloadAssets(versionJson, report)

  // 6. Fabric loader
  if (modLoader === 'fabric') {
    report({ step: 'Installing Fabric loader', current: 0, total: 1, percent: 0 })

    let fabricLoaderVer = modLoaderVersion
    if (!fabricLoaderVer) {
      const loaders = await fetchFabricLoaderVersions(versionId)
      fabricLoaderVer = loaders[0]?.loader.version
      if (!fabricLoaderVer) throw new Error('No Fabric loader found for ' + versionId)
    }

    const fabricJson = await fetchFabricVersionJson(versionId, fabricLoaderVer)
    const fabricJsonPath = join(paths.versions, `${versionId}-fabric`, `${versionId}-fabric.json`)
    mkdirSync(require('path').dirname(fabricJsonPath), { recursive: true })
    require('fs').writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2))

    await downloadLibraries(fabricJson.libraries, report, 'Downloading Fabric libraries')
    report({ step: 'Installing Fabric loader', current: 1, total: 1, percent: 100 })
  }

  // 7. Forge / NeoForge
  if (modLoader === 'forge' || modLoader === 'neoforge') {
    if (!modLoaderVersion) throw new Error(`${modLoader} version not specified.`)
    await installForge(instanceId, versionId, modLoaderVersion, modLoader === 'neoforge', onProgress)
  }

  report({ step: 'Done', current: 1, total: 1, percent: 100 })
}
