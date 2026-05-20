import { execSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

export interface JavaInstallation {
  version: number
  path: string
  vendor: string
}

function probeJava(javaExe: string): JavaInstallation | null {
  try {
    const out = execSync(`"${javaExe}" -XshowSettings:property -version 2>&1`, { timeout: 5000 }).toString()
    const vMatch = out.match(/java\.version\s*=\s*([\d._]+)/) ?? out.match(/version "([^"]+)"/)
    const major = vMatch ? parseMajor(vMatch[1]) : 0
    if (!major) return null
    const vendor = out.match(/java\.vendor\s*=\s*(.+)/)?.[1]?.trim() ?? 'Unknown'
    const home = join(javaExe, '..', '..').replace(/[\\/]bin[\\/]java(\.exe)?$/i, '')
    return { version: major, path: home, vendor }
  } catch {
    return null
  }
}

function parseMajor(ver: string): number {
  if (ver.startsWith('1.')) {
    return parseInt(ver.split('.')[1], 10)
  }
  return parseInt(ver.split('.')[0], 10)
}

function scanDir(dir: string): JavaInstallation[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .flatMap(e => {
        const exe = join(dir, e.name, 'bin', 'java.exe')
        if (!existsSync(exe)) return []
        const j = probeJava(exe)
        return j ? [j] : []
      })
  } catch {
    return []
  }
}

export async function detectJavaInstallations(): Promise<JavaInstallation[]> {
  const found: JavaInstallation[] = []
  const seen = new Set<string>()

  function add(j: JavaInstallation | null) {
    if (!j || seen.has(j.path)) return
    seen.add(j.path)
    found.push(j)
  }

  // 1. JAVA_HOME
  if (process.env.JAVA_HOME) {
    add(probeJava(join(process.env.JAVA_HOME, 'bin', 'java.exe')))
  }

  // 2. PATH
  try {
    const which = execSync('where java', { timeout: 3000 }).toString().trim().split(/\r?\n/)
    for (const p of which) {
      add(probeJava(p.trim()))
    }
  } catch { /* not in PATH */ }

  // 3. Windows registry
  try {
    const reg = execSync(
      'reg query "HKLM\\SOFTWARE\\JavaSoft" /s /v JavaHome 2>nul',
      { timeout: 5000 }
    ).toString()
    const matches = [...reg.matchAll(/JavaHome\s+REG_SZ\s+(.+)/g)]
    for (const m of matches) {
      add(probeJava(join(m[1].trim(), 'bin', 'java.exe')))
    }
  } catch { /* registry query failed */ }

  // 4. Common install dirs
  const commonDirs = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files (x86)\\Java',
  ]
  for (const dir of commonDirs) {
    for (const j of scanDir(dir)) add(j)
  }

  return found.sort((a, b) => b.version - a.version)
}
