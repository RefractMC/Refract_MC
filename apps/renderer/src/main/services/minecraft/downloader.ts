import { join, relative, resolve } from 'path'
import { existsSync, createWriteStream, mkdirSync } from 'fs'
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

async function extractJar(jarPath: string, destDir: string, exclude: string[]): Promise<void> {
  if (!existsSync(jarPath)) return

  const { execFile } = require('child_process') as typeof import('child_process')
  const fs = require('fs') as typeof import('fs')
  const javaHome = process.env.JAVA_HOME ?? ''
  const jarExe = javaHome ? join(javaHome, 'bin', 'jar') : 'jar'

  // First list entries and reject any that would escape destDir (Zip Slip guard)
  await new Promise<void>((res, rej) => {
    execFile(jarExe, ['tf', jarPath], (err, stdout) => {
      if (err) { res(); return }
      const entries = stdout.split('\n').map(e => e.trim()).filter(Boolean)
      for (const entry of entries) {
        const dest = resolve(destDir, entry)
        if (relative(destDir, dest).startsWith('..')) {
          rej(new Error(`Zip Slip rejected: entry '${entry}' escapes destination`))
          return
        }
      }
      res()
    })
  }).catch(() => { return })

  await new Promise<void>((res) => {
    execFile(jarExe, ['xf', jarPath], { cwd: destDir }, (err) => {
      if (err) { res(); return }
      for (const ex of exclude) {
        const p = join(destDir, ex)
        if (existsSync(p)) {
          try { fs.rmSync(p, { recursive: true }) } catch { /* ignore */ }
        }
      }
      res()
    })
  })
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

  report({ step: 'Done', current: 1, total: 1, percent: 100 })
}
