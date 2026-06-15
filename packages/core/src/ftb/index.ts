// FTB (Feed The Beast) modpacks via the public CreeperHost API (api.modpacks.ch).
// No API key required. Unlike Modrinth/CurseForge, an FTB version is not a single
// archive — it's a manifest of individual files plus build "targets" (the mod
// loader + Minecraft version), so installation downloads each file directly.

const BASE = 'https://api.modpacks.ch/public'
const UA = 'Refract/1.0 (github.com/ShevRuslan1)'

export interface FtbArt {
  id: number
  type: string // 'square' | 'splash' | 'logo' | …
  url: string
  width?: number
  height?: number
}

export interface FtbAuthor {
  id: number
  name: string
  type?: string
  website?: string
}

export interface FtbTag {
  id: number
  name: string
}

export interface FtbTarget {
  id: number
  name: string // 'forge' | 'fabric' | 'neoforge' | 'minecraft' | 'java' | …
  type: string // 'modloader' | 'game' | 'runtime'
  version: string
}

export interface FtbVersionSummary {
  id: number
  name: string
  type: string // 'release' | 'beta' | 'alpha' | 'hotfix'
  updated?: number
  targets?: FtbTarget[]
  specs?: { minimum?: number; recommended?: number }
}

export interface FtbModpack {
  id: number
  name: string
  synopsis?: string
  description?: string
  art: FtbArt[]
  authors: FtbAuthor[]
  tags: FtbTag[]
  versions: FtbVersionSummary[]
  installs?: number
  updated?: number
}

export interface FtbFile {
  id: number
  name: string
  path: string
  url: string
  mirrors?: string[]
  sha1?: string
  size?: number
  clientonly?: boolean
  serveronly?: boolean
  optional?: boolean
  type?: string
  // Mods are often served via CurseForge rather than the FTB CDN — when `url` is
  // empty, this points at the CurseForge project/file to download instead.
  curseforge?: { project: number; file: number }
}

export interface FtbVersion {
  id: number
  name: string
  files: FtbFile[]
  targets: FtbTarget[]
}

/** Pick the best icon URL for a modpack card (prefer the square artwork). */
export function ftbIconUrl(pack: Pick<FtbModpack, 'art'>): string | null {
  const art = pack.art ?? []
  const square = art.find(a => a.type === 'square')
  const logo = art.find(a => a.type === 'logo')
  return (square ?? logo ?? art[0])?.url ?? null
}

/** Resolve the Minecraft version and mod loader from a version's targets. */
export function ftbTargets(targets: FtbTarget[] | undefined): {
  minecraft?: string
  modLoader?: 'forge' | 'fabric' | 'neoforge' | 'quilt'
  modLoaderVersion?: string
} {
  const game = targets?.find(t => t.type === 'game' || t.name === 'minecraft')
  const loader = targets?.find(t => t.type === 'modloader')
  const name = loader?.name?.toLowerCase()
  const modLoader = name && ['forge', 'fabric', 'neoforge', 'quilt'].includes(name)
    ? (name as 'forge' | 'fabric' | 'neoforge' | 'quilt')
    : undefined
  return { minecraft: game?.version, modLoader, modLoaderVersion: loader?.version }
}

async function ftbJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`FTB API ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

/** A list endpoint returns just an array of pack ids. */
async function ftbIds(path: string): Promise<number[]> {
  const body = await ftbJson<{ packs?: number[]; status?: string; message?: string }>(path)
  if (body.status && body.status !== 'success') throw new Error(body.message ?? 'FTB request failed')
  return body.packs ?? []
}

export async function getFtbModpack(id: number): Promise<FtbModpack> {
  const pack = await ftbJson<FtbModpack>(`/modpack/${id}`)
  return { ...pack, id } // the detail body omits id; pin it from the request
}

export async function getFtbVersion(id: number, versionId: number): Promise<FtbVersion> {
  return ftbJson<FtbVersion>(`/modpack/${id}/${versionId}`)
}

/**
 * Search modpacks (or list popular ones when no query). The API returns ids only,
 * so we fetch each pack's detail concurrently and drop any that fail.
 */
export async function searchFtbModpacks(query: string | undefined, limit = 20): Promise<FtbModpack[]> {
  const ids = query?.trim()
    ? await ftbIds(`/modpack/search/${limit}?term=${encodeURIComponent(query.trim())}`)
    : await ftbIds(`/modpack/popular/installs/${limit}`)
  const settled = await Promise.allSettled(ids.slice(0, limit).map(getFtbModpack))
  return settled
    .filter((r): r is PromiseFulfilledResult<FtbModpack> => r.status === 'fulfilled')
    .map(r => r.value)
}
