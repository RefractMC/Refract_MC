import { join } from 'path'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, chmodSync } from 'fs'
import { spawn } from 'child_process'
import type { JavaInstallation } from '@refract/core'
import { detectJavaInstallations } from '@refract/core/java-manager'

const IS_WIN = process.platform === 'win32'
const javaExeName = () => (IS_WIN ? 'java.exe' : 'java')

export function getManagedJavaDir(): string {
  return join(app.getPath('userData'), 'java')
}

export function loadManagedJavas(): JavaInstallation[] {
  const jsonPath = join(getManagedJavaDir(), 'managed.json')
  if (!existsSync(jsonPath)) return []
  try { return JSON.parse(readFileSync(jsonPath, 'utf-8')) as JavaInstallation[] } catch { return [] }
}

export function saveManagedJavas(list: JavaInstallation[]): void {
  const dir = getManagedJavaDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'managed.json'), JSON.stringify(list, null, 2))
}

/** The Java major a Minecraft version needs (heuristic; the version JSON's own
 *  javaVersion.majorVersion is preferred at launch when present). */
export function requiredJavaVersion(mcVersion: string): number {
  const parts = mcVersion.split('.').map(Number)
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 17) return 17
  return 8
}

export function probeJavaExe(javaExe: string): Promise<JavaInstallation | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(javaExe, ['-XshowSettings:property', '-version'])
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
      const finish = () => {
        const vMatch = out.match(/java\.version\s*=\s*([\d._]+)/) ?? out.match(/version "([^"]+)"/)
        if (!vMatch) { resolve(null); return }
        const ver = vMatch[1]
        const major = ver.startsWith('1.') ? parseInt(ver.split('.')[1], 10) : parseInt(ver.split('.')[0], 10)
        if (!major) { resolve(null); return }
        const vendor = out.match(/java\.vendor\s*=\s*(.+)/)?.[1]?.trim() ?? 'Adoptium Temurin'
        resolve({ version: major, path: join(javaExe, '..', '..').normalize(), vendor })
      }
      proc.on('close', finish)
      proc.on('error', () => resolve(null))
      setTimeout(() => { try { proc.kill() } catch { /* ignore */ } finish() }, 5000)
    } catch { resolve(null) }
  })
}

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

export type JavaProgress = (step: string, percent: number) => void

/** Download a Temurin JRE for the given major from Adoptium, extract it under
 *  userData/java/jre-<major>, register it in managed.json, and return it. */
export async function downloadJava(major: number, onProgress?: JavaProgress): Promise<JavaInstallation> {
  const report = onProgress ?? (() => {})
  report('Fetching release info…', 2)

  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${adoptiumOs()}&arch=${adoptiumArch()}&image_type=jre`
  const metaRes = await fetch(apiUrl)
  if (!metaRes.ok) throw new Error(`Adoptium API error: HTTP ${metaRes.status}`)
  type AdoptiumAsset = { binary: { package: { link: string; name: string } } }
  const assets = await metaRes.json() as AdoptiumAsset[]
  const pkg = assets[0]?.binary?.package
  if (!pkg?.link) throw new Error(`No JRE package found for Java ${major}`)

  report('Downloading…', 5)
  const dlRes = await fetch(pkg.link)
  if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`)
  const contentLength = Number(dlRes.headers.get('content-length') ?? 0)
  const reader = dlRes.body?.getReader()
  if (!reader) throw new Error('No response body')

  const chunks: Uint8Array[] = []
  let downloaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    downloaded += value.length
    if (contentLength > 0) {
      const pct = 5 + Math.round((downloaded / contentLength) * 65)
      report(`Downloading Java ${major}… ${Math.round(downloaded / 1048576)} / ${Math.round(contentLength / 1048576)} MB`, pct)
    }
  }

  const javaBaseDir = getManagedJavaDir()
  mkdirSync(javaBaseDir, { recursive: true })
  const zipPath = join(javaBaseDir, pkg.name)
  writeFileSync(zipPath, Buffer.concat(chunks.map(c => Buffer.from(c))))

  report('Extracting…', 72)
  const extractDir = join(javaBaseDir, `jre-${major}`)
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

  report('Verifying installation…', 94)
  const directExe = join(extractDir, 'bin', javaExeName())
  const javaExe = existsSync(directExe) ? directExe : findJavaExeInDir(extractDir)
  if (!javaExe) throw new Error(`${javaExeName()} not found in extracted JRE`)
  if (!IS_WIN) { try { chmodSync(javaExe, 0o755) } catch { /* ignore */ } }

  const probed = await probeJavaExe(javaExe)
  const installation: JavaInstallation = probed ?? { version: major, path: join(javaExe, '..', '..').normalize(), vendor: 'Adoptium Temurin' }

  const managed = loadManagedJavas().filter(j => j.version !== major)
  managed.push(installation)
  saveManagedJavas(managed)

  report('Done', 100)
  return installation
}

/** Best already-installed runtime (detected + managed) that satisfies `major`,
 *  preferring the smallest eligible major (loaders bootstrap against a specific
 *  Java, so newer-than-needed can break Forge). */
export async function findInstalledJava(major: number): Promise<JavaInstallation | undefined> {
  const all = [...await detectJavaInstallations(), ...loadManagedJavas()]
  const seen = new Set<string>()
  const uniq = all.filter(j => (seen.has(j.path) ? false : (seen.add(j.path), true)))
  return uniq.filter(j => j.version >= major).sort((a, b) => a.version - b.version)[0]
}

/** Return a runtime satisfying `major`, downloading one if none is installed. */
export async function ensureJava(major: number, onProgress?: JavaProgress): Promise<JavaInstallation> {
  return (await findInstalledJava(major)) ?? downloadJava(major, onProgress)
}
