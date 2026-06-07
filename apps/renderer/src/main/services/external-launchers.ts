import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'

export type ExternalSource = 'prism' | 'multimc' | 'modrinth' | 'atlauncher' | 'curseforge' | 'gdlauncher'

export interface ExternalInstance {
  source: ExternalSource
  sourceName: string
  name: string
  minecraftVersion: string
  modLoader?: string
  modLoaderVersion?: string
  instanceDir: string
  gameDir: string
}

function appdata(): string {
  return process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
}

function tryReadJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T }
  catch { return null }
}

function tryReadText(path: string): string | null {
  try { return readFileSync(path, 'utf-8') }
  catch { return null }
}

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq === -1 || line.startsWith('[')) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function subDirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(dir, e.name))
  } catch { return [] }
}

// ── Prism / MultiMC ──────────────────────────────────────────────────────────

interface MmcPack { components: Array<{ uid: string; version?: string }> }

function scanMmc(baseDir: string, source: ExternalSource, sourceName: string): ExternalInstance[] {
  const results: ExternalInstance[] = []
  for (const instanceDir of subDirs(baseDir)) {
    const cfgPath  = join(instanceDir, 'instance.cfg')
    const packPath = join(instanceDir, 'mmc-pack.json')
    if (!existsSync(cfgPath) || !existsSync(packPath)) continue

    const cfg  = parseIni(tryReadText(cfgPath) ?? '')
    const pack = tryReadJson<MmcPack>(packPath)
    if (!pack) continue

    const mc = pack.components.find(c => c.uid === 'net.minecraft')
    if (!mc?.version) continue

    const name = cfg['name'] ?? require('path').basename(instanceDir)
    let modLoader: string | undefined
    let modLoaderVersion: string | undefined
    for (const c of pack.components) {
      if (c.uid === 'net.minecraftforge')         { modLoader = 'forge';    modLoaderVersion = c.version; break }
      if (c.uid === 'net.neoforged.neoforge')     { modLoader = 'neoforge'; modLoaderVersion = c.version; break }
      if (c.uid === 'net.fabricmc.fabric-loader') { modLoader = 'fabric';   modLoaderVersion = c.version; break }
      if (c.uid === 'org.quiltmc.quilt-loader')   { modLoader = 'quilt';    modLoaderVersion = c.version; break }
    }

    const dotMc = join(instanceDir, '.minecraft')
    const mcDir = existsSync(dotMc) ? dotMc : join(instanceDir, 'minecraft')

    results.push({ source, sourceName, name, minecraftVersion: mc.version, modLoader, modLoaderVersion, instanceDir, gameDir: mcDir })
  }
  return results
}

// ── Modrinth App ─────────────────────────────────────────────────────────────

interface ModrinthProfile {
  metadata?: { name?: string; game_version?: string; loader?: string; loader_version?: string }
  name?: string
  game_version?: string
  loader?: string
  loader_version?: string
}

function loaderName(raw?: string): string | undefined {
  if (!raw) return undefined
  const l = raw.toLowerCase()
  if (l === 'forge' || l === 'neoforge' || l === 'fabric' || l === 'quilt') return l
  return undefined
}

function scanModrinth(): ExternalInstance[] {
  const base = join(appdata(), 'com.modrinth.theseus', 'profiles')
  const results: ExternalInstance[] = []
  for (const instanceDir of subDirs(base)) {
    const p = tryReadJson<ModrinthProfile>(join(instanceDir, 'profile.json'))
    if (!p) continue
    const meta = p.metadata ?? p
    const mcVersion = meta.game_version
    if (!mcVersion) continue
    const name = meta.name ?? require('path').basename(instanceDir)
    results.push({
      source: 'modrinth',
      sourceName: 'Modrinth App',
      name,
      minecraftVersion: mcVersion,
      modLoader: loaderName(meta.loader),
      modLoaderVersion: meta.loader_version ?? undefined,
      instanceDir,
      gameDir: instanceDir,
    })
  }
  return results
}

// ── ATLauncher ───────────────────────────────────────────────────────────────

interface ATLInstance {
  launcher?: {
    name?: string
    minecraftVersion?: string
    loaderVersion?: { type?: string | number; version?: string }
  }
  id?: string
  name?: string
  minecraftVersion?: string
}

function atlLoaderName(type?: string | number): string | undefined {
  if (!type) return undefined
  const s = String(type).toLowerCase()
  if (s === 'fabric' || s === '4') return 'fabric'
  if (s === 'forge'  || s === '1') return 'forge'
  if (s === 'quilt'  || s === '5') return 'quilt'
  if (s === 'neoforge' || s === '6') return 'neoforge'
  return undefined
}

function scanATLauncher(): ExternalInstance[] {
  const base = join(appdata(), 'ATLauncher', 'instances')
  const results: ExternalInstance[] = []
  for (const instanceDir of subDirs(base)) {
    const p = tryReadJson<ATLInstance>(join(instanceDir, 'instance.json'))
    if (!p) continue
    const l = p.launcher
    const mcVersion = l?.minecraftVersion ?? p.minecraftVersion
    if (!mcVersion) continue
    const name = l?.name ?? p.name ?? require('path').basename(instanceDir)
    results.push({
      source: 'atlauncher',
      sourceName: 'ATLauncher',
      name,
      minecraftVersion: mcVersion,
      modLoader: atlLoaderName(l?.loaderVersion?.type),
      modLoaderVersion: l?.loaderVersion?.version,
      instanceDir,
      gameDir: join(instanceDir, '.minecraft'),
    })
  }
  return results
}

// ── CurseForge ───────────────────────────────────────────────────────────────

interface CFInstanceJson {
  name?: string
  gameVersion?: string
  baseModLoader?: { name?: string; type?: number }
}

function cfLoaderName(type?: number, name?: string): string | undefined {
  if (type === 1) return 'forge'
  if (type === 4) return 'fabric'
  if (type === 5) return 'quilt'
  if (type === 6) return 'neoforge'
  if (!name) return undefined
  const l = name.toLowerCase()
  if (l.includes('neoforge')) return 'neoforge'
  if (l.includes('forge'))    return 'forge'
  if (l.includes('fabric'))   return 'fabric'
  if (l.includes('quilt'))    return 'quilt'
  return undefined
}

function cfLoaderVersion(modLoaderName?: string): string | undefined {
  if (!modLoaderName) return undefined
  // e.g. "forge-47.2.0" or "fabric-loader-0.15.11-1.21.1"
  const parts = modLoaderName.split('-')
  // find the version segment (first all-digit-dot part)
  for (const p of parts) {
    if (/^\d+\.\d+/.test(p)) return p
  }
  return undefined
}

function scanCurseForge(): ExternalInstance[] {
  const candidates = [
    join(process.env.USERPROFILE ?? '', 'curseforge', 'minecraft', 'Instances'),
    join(process.env.USERPROFILE ?? '', 'Documents', 'curseforge', 'minecraft', 'Instances'),
    join('C:\\', 'curseforge', 'minecraft', 'Instances'),
  ]
  const results: ExternalInstance[] = []
  for (const base of candidates) {
    for (const instanceDir of subDirs(base)) {
      const p = tryReadJson<CFInstanceJson>(join(instanceDir, 'minecraftinstance.json'))
      if (!p?.gameVersion) continue
      const modLoader = cfLoaderName(p.baseModLoader?.type, p.baseModLoader?.name)
      results.push({
        source: 'curseforge',
        sourceName: 'CurseForge',
        name: p.name ?? require('path').basename(instanceDir),
        minecraftVersion: p.gameVersion,
        modLoader,
        modLoaderVersion: cfLoaderVersion(p.baseModLoader?.name),
        instanceDir,
        gameDir: instanceDir,
      })
    }
    if (results.length) break
  }
  return results
}

// ── GDLauncher Carbon ────────────────────────────────────────────────────────

interface GDLInstance {
  config?: { name?: string; version?: string; loader?: { type?: string; version?: string } }
  name?: string
  version?: string
}

function scanGDLauncher(): ExternalInstance[] {
  const base = join(appdata(), 'gdlauncher_carbon', 'instances')
  const results: ExternalInstance[] = []
  for (const instanceDir of subDirs(base)) {
    const p = tryReadJson<GDLInstance>(join(instanceDir, 'instance.json'))
    if (!p) continue
    const cfg = p.config ?? p
    const mcVersion = cfg.version
    if (!mcVersion) continue
    results.push({
      source: 'gdlauncher',
      sourceName: 'GDLauncher',
      name: cfg.name ?? p.name ?? require('path').basename(instanceDir),
      minecraftVersion: mcVersion,
      modLoader: loaderName((p.config?.loader?.type)),
      modLoaderVersion: p.config?.loader?.version,
      instanceDir,
      gameDir: join(instanceDir, '.minecraft'),
    })
  }
  return results
}

// ── public API ───────────────────────────────────────────────────────────────

export function scanExternalInstances(): ExternalInstance[] {
  const ad = appdata()
  return [
    ...scanMmc(join(ad, 'PrismLauncher', 'instances'), 'prism', 'Prism Launcher'),
    ...scanMmc(join(ad, 'MultiMC', 'instances'),        'multimc', 'MultiMC'),
    ...scanModrinth(),
    ...scanATLauncher(),
    ...scanCurseForge(),
    ...scanGDLauncher(),
  ]
}
