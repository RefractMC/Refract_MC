import type { Instance, ModrinthVersion, ResolvedDep } from '@refract/core'
import { api } from './api'

export const E4MC_PROJECT_ID = 'qANg5Jrr'
const SUPPORTED_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt'])
const SAFE_LINK_ID = /^[A-Za-z0-9_-]{1,96}$/
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,32}$/
const E4MC_HOST = /^(?:[a-z0-9-]+\.)+e4mc\.link(?::\d{1,5})?$/i

const WORLD_INVITE_TTL_MS = 6 * 60 * 60_000
export type SocialInviteKind = 'world' | 'server'

export interface SocialInvite {
  kind: SocialInviteKind
  address: string
  name: string
  minecraftVersion?: string
  linkId: string
  createdAt: number
  expiresAt?: number
}

function normalizeAddress(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value || value.length > 255 || !/^[a-z0-9._:[\]-]+$/i.test(value)) {
    throw new Error('The invite contains an invalid Minecraft server address.')
  }
  const port = value.match(/:([0-9]+)$/)?.[1]
  if (port && (Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('The invite contains an invalid Minecraft server port.')
  }
  return value
}

function normalizeName(raw: string | null): string {
  const value = (raw ?? '').trim()
  if (!value || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('The invite contains an invalid server name.')
  }
  return value
}

function normalizeVersion(raw: string | null): string | undefined {
  const value = (raw ?? '').trim()
  if (!value) return undefined
  if (!SAFE_VERSION.test(value))
    throw new Error('The invite contains an invalid Minecraft version.')
  return value
}

export function createSocialInvite(input: {
  kind: SocialInviteKind
  address: string
  name: string
  minecraftVersion?: string
  linkId?: string
  createdAt?: number
}): SocialInvite {
  const createdAt = input.createdAt ?? Date.now()
  const address = normalizeAddress(input.address)
  if (input.kind === 'world' && !E4MC_HOST.test(address)) {
    throw new Error('World invites must use an e4mc.link address.')
  }
  const linkId = input.linkId ?? crypto.randomUUID()
  if (!SAFE_LINK_ID.test(linkId)) throw new Error('The invite contains an invalid link ID.')
  return {
    kind: input.kind,
    address,
    name: normalizeName(input.name),
    minecraftVersion: normalizeVersion(input.minecraftVersion ?? null),
    linkId,
    createdAt,
    expiresAt: input.kind === 'world' ? createdAt + WORLD_INVITE_TTL_MS : undefined,
  }
}

export function createSocialInviteLink(invite: SocialInvite): string {
  const url = new URL('refract://join/server')
  url.searchParams.set('kind', invite.kind)
  url.searchParams.set('address', invite.address)
  url.searchParams.set('name', invite.name)
  url.searchParams.set('linkId', invite.linkId)
  url.searchParams.set('createdAt', String(invite.createdAt))
  if (invite.minecraftVersion) url.searchParams.set('version', invite.minecraftVersion)
  if (invite.expiresAt) url.searchParams.set('expiresAt', String(invite.expiresAt))
  return url.toString()
}

export function parseSocialInviteLink(raw: string): SocialInvite {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('This is not a valid Refract invite link.')
  }
  if (url.protocol !== 'refract:' || url.hostname !== 'join' || url.pathname !== '/server') {
    throw new Error('This is not a Refract server invite link.')
  }
  const kind = url.searchParams.get('kind')
  if (kind !== 'world' && kind !== 'server') throw new Error('The invite type is not supported.')
  const createdAt = Number(url.searchParams.get('createdAt'))
  const expiresAtRaw = url.searchParams.get('expiresAt')
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : undefined
  const now = Date.now()
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    createdAt > now + 5 * 60_000 ||
    (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
  ) {
    throw new Error('The invite timestamps are invalid.')
  }
  if (
    kind === 'world' &&
    (expiresAt === undefined || expiresAt !== createdAt + WORLD_INVITE_TTL_MS)
  ) {
    throw new Error('This world invite does not have a valid expiration.')
  }
  if (expiresAt !== undefined && expiresAt <= now) throw new Error('This world invite has expired.')
  const invite = createSocialInvite({
    kind,
    address: url.searchParams.get('address') ?? '',
    name: url.searchParams.get('name') ?? '',
    minecraftVersion: url.searchParams.get('version') ?? undefined,
    linkId: url.searchParams.get('linkId') ?? '',
    createdAt,
  })
  return { ...invite, expiresAt }
}

export function findE4mcAddress(line: string): string | null {
  const match = line.match(/(?:[a-z0-9-]+\.)+e4mc\.link(?::\d{1,5})?/i)
  if (!match) return null
  try {
    const address = normalizeAddress(match[0])
    return E4MC_HOST.test(address) ? address : null
  } catch {
    return null
  }
}

async function installRequiredDependencies(
  instanceId: string,
  version: ModrinthVersion
): Promise<void> {
  const dependencies = await api.mods
    .planDeps({ source: 'modrinth', instanceId, version })
    .catch(() => [])
  for (const dependency of dependencies as ResolvedDep[]) {
    if (dependency.type !== 'required' || dependency.alreadyInstalled || !dependency.projectId)
      continue
    await api.modrinth.install(
      instanceId,
      dependency.projectId,
      dependency.name,
      dependency.versionId
    )
  }
}

export async function prepareE4mc(instance: Instance): Promise<ModrinthVersion> {
  const loader = instance.modLoader?.toLowerCase()
  if (!loader || !SUPPORTED_LOADERS.has(loader)) {
    throw new Error('Hosting a world requires a Fabric, Forge, NeoForge, or Quilt instance.')
  }
  const versions = await api.modrinth.versions(E4MC_PROJECT_ID, instance.minecraftVersion, loader)
  const version = versions[0]
  if (!version) {
    throw new Error(
      `e4mc is not available for Minecraft ${instance.minecraftVersion} with ${loader}.`
    )
  }

  const tracked = instance.mods?.find((mod) => mod.projectId === E4MC_PROJECT_ID)
  const files = await api.mods.list(instance.id)
  const installed = tracked?.fileName
    ? files.find(
        (file) =>
          file.filename === tracked.fileName || file.filename === `${tracked.fileName}.disabled`
      )
    : undefined
  if (tracked?.versionId === version.id && installed) {
    if (!installed.enabled) await api.mods.toggle(instance.id, installed.filename, 'mod')
    return version
  }

  await installRequiredDependencies(instance.id, version)
  await api.modrinth.install(instance.id, E4MC_PROJECT_ID, 'e4mc', version.id)
  return version
}

export interface SocialJoinTarget {
  instanceId: string
  invite: SocialInvite
}

const JOIN_EVENT = 'refract:social-join'
let pendingJoin: SocialJoinTarget | null = null

export function deliverSocialJoin(target: SocialJoinTarget): void {
  pendingJoin = target
  window.dispatchEvent(new CustomEvent<SocialJoinTarget>(JOIN_EVENT, { detail: target }))
}

export function consumeSocialJoin(): SocialJoinTarget | null {
  const target = pendingJoin
  pendingJoin = null
  return target
}

export function onSocialJoin(listener: (target: SocialJoinTarget) => void): () => void {
  const handler = (event: Event) => {
    pendingJoin = null
    listener((event as CustomEvent<SocialJoinTarget>).detail)
  }
  window.addEventListener(JOIN_EVENT, handler)
  return () => window.removeEventListener(JOIN_EVENT, handler)
}
