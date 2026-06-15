import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, renameSync } from 'fs'
import { paths } from './paths'
import { createInstance, type Instance, type CreateInstanceInput } from '@refract/core'

// ── Custom-path registry ──────────────────────────────────────────────────────
interface RegistryEntry { id: string; path: string }

function registryFilePath(): string { return join(paths.userData, 'instance-registry.json') }

function readRegistry(): RegistryEntry[] {
  try {
    const p = registryFilePath()
    if (!existsSync(p)) return []
    return JSON.parse(readFileSync(p, 'utf-8')) as RegistryEntry[]
  } catch { return [] }
}

function writeRegistry(entries: RegistryEntry[]): void {
  writeFileSync(registryFilePath(), JSON.stringify(entries, null, 2), 'utf-8')
}

// Cyrillic → Latin (Ukrainian/Russian). Used only for the on-disk folder name so
// non-Latin instance names still produce an ASCII path; the pretty Unicode name
// is kept separately in instance.name for display.
const CYRILLIC_MAP: Record<string, string> = {
  а:'a', б:'b', в:'v', г:'h', ґ:'g', д:'d', е:'e', є:'ie', ж:'zh', з:'z',
  и:'y', і:'i', ї:'i', й:'i', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p',
  р:'r', с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch',
  ь:'', ю:'iu', я:'ia', ё:'e', ы:'y', э:'e', ъ:'',
}

function transliterate(name: string): string {
  let out = ''
  for (const ch of name) {
    const lower = ch.toLowerCase()
    const mapped = CYRILLIC_MAP[lower]
    if (mapped === undefined) { out += ch; continue }
    // Preserve casing: capitalise the mapped form when the source was uppercase.
    out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
  }
  return out
}

// Sanitize a user-provided instance name into a safe, ASCII-only folder name.
// Non-Latin scripts are transliterated (Cyrillic) or dropped (others) so the
// launch path never contains characters the JVM mangles under a non-UTF-8
// Windows code page. Falls back to "instance" when nothing usable remains.
function sanitizeFolderName(name: string): string {
  const safe = transliterate(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '') // strip Windows/POSIX-invalid chars
    .replace(/[^\x20-\x7e]+/g, '')          // drop any remaining non-ASCII
    .replace(/\s+/g, ' ')                    // collapse whitespace left by drops
    .trim()
    .replace(/\.+$/, '')                      // no trailing dots
    .slice(0, 64)
    .trim()
  return safe || 'instance'
}

// Return a folder name that doesn't conflict with any existing directory.
// Pass `currentFolder` to allow "same name" (e.g. on rename without a real change).
function uniqueFolderName(desired: string, currentFolder?: string): string {
  const base = sanitizeFolderName(desired)
  if (base === currentFolder) return base
  if (!existsSync(join(paths.instances, base))) return base
  let i = 2
  while (existsSync(join(paths.instances, `${base} (${i})`))) i++
  return `${base} (${i})`
}

// Given an instance id, find its directory on disk.
export function resolveInstanceDir(id: string): string {
  // Registry (includes custom paths)
  const registered = readRegistry().find(r => r.id === id)
  if (registered && existsSync(registered.path)) return registered.path

  // Fast path for legacy instances (folder == UUID)
  const legacy = join(paths.instances, id)
  if (existsSync(join(legacy, 'instance.json'))) return legacy

  // Scan default instances dir
  if (existsSync(paths.instances)) {
    for (const entry of readdirSync(paths.instances, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const jsonPath = join(paths.instances, entry.name, 'instance.json')
      if (!existsSync(jsonPath)) continue
      try {
        const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { id?: string }
        if (data.id === id) return join(paths.instances, entry.name)
      } catch { continue }
    }
  }
  return legacy
}

function instanceJsonPath(dir: string): string {
  return join(dir, 'instance.json')
}

// The directory that actually holds this instance's game content (mods, saves,
// screenshots, servers, …). For an instance linked from another launcher this
// is that launcher's game folder; otherwise it's our managed <instance>/minecraft.
export function resolveGameDir(id: string): string {
  const inst = getInstanceById(id)
  if (inst?.externalGameDir) return inst.externalGameDir
  return join(resolveInstanceDir(id), 'minecraft')
}

// ---------- public API ----------

export function listInstances(): Instance[] {
  const seen = new Set<string>()
  const instances: Instance[] = []

  if (existsSync(paths.instances)) {
    for (const e of readdirSync(paths.instances, { withFileTypes: true }).filter(e => e.isDirectory())) {
      const jsonPath = join(paths.instances, e.name, 'instance.json')
      if (!existsSync(jsonPath)) continue
      try {
        const inst = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Instance
        if (inst.id) { seen.add(inst.id); instances.push(inst) }
      } catch { continue }
    }
  }

  // Custom-path instances from registry
  for (const { id, path } of readRegistry()) {
    if (seen.has(id)) continue
    const jsonPath = join(path, 'instance.json')
    if (!existsSync(jsonPath)) continue
    try {
      const inst = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Instance
      seen.add(inst.id ?? id)
      instances.push(inst)
    } catch { continue }
  }

  return instances.sort((a, b) => (b.lastPlayed ?? b.createdAt).localeCompare(a.lastPlayed ?? a.createdAt))
}

export function getInstanceById(id: string): Instance | null {
  const dir = resolveInstanceDir(id)
  const jsonPath = instanceJsonPath(dir)
  if (!existsSync(jsonPath)) return null
  try { return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Instance }
  catch { return null }
}

export function saveInstance(instance: Instance): Instance {
  const dir = instance.customPath ?? join(paths.instances, instance.folderName ?? instance.id)
  mkdirSync(join(dir, 'minecraft', 'mods'), { recursive: true })
  writeFileSync(instanceJsonPath(dir), JSON.stringify(instance, null, 2), 'utf-8')
  return instance
}

export function createAndSaveInstance(input: CreateInstanceInput): Instance {
  const instance = createInstance(input)
  if (input.customPath) {
    const registry = readRegistry().filter(r => r.id !== instance.id)
    registry.push({ id: instance.id, path: input.customPath })
    writeRegistry(registry)
  } else {
    instance.folderName = uniqueFolderName(input.name)
  }
  return saveInstance(instance)
}

export function updateInstance(id: string, patch: Partial<Omit<Instance, 'id' | 'createdAt'>>): Instance {
  const existing = getInstanceById(id)
  if (!existing) throw new Error(`Instance not found: ${id}`)

  if (existing.customPath) {
    return saveInstance({ ...existing, ...patch })
  }

  const currentFolder = existing.folderName ?? id
  let newFolder = currentFolder
  if (patch.name && patch.name !== existing.name) {
    newFolder = uniqueFolderName(patch.name, currentFolder)
    if (newFolder !== currentFolder) {
      const oldDir = join(paths.instances, currentFolder)
      const newDir = join(paths.instances, newFolder)
      if (existsSync(oldDir)) renameSync(oldDir, newDir)
    }
  }
  return saveInstance({ ...existing, ...patch, folderName: newFolder })
}

// deleteFiles=false deregisters the instance without touching the filesystem —
// used by rollback paths that have already removed the directory themselves.
export function deleteInstance(id: string, deleteFiles = true): void {
  if (deleteFiles) {
    const dir = resolveInstanceDir(id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  writeRegistry(readRegistry().filter(r => r.id !== id))
}
