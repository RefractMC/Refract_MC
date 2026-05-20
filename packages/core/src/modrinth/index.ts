const BASE = 'https://api.modrinth.com/v2'

export interface ModrinthProject {
  project_id: string
  slug: string
  title: string
  description: string
  categories: string[]
  downloads: number
  icon_url: string | null
  latest_version?: string
  versions?: string[]
  loaders?: string[]
  game_versions?: string[]
}

export interface ModrinthSearchResult {
  hits: ModrinthProject[]
  total_hits: number
  offset: number
  limit: number
}

export interface ModrinthFile {
  hashes: { sha512: string; sha1: string }
  url: string
  filename: string
  primary: boolean
  size: number
  file_type: string | null
}

export interface ModrinthVersion {
  id: string
  project_id: string
  version_number: string
  name: string
  game_versions: string[]
  loaders: string[]
  files: ModrinthFile[]
  dependencies: Array<{
    version_id: string | null
    project_id: string | null
    dependency_type: 'required' | 'optional' | 'incompatible'
  }>
  date_published: string
  downloads: number
}

export async function searchMods(
  query: string,
  gameVersion?: string,
  loader?: string,
  category?: string,
  limit = 20,
  offset = 0
): Promise<ModrinthSearchResult> {
  const facets: string[][] = [['project_type:mod']]
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  if (loader) facets.push([`categories:${loader}`])
  if (category) facets.push([`categories:${category}`])

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(limit),
    offset: String(offset),
    index: 'relevance',
  })

  const res = await fetch(`${BASE}/search?${params}`)
  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`)
  return res.json() as Promise<ModrinthSearchResult>
}

export async function getProjectVersions(
  projectId: string,
  gameVersion?: string,
  loader?: string
): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams()
  if (gameVersion) params.append('game_versions', JSON.stringify([gameVersion]))
  if (loader) params.append('loaders', JSON.stringify([loader]))

  const res = await fetch(`${BASE}/project/${projectId}/version?${params}`)
  if (!res.ok) throw new Error(`Failed to get versions for ${projectId}: ${res.status}`)
  return res.json() as Promise<ModrinthVersion[]>
}

export function getPrimaryFile(version: ModrinthVersion): ModrinthFile | null {
  return version.files.find(f => f.primary) ?? version.files[0] ?? null
}

export interface ModrinthGameVersion {
  version: string
  version_type: 'release' | 'snapshot' | 'alpha' | 'beta'
  date: string
  major: boolean
}

export async function fetchGameVersions(): Promise<ModrinthGameVersion[]> {
  const res = await fetch(`${BASE}/tag/game_version`)
  if (!res.ok) throw new Error(`Failed to fetch game versions: ${res.status}`)
  const all = await res.json() as ModrinthGameVersion[]
  return all.filter(v => v.version_type === 'release')
}
