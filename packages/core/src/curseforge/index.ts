const BASE = 'https://api.curseforge.com/v1'

export const CF_GAME_ID = 432

export const CF_CLASS = {
  mods:         6,
  modpacks:     4471,
  resourcePacks: 12,
} as const

export const CF_LOADER = {
  any:      0,
  forge:    1,
  fabric:   4,
  quilt:    5,
  neoforge: 6,
} as const

export const CF_SORT = {
  featured:      1,
  popularity:    2,
  lastUpdated:   3,
  name:          4,
  totalDownloads: 6,
} as const

export interface CFAuthor    { id: number; name: string }
export interface CFCategory  { id: number; name: string; slug: string }
export interface CFLogo      { thumbnailUrl: string; url: string }

export interface CFFileIndex {
  gameVersion:       string
  fileId:            number
  filename:          string
  releaseType:       number
  modLoader:         number | null
}

export interface CFProject {
  id:                  number
  classId:             number
  name:                string
  slug:                string
  summary:             string
  downloadCount:       number
  logo:                CFLogo | null
  authors:             CFAuthor[]
  categories:          CFCategory[]
  links:               { websiteUrl?: string; issuesUrl?: string; sourceUrl?: string; wikiUrl?: string }
  latestFilesIndexes:  CFFileIndex[]
  dateCreated:         string
  dateModified:        string
}

export interface CFFile {
  id:            number
  modId:         number
  displayName:   string
  fileName:      string
  fileDate:      string
  fileLength:    number
  downloadCount: number
  downloadUrl:   string | null
  gameVersions:  string[]
  releaseType:   number
}

export interface CFSearchResult {
  data:       CFProject[]
  pagination: { index: number; pageSize: number; resultCount: number; totalCount: number }
}

export interface CFSearchOptions {
  apiKey:          string
  classId:         number
  query?:          string
  gameVersion?:    string
  modLoaderType?:  number
  sortField?:      number
  sortOrder?:      'asc' | 'desc'
  pageSize?:       number
  index?:          number
}

function headers(apiKey: string) {
  return { 'x-api-key': apiKey, Accept: 'application/json' }
}

export async function searchCurseForge(opts: CFSearchOptions): Promise<CFSearchResult> {
  const params = new URLSearchParams({
    gameId:    String(CF_GAME_ID),
    classId:   String(opts.classId),
    pageSize:  String(opts.pageSize ?? 20),
    index:     String(opts.index ?? 0),
    sortField: String(opts.sortField ?? CF_SORT.popularity),
    sortOrder: opts.sortOrder ?? 'desc',
  })
  if (opts.query)          params.set('searchFilter',   opts.query)
  if (opts.gameVersion)    params.set('gameVersion',    opts.gameVersion)
  if (opts.modLoaderType != null) params.set('modLoaderType', String(opts.modLoaderType))

  const res = await fetch(`${BASE}/mods/search?${params}`, { headers: headers(opts.apiKey) })
  if (!res.ok) throw new Error(`CurseForge search failed: ${res.status}`)
  return res.json() as Promise<CFSearchResult>
}

export async function getCurseForgeFiles(
  modId: number,
  apiKey: string,
  gameVersion?: string,
  modLoaderType?: number,
): Promise<CFFile[]> {
  const params = new URLSearchParams({ pageSize: '50' })
  if (gameVersion)              params.set('gameVersion',    gameVersion)
  if (modLoaderType != null)    params.set('modLoaderType', String(modLoaderType))

  const res = await fetch(`${BASE}/mods/${modId}/files?${params}`, { headers: headers(apiKey) })
  if (!res.ok) throw new Error(`CurseForge files failed: ${res.status}`)
  const body = await res.json() as { data: CFFile[] }
  return body.data
}

export async function getCurseForgeDownloadUrl(modId: number, fileId: number, apiKey: string): Promise<string> {
  const res = await fetch(`${BASE}/mods/${modId}/files/${fileId}/download-url`, { headers: headers(apiKey) })
  if (!res.ok) throw new Error(`CurseForge download-url failed: ${res.status}`)
  const body = await res.json() as { data: string }
  return body.data
}
