const BASE = 'https://api.modrinth.com/v2'

export type ModrinthProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack'
export type ModrinthSortIndex = 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'

export interface ModrinthProject {
  project_id: string
  slug: string
  title: string
  description: string
  categories: string[]
  downloads: number
  follows?: number
  icon_url: string | null
  latest_version?: string
  versions?: string[]
  loaders?: string[]
  game_versions?: string[]
  project_type?: ModrinthProjectType
  date_created?: string
  date_modified?: string
}

export interface ModrinthProjectDetail {
  id: string
  slug: string
  title: string
  description: string
  categories: string[]
  downloads: number
  followers: number
  icon_url: string | null
  versions: string[]
  loaders: string[]
  game_versions: string[]
  project_type: ModrinthProjectType
  published: string
  updated: string
}

export interface ModrinthSearchOptions {
  query?: string
  projectType?: ModrinthProjectType
  gameVersion?: string
  loader?: string
  category?: string
  sortIndex?: ModrinthSortIndex
  limit?: number
  offset?: number
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
  changelog?: string | null
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

export async function searchContent(opts: ModrinthSearchOptions): Promise<ModrinthSearchResult> {
  const { query = '', projectType = 'modpack', gameVersion, loader, category, sortIndex = 'downloads', limit = 20, offset = 0 } = opts
  const facets: string[][] = [[`project_type:${projectType}`]]
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  if (loader) facets.push([`categories:${loader}`])
  if (category) facets.push([`categories:${category}`])

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(limit),
    offset: String(offset),
    index: sortIndex,
  })

  const res = await fetch(`${BASE}/search?${params}`)
  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`)
  return res.json() as Promise<ModrinthSearchResult>
}

/** Resolve a Modrinth project by either its public slug or project ID. */
export async function getModrinthProject(projectIdOrSlug: string): Promise<ModrinthProjectDetail> {
  const res = await fetch(`${BASE}/project/${encodeURIComponent(projectIdOrSlug)}`)
  if (!res.ok) throw new Error(`Modrinth project not found: ${res.status}`)
  return res.json() as Promise<ModrinthProjectDetail>
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
