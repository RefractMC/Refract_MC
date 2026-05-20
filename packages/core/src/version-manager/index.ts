const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

export interface MinecraftVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releaseTime: string
  url: string
  sha1: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: MinecraftVersion[]
}

export interface VersionDownload {
  url: string
  sha1: string
  size: number
  path?: string
}

export interface LibraryRule {
  action: 'allow' | 'disallow'
  os?: { name?: string; version?: string; arch?: string }
  features?: Record<string, boolean>
}

export interface Library {
  name: string
  downloads?: {
    artifact?: VersionDownload & { path: string }
    classifiers?: Record<string, VersionDownload & { path: string }>
  }
  rules?: LibraryRule[]
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  url?: string
}

export interface VersionJson {
  id: string
  type: string
  mainClass: string
  assets: string
  assetIndex: {
    id: string
    url: string
    sha1: string
    size: number
    totalSize: number
  }
  downloads: {
    client: VersionDownload
    client_mappings?: VersionDownload
    server?: VersionDownload
  }
  libraries: Library[]
  arguments?: {
    game: Array<string | { rules: LibraryRule[]; value: string | string[] }>
    jvm: Array<string | { rules: LibraryRule[]; value: string | string[] }>
  }
  minecraftArguments?: string
  inheritsFrom?: string
  javaVersion?: { component: string; majorVersion: number }
}

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
}

export async function fetchVersionManifest(): Promise<VersionManifest> {
  const res = await fetch(MANIFEST_URL)
  if (!res.ok) throw new Error(`Failed to fetch version manifest: ${res.status}`)
  return res.json() as Promise<VersionManifest>
}

export async function fetchVersionList(): Promise<MinecraftVersion[]> {
  const manifest = await fetchVersionManifest()
  return manifest.versions
}

export async function fetchVersionJson(url: string): Promise<VersionJson> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch version JSON: ${res.status}`)
  return res.json() as Promise<VersionJson>
}

export function isLibraryAllowed(lib: Library, os: string): boolean {
  if (!lib.rules || lib.rules.length === 0) return true
  let allowed = false
  for (const rule of lib.rules) {
    const matchesOs = !rule.os?.name || rule.os.name === os
    if (matchesOs) {
      allowed = rule.action === 'allow'
    }
  }
  return allowed
}

export function mavenToPath(name: string): string {
  const [group, artifact, version] = name.split(':')
  const groupPath = group.replace(/\./g, '/')
  return `${groupPath}/${artifact}/${version}/${artifact}-${version}.jar`
}
