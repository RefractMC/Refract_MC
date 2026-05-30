import { join } from 'path'
import { BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { handleIpc } from './handle'
import type { JavaInstallation } from '@refract/core'
import { getManagedJavaDir, loadManagedJavas, saveManagedJavas } from '../services/java-manager'

function emitJavaProgress(major: number, step: string, percent: number): void {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('java:progress', { major, step, percent }))
}

function probeJavaExe(javaExe: string): JavaInstallation | null {
  try {
    const result = spawnSync(javaExe, ['-XshowSettings:property', '-version'], { timeout: 5000, encoding: 'utf8' })
    const out = (result.stdout ?? '') + (result.stderr ?? '')
    const vMatch = out.match(/java\.version\s*=\s*([\d._]+)/) ?? out.match(/version "([^"]+)"/)
    if (!vMatch) return null
    const ver = vMatch[1]
    const major = ver.startsWith('1.') ? parseInt(ver.split('.')[1], 10) : parseInt(ver.split('.')[0], 10)
    if (!major) return null
    const vendor = out.match(/java\.vendor\s*=\s*(.+)/)?.[1]?.trim() ?? 'Adoptium Temurin'
    return { version: major, path: join(javaExe, '..', '..').normalize(), vendor }
  } catch { return null }
}

const IS_WIN = process.platform === 'win32'

function javaExeName() { return IS_WIN ? 'java.exe' : 'java' }

function adoptiumOs(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function adoptiumArch(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

function findJavaExeInDir(dir: string): string | null {
  if (!existsSync(dir)) return null
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const exe = join(dir, entry.name, 'bin', javaExeName())
      if (existsSync(exe)) return exe
    }
  } catch { /* ignore */ }
  return null
}

export function requiredJavaVersion(mcVersion: string): number {
  const parts = mcVersion.split('.').map(Number)
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 17) return 17
  return 8
}

export function registerJavaIpc(): void {
  handleIpc('java.managedList', () => loadManagedJavas())

  handleIpc('java.requiredFor', (_e, mcVersion: unknown) => requiredJavaVersion(String(mcVersion)))

  handleIpc('java.download', async (_e, major: unknown) => {
    const majorNum = Number(major)
    emitJavaProgress(majorNum, 'Fetching release info…', 2)

    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${majorNum}/hotspot?os=${adoptiumOs()}&arch=${adoptiumArch()}&image_type=jre`
    const metaRes = await fetch(apiUrl)
    if (!metaRes.ok) throw new Error(`Adoptium API error: HTTP ${metaRes.status}`)

    type AdoptiumAsset = { binary: { package: { link: string; name: string } } }
    const assets = await metaRes.json() as AdoptiumAsset[]
    const pkg = assets[0]?.binary?.package
    if (!pkg?.link) throw new Error(`No JRE package found for Java ${majorNum}`)

    emitJavaProgress(majorNum, 'Downloading…', 5)

    const dlRes = await fetch(pkg.link)
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`)

    const contentLength = Number(dlRes.headers.get('content-length') ?? 0)
    const reader = dlRes.body?.getReader()
    if (!reader) throw new Error('No response body')

    const chunks: Uint8Array[] = []
    let downloaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      downloaded += value.length
      if (contentLength > 0) {
        const pct = 5 + Math.round((downloaded / contentLength) * 65)
        const mb = Math.round(downloaded / 1024 / 1024)
        const total = Math.round(contentLength / 1024 / 1024)
        emitJavaProgress(majorNum, `Downloading… ${mb} / ${total} MB`, pct)
      }
    }

    const javaBaseDir = getManagedJavaDir()
    mkdirSync(javaBaseDir, { recursive: true })
    const zipPath = join(javaBaseDir, pkg.name)
    writeFileSync(zipPath, Buffer.concat(chunks.map(c => Buffer.from(c))))

    emitJavaProgress(majorNum, 'Extracting…', 72)

    const extractDir = join(javaBaseDir, `jre-${majorNum}`)
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
    mkdirSync(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      const proc = IS_WIN
        ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${extractDir}" -Force`])
        : spawn('tar', ['xzf', zipPath, '-C', extractDir, '--strip-components=1'])
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Extraction failed (exit ${code})`)))
      proc.on('error', reject)
    })

    try { rmSync(zipPath) } catch { /* ignore */ }

    emitJavaProgress(majorNum, 'Verifying installation…', 94)

    // On Linux (--strip-components=1) the bin/ is directly in extractDir
    const directExe = join(extractDir, 'bin', javaExeName())
    const javaExe = existsSync(directExe) ? directExe : findJavaExeInDir(extractDir)
    if (!javaExe) throw new Error(`${javaExeName()} not found in extracted JRE`)
    if (!IS_WIN) { try { chmodSync(javaExe, 0o755) } catch { /* ignore */ } }

    const probed = probeJavaExe(javaExe)
    const installation: JavaInstallation = probed ?? {
      version: majorNum,
      path: join(javaExe, '..', '..').normalize(),
      vendor: 'Adoptium Temurin',
    }

    const managed = loadManagedJavas().filter(j => j.version !== majorNum)
    managed.push(installation)
    saveManagedJavas(managed)

    emitJavaProgress(majorNum, 'Done', 100)
    return installation
  })

  handleIpc('java.delete', (_e, major: unknown) => {
    const majorNum = Number(major)
    const extractDir = join(getManagedJavaDir(), `jre-${majorNum}`)
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
    saveManagedJavas(loadManagedJavas().filter(j => j.version !== majorNum || (j as JavaInstallation & { custom?: boolean }).custom))
  })

  handleIpc('java.browseExe', async () => {
    const { filePaths } = await dialog.showOpenDialog({
      title: 'Select Java executable',
      filters: IS_WIN ? [{ name: 'Java Executable', extensions: ['exe'] }] : [{ name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return filePaths[0] ?? null
  })

  handleIpc('java.addCustom', (_e, javaPath: unknown) => {
    const exe = String(javaPath).trim()
    if (!existsSync(exe)) throw new Error(`File not found: ${exe}`)
    const probed = probeJavaExe(exe)
    if (!probed) throw new Error('Not a valid Java executable — could not read version.')
    const installation = { ...probed, custom: true } as JavaInstallation & { custom: boolean }
    const managed = loadManagedJavas().filter(j => j.path !== probed.path)
    managed.push(installation)
    saveManagedJavas(managed)
    return installation
  })

  handleIpc('java.removeCustom', (_e, javaPath: unknown) => {
    saveManagedJavas(loadManagedJavas().filter(j => j.path !== String(javaPath)))
  })
}
