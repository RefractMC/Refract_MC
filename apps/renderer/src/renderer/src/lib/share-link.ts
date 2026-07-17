import type { CFProject, ModrinthProject, ModrinthProjectType } from '@refract/core'
import { getModrinthProject } from '@refract/core'
import { api } from '@/lib/api'

export type ShareProvider = 'modrinth' | 'curseforge'
export type ShareKind = ModrinthProjectType

export interface ShareReference {
  provider?: ShareProvider
  kind?: ShareKind
  key: string
}

export type ResolvedShareTarget =
  | { provider: 'modrinth'; kind: ModrinthProjectType; project: ModrinthProject }
  | { provider: 'curseforge'; kind: 'mod' | 'modpack'; project: CFProject }

const SAFE_KEY = /^[A-Za-z0-9_-]{1,96}$/
const OPEN_EVENT = 'refract:open-install-link'
const TARGET_EVENT = 'refract:resolved-install-link'
let pendingTarget: ResolvedShareTarget | null = null

function safeKey(value: string | null): string {
  const key = (value ?? '').trim()
  if (!SAFE_KEY.test(key)) throw new Error('Project slug or ID contains unsupported characters.')
  return key
}

function modrinthKind(value: string): ModrinthProjectType | undefined {
  return value === 'mod' || value === 'modpack' || value === 'resourcepack' || value === 'shader' || value === 'datapack'
    ? value
    : undefined
}

function curseForgeKind(value: string): 'mod' | 'modpack' | undefined {
  if (value === 'mc-mods' || value === 'mods' || value === 'mod') return 'mod'
  if (value === 'modpacks' || value === 'modpack') return 'modpack'
  return undefined
}

function parseWebUrl(url: URL): ShareReference {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'modrinth.com') {
    const kind = modrinthKind(parts[0] ?? '')
    if (!kind || !parts[1]) throw new Error('Use a Modrinth project page URL.')
    return { provider: 'modrinth', kind, key: safeKey(parts[1]) }
  }

  if (host === 'curseforge.com') {
    if (parts[0] !== 'minecraft') throw new Error('Only Minecraft CurseForge links are supported.')
    const kind = curseForgeKind(parts[1] ?? '')
    if (!kind || !parts[2]) throw new Error('Use a CurseForge mod or modpack page URL.')
    return { provider: 'curseforge', kind, key: safeKey(parts[2]) }
  }

  throw new Error('Only Modrinth and CurseForge project links are supported.')
}

function parseRefractUrl(url: URL): ShareReference {
  if (url.hostname !== 'install') throw new Error('This Refract link is not an install link.')

  const nestedUrl = url.searchParams.get('url')
  if (nestedUrl) {
    let parsed: URL
    try { parsed = new URL(nestedUrl) } catch { throw new Error('The embedded project URL is invalid.') }
    if (parsed.protocol !== 'https:') throw new Error('Embedded project URLs must use HTTPS.')
    return parseWebUrl(parsed)
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const providerValue = (url.searchParams.get('source') ?? url.searchParams.get('provider') ?? parts[0] ?? '').toLowerCase()
  const provider = providerValue === 'modrinth' || providerValue === 'curseforge' ? providerValue : undefined
  if (!provider) throw new Error('The Refract link has an unsupported project source.')

  const rawKind = (url.searchParams.get('type') ?? parts[1] ?? '').toLowerCase()
  const kind = provider === 'modrinth' ? modrinthKind(rawKind) : curseForgeKind(rawKind)
  if (!kind) throw new Error('The Refract link has an unsupported project type.')

  return {
    provider,
    kind,
    key: safeKey(url.searchParams.get('slug') ?? url.searchParams.get('id') ?? parts[2] ?? null),
  }
}

export function parseShareInput(raw: string): ShareReference {
  const input = raw.trim()
  if (!input) throw new Error('Paste a project URL, slug, or Refract install link.')

  if (SAFE_KEY.test(input)) return { key: input }

  let url: URL
  try { url = new URL(input) } catch { throw new Error('Enter a valid project URL or project slug.') }

  if (url.username || url.password || url.port) throw new Error('This URL format is not supported.')
  if (url.protocol === 'refract:') return parseRefractUrl(url)
  if (url.protocol !== 'https:') throw new Error('Project links must use HTTPS.')
  return parseWebUrl(url)
}

function normalizeModrinthProject(detail: Awaited<ReturnType<typeof getModrinthProject>>): ModrinthProject {
  return {
    project_id: detail.id,
    slug: detail.slug,
    title: detail.title,
    description: detail.description,
    categories: detail.categories,
    downloads: detail.downloads,
    follows: detail.followers,
    icon_url: detail.icon_url,
    versions: detail.versions,
    loaders: detail.loaders,
    game_versions: detail.game_versions,
    project_type: detail.project_type,
    date_created: detail.published,
    date_modified: detail.updated,
  }
}

async function resolveModrinth(reference: ShareReference): Promise<ResolvedShareTarget> {
  const detail = await getModrinthProject(reference.key)
  if (reference.kind && detail.project_type !== reference.kind) {
    throw new Error(`This project is a ${detail.project_type}, not a ${reference.kind}.`)
  }
  return { provider: 'modrinth', kind: detail.project_type, project: normalizeModrinthProject(detail) }
}

async function resolveCurseForge(reference: ShareReference): Promise<ResolvedShareTarget> {
  if (reference.kind !== 'mod' && reference.kind !== 'modpack') {
    throw new Error('CurseForge links must identify a mod or modpack.')
  }

  if (/^\d+$/.test(reference.key)) {
    const project = await api.curseforge.projectDetail(Number(reference.key))
    const expectedClassId = reference.kind === 'modpack' ? 4471 : 6
    if (project.classId !== expectedClassId) {
      throw new Error(`This CurseForge project is not a ${reference.kind}.`)
    }
    return { provider: 'curseforge', kind: reference.kind, project }
  }

  const result = reference.kind === 'modpack'
    ? await api.curseforge.searchModpacks(reference.key, undefined, 20, 0)
    : await api.curseforge.searchMods(reference.key, undefined, undefined, 20, 0)
  const project = result.data.find(item => item.slug.toLowerCase() === reference.key.toLowerCase())
  if (!project) throw new Error('CurseForge project not found. Check the slug and your API key.')
  return { provider: 'curseforge', kind: reference.kind, project }
}

export async function resolveShareInput(raw: string): Promise<ResolvedShareTarget> {
  const reference = parseShareInput(raw)
  if (reference.provider === 'curseforge') return resolveCurseForge(reference)
  if (reference.provider === 'modrinth') return resolveModrinth(reference)

  try {
    return await resolveModrinth(reference)
  } catch {
    for (const kind of ['modpack', 'mod'] as const) {
      try { return await resolveCurseForge({ ...reference, provider: 'curseforge', kind }) } catch { /* try the next source */ }
    }
    throw new Error('No Modrinth or CurseForge project matched that slug or ID.')
  }
}

export function createInstallDeepLink(target: ResolvedShareTarget): string {
  return `refract://install/${target.provider}/${target.kind}/${encodeURIComponent(target.project.slug)}`
}

export function openInstallFromLink(input = ''): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: input }))
}

export function onOpenInstallFromLink(listener: (input: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail ?? '')
  window.addEventListener(OPEN_EVENT, handler)
  return () => window.removeEventListener(OPEN_EVENT, handler)
}

export function routeForShareTarget(target: ResolvedShareTarget): '/browse' | '/modpacks' {
  return target.kind === 'mod' ? '/browse' : '/modpacks'
}

export function deliverShareTarget(target: ResolvedShareTarget): void {
  pendingTarget = target
  window.dispatchEvent(new CustomEvent<ResolvedShareTarget>(TARGET_EVENT, { detail: target }))
}

export function consumeShareTarget(route: '/browse' | '/modpacks'): ResolvedShareTarget | null {
  if (!pendingTarget || routeForShareTarget(pendingTarget) !== route) return null
  const target = pendingTarget
  pendingTarget = null
  return target
}

export function onShareTarget(listener: (target: ResolvedShareTarget) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ResolvedShareTarget>).detail)
  window.addEventListener(TARGET_EVENT, handler)
  return () => window.removeEventListener(TARGET_EVENT, handler)
}
