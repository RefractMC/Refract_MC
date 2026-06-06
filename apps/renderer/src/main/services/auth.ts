import { safeStorage, shell } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { getConfig, saveConfig, type AppConfig } from './config'

const MS_DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
const MS_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const MS_SCOPE = 'XboxLive.signin offline_access'
const DEFAULT_MICROSOFT_CLIENT_ID = '2ca3a07c-2fa0-433d-820a-e2f752f44415'

export interface SafeAccount {
  uuid: string
  username: string
  type: 'microsoft' | 'offline' | 'yggdrasil'
  expiresAt?: number
  yggdrasilServer?: string
  canManageContent: boolean
  canPlayMinecraft: boolean
  licenseStatus: 'verified' | 'guest'
}

export interface MicrosoftDeviceLogin {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
  message: string
}

interface MicrosoftTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

interface MinecraftProfile {
  id: string
  name: string
}

function getMicrosoftClientId(): string {
  const id = process.env.REFRACT_MICROSOFT_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID ?? DEFAULT_MICROSOFT_CLIENT_ID
  if (!id) {
    throw new Error(
      'Missing Microsoft OAuth client id. Set REFRACT_MICROSOFT_CLIENT_ID to an Azure public client app id.'
    )
  }
  return id
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : null
    const message = typeof json.error_description === 'string'
      ? json.error_description
      : typeof json.error === 'string'
        ? json.error
        : `Request failed: ${response.status}`
    throw new Error(code ? `${code}: ${message}` : message)
  }

  return json as T
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof json.errorMessage === 'string'
      ? json.errorMessage
      : typeof json.message === 'string'
        ? json.message
        : typeof json.error === 'string'
          ? json.error
          : `Request failed: ${response.status}`
    throw new Error(message)
  }

  return json as T
}

function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] safeStorage unavailable — token persisted without OS encryption')
    return 'b64:' + Buffer.from(value, 'utf8').toString('base64')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(raw: string): string {
  if (raw.startsWith('b64:')) return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  throw new Error('Cannot decrypt token: safeStorage unavailable')
}

export async function getOrRefreshMinecraftToken(accountUuid: string): Promise<{ token: string; xuid: string; clientId: string }> {
  const config = getConfig()
  const account = config.accounts.find(a => a.uuid === accountUuid)
  if (!account) throw new Error('Account not found')
  const clientId = getMicrosoftClientId()

  if (account.type === 'yggdrasil') {
    const isExpired = !account.expiresAt || Date.now() > account.expiresAt - 5 * 60 * 1000
    if (!isExpired && account.encryptedAccessToken) {
      try { return { token: decrypt(account.encryptedAccessToken), xuid: '', clientId: '' } } catch { /* fall through */ }
    }
    if (account.encryptedAccessToken && account.encryptedRefreshToken && account.yggdrasilServer) {
      try {
        const refreshed = await yggdrasilPost<{ accessToken: string; clientToken: string }>(
          account.yggdrasilServer, 'refresh',
          { accessToken: decrypt(account.encryptedAccessToken), clientToken: decrypt(account.encryptedRefreshToken) }
        )
        account.encryptedAccessToken = encrypt(refreshed.accessToken)
        account.encryptedRefreshToken = encrypt(refreshed.clientToken)
        account.expiresAt = Date.now() + 24 * 60 * 60 * 1000
        saveConfig(config)
        return { token: refreshed.accessToken, xuid: '', clientId: '' }
      } catch { /* fall through */ }
    }
    throw new Error('Yggdrasil session expired. Please sign in again via Accounts.')
  }

  if (account.type !== 'microsoft') {
    return { token: 'offline', xuid: '', clientId: '' }
  }

  const isExpired = !account.expiresAt || Date.now() > account.expiresAt - 5 * 60 * 1000

  if (!isExpired && account.encryptedAccessToken) {
    try {
      return { token: decrypt(account.encryptedAccessToken), xuid: account.xuid ?? '', clientId }
    } catch { /* fall through to refresh */ }
  }

  if (!account.encryptedRefreshToken) {
    if (!isExpired && account.encryptedAccessToken) {
      try { return { token: decrypt(account.encryptedAccessToken), xuid: account.xuid ?? '', clientId } } catch { /* fall through */ }
    }
    throw new Error('Minecraft session expired. Please sign in again via Accounts.')
  }

  const refreshToken = decrypt(account.encryptedRefreshToken)

  const msToken = await postForm<MicrosoftTokenResponse>(MS_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MS_SCOPE,
  })

  const xbl = await postJson<{ Token: string; DisplayClaims: { xui: Array<{ uhs: string; xid?: string }> } }>(XBL_AUTH_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken.access_token}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })
  const userHash = xbl.DisplayClaims.xui[0]?.uhs
  const xuid = xbl.DisplayClaims.xui[0]?.xid ?? account.xuid ?? ''
  if (!userHash) throw new Error('Xbox Live did not return a user hash during token refresh.')

  const xsts = await postJson<{ Token: string }>(XSTS_AUTH_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })

  const mcToken = await postJson<{ access_token: string; expires_in: number }>(MC_AUTH_URL, {
    identityToken: `XBL3.0 x=${userHash};${xsts.Token}`,
  })

  account.xuid = xuid
  account.encryptedAccessToken = encrypt(mcToken.access_token)
  if (msToken.refresh_token) account.encryptedRefreshToken = encrypt(msToken.refresh_token)
  account.expiresAt = Date.now() + mcToken.expires_in * 1000
  saveConfig(config)

  return { token: mcToken.access_token, xuid, clientId }
}

function toSafeAccount(account: AppConfig['accounts'][number]): SafeAccount {
  const { encryptedAccessToken: _access, encryptedRefreshToken: _refresh, ...safe } = account
  const authenticated = account.type === 'microsoft' || account.type === 'yggdrasil'
  return {
    ...safe,
    canManageContent: true,
    canPlayMinecraft: true,          // offline accounts can play on offline-mode servers
    licenseStatus: authenticated ? 'verified' : 'guest',
  }
}

export function listSafeAccounts(): SafeAccount[] {
  return getConfig().accounts.map(toSafeAccount)
}

export function getActiveAccount(): SafeAccount | null {
  const config = getConfig()
  const account = config.accounts.find((candidate) => candidate.uuid === config.activeAccountId)
  return account ? toSafeAccount(account) : null
}

export async function beginMicrosoftLogin(): Promise<MicrosoftDeviceLogin> {
  const clientId = getMicrosoftClientId()
  const device = await postForm<{
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval?: number
    message?: string
  }>(MS_DEVICE_CODE_URL, {
    client_id: clientId,
    scope: MS_SCOPE,
  })

  await shell.openExternal(device.verification_uri)

  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresIn: device.expires_in,
    interval: device.interval ?? 5,
    message: device.message ?? `Go to ${device.verification_uri} and enter ${device.user_code}.`,
  }
}

export async function completeMicrosoftLogin(deviceCode: string): Promise<SafeAccount> {
  const clientId = getMicrosoftClientId()
  const msToken = await postForm<MicrosoftTokenResponse>(MS_TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  })

  const xbl = await postJson<{
    Token: string
    DisplayClaims: { xui: Array<{ uhs: string }> }
  }>(XBL_AUTH_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msToken.access_token}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })

  const userHash = xbl.DisplayClaims.xui[0]?.uhs
  const xuid = xbl.DisplayClaims.xui[0]?.xid ?? ''
  if (!userHash) throw new Error('Xbox Live response did not include a user hash.')

  const xsts = await postJson<{ Token: string }>(XSTS_AUTH_URL, {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xbl.Token],
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })

  const mcToken = await postJson<{ access_token: string; expires_in: number }>(MC_AUTH_URL, {
    identityToken: `XBL3.0 x=${userHash};${xsts.Token}`,
  })

  const profileResponse = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcToken.access_token}` },
  })
  if (!profileResponse.ok) {
    throw new Error('This Microsoft account does not appear to own Minecraft: Java Edition.')
  }
  const profile = (await profileResponse.json()) as MinecraftProfile

  const config = getConfig()
  const account: AppConfig['accounts'][number] = {
    uuid: profile.id,
    username: profile.name,
    type: 'microsoft',
    xuid,
    expiresAt: Date.now() + mcToken.expires_in * 1000,
    encryptedAccessToken: encrypt(mcToken.access_token),
    encryptedRefreshToken: msToken.refresh_token ? encrypt(msToken.refresh_token) : undefined,
  }

  config.accounts = [account, ...config.accounts.filter((existing) => existing.uuid !== account.uuid)]
  config.activeAccountId = account.uuid
  saveConfig(config)

  return toSafeAccount(account)
}

export function createOfflineAccount(username: string): SafeAccount {
  const trimmed = username.trim()
  if (!trimmed) throw new Error('Username is required.')

  const config = getConfig()
  const account: AppConfig['accounts'][number] = {
    uuid: randomUUID(),
    username: trimmed,
    type: 'offline',
  }

  config.accounts = [account, ...config.accounts]
  config.activeAccountId = account.uuid
  saveConfig(config)

  return toSafeAccount(account)
}

export function setActiveAccount(uuid: string): SafeAccount {
  const config = getConfig()
  const account = config.accounts.find((candidate) => candidate.uuid === uuid)
  if (!account) throw new Error(`Account not found: ${uuid}`)
  config.activeAccountId = uuid
  saveConfig(config)
  return toSafeAccount(account)
}

export function renameOfflineAccount(uuid: string, newUsername: string): SafeAccount {
  const trimmed = newUsername.trim()
  if (!trimmed) throw new Error('Username is required.')
  const config = getConfig()
  const account = config.accounts.find((a) => a.uuid === uuid)
  if (!account) throw new Error(`Account not found: ${uuid}`)
  if (account.type !== 'offline') throw new Error('Only offline accounts can be renamed.')
  account.username = trimmed
  saveConfig(config)
  return toSafeAccount(account)
}

export function logoutAccount(uuid: string): void {
  const config = getConfig()
  config.accounts = config.accounts.filter((account) => account.uuid !== uuid)
  if (config.activeAccountId === uuid) {
    config.activeAccountId = config.accounts[0]?.uuid ?? null
  }
  saveConfig(config)
}

// Ely.by uses /auth/* instead of the standard Yggdrasil /authserver/* paths.
// Try both; retry on any "not found"-like response, throw immediately on real auth errors.
async function yggdrasilPost<T>(base: string, action: 'authenticate' | 'refresh', body: object): Promise<T> {
  const paths = [`/authserver/${action}`, `/auth/${action}`]
  let lastErr: Error = new Error('Authentication endpoint not found. Check the server URL.')
  for (const path of paths) {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      let msg = r.statusText
      try { const j = await r.json() as { errorMessage?: string }; msg = j.errorMessage ?? msg } catch { /* ignore */ }
      lastErr = new Error(msg)
      const lc = msg.toLowerCase()
      // Retry on endpoint-not-found responses (404 status or "not found" message body)
      if (r.status === 404 || lc.includes('not found') || lc.includes('page not found')) continue
      throw lastErr  // Real auth error — wrong credentials, etc.
    }
    return await r.json() as T
  }
  throw lastErr
}

export async function loginYggdrasil(serverUrl: string, username: string, password: string): Promise<SafeAccount> {
  const base = serverUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('Auth server URL is required.')

  const clientToken = randomUUID()
  const res = await yggdrasilPost<{
    accessToken: string
    clientToken: string
    selectedProfile?: { id: string; name: string }
  }>(base, 'authenticate', {
    agent: { name: 'Minecraft', version: 1 },
    username,
    password,
    clientToken,
    requestUser: true,
  })

  if (!res.selectedProfile) {
    throw new Error('This account has no Minecraft profile on this auth server.')
  }

  const config = getConfig()
  const account: AppConfig['accounts'][number] = {
    uuid: res.selectedProfile.id,
    username: res.selectedProfile.name,
    type: 'yggdrasil',
    yggdrasilServer: base,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    encryptedAccessToken: encrypt(res.accessToken),
    encryptedRefreshToken: encrypt(res.clientToken),
  }

  config.accounts = [account, ...config.accounts.filter(a => a.uuid !== account.uuid)]
  config.activeAccountId = account.uuid
  saveConfig(config)

  return toSafeAccount(account)
}


export interface CapeInfo {
  id: string
  state: 'ACTIVE' | 'INACTIVE'
  url: string
  alias: string
  dataUrl?: string
  isRender?: boolean
}

const WIKI_CAPE_FILES: Record<string, string> = {
  'migrator': 'Migrator_Cape.png',
  'vanilla': 'Vanilla_Cape.png',
  'pan': 'The_Pan_Cape.png',
  'common': 'Common_Cape_BE.png',
  'mojang': 'Mojang_Cape.png',
  'mojangstudios': 'Mojang_Studios_Cape.png', 'mojang studios': 'Mojang_Studios_Cape.png',
  'prismarine': 'Prismarine_Cape.png', 'prismarine cape': 'Prismarine_Cape.png',
  'cherryblossom': 'Cherry_Blossom_Cape_JE.png', 'cherry blossom': 'Cherry_Blossom_Cape_JE.png',
  'minecon2011': 'MINECON_2011_Cape.png', 'minecon 2011': 'MINECON_2011_Cape.png',
  'minecon2012': 'MINECON_2012_Cape.png', 'minecon 2012': 'MINECON_2012_Cape.png',
  'minecon2013': 'MINECON_2013_Cape.png', 'minecon 2013': 'MINECON_2013_Cape.png',
  'minecon2015': 'MINECON_2015_Cape.png', 'minecon 2015': 'MINECON_2015_Cape.png',
  'minecon2016': 'MINECON_2016_Cape.png', 'minecon 2016': 'MINECON_2016_Cape.png',
  'follower': "Follower's_Cape_JE.png", "follower's cape": "Follower's_Cape_JE.png",
  'purpleheart': 'Purple_Heart_Cape_JE.png', 'purple heart': 'Purple_Heart_Cape_JE.png',
  '15thanniversary': '15th_Anniversary_Cape_JE.png', '15th anniversary': '15th_Anniversary_Cape_JE.png',
  'mcc15thyear': 'MCC_15th_Year_Cape_JE.png', 'mcc 15th year': 'MCC_15th_Year_Cape_JE.png',
  'cobalt': 'Cobalt_Cape_render.png',
  'turtle': 'Turtle_Cape.png',
  'valentine': 'Valentine_Cape.png',
  'millionthcustomer': 'Millionth_Customer_Cape.png', 'millionth customer': 'Millionth_Customer_Cape.png',
  'mojiramoderator': 'Moderator_Cape.png', 'mojira moderator': 'Moderator_Cape.png',
  'realsmapmaker': 'Realms_MapMaker_Cape.png', 'realms mapmaker': 'Realms_MapMaker_Cape.png',
  'birthday': 'Birthday_Cape.png',
  'translator': 'Translator_Cape.png',
  'chinesetranslator': 'Translator_Cape.png', 'chinese translator': 'Translator_Cape.png',
  'scrollschampion': 'Scrolls_Champion_Cape.png', 'scrolls champion': 'Scrolls_Champion_Cape.png',
  'progresspride': 'Progress_Pride_Cape_rv3.png', 'progress pride': 'Progress_Pride_Cape_rv3.png',
  'founder': "Founder's_Cape.png",
  'copper': 'Copper_Cape_JE.png',
  'mojangoffice': 'Mojang_Office_Cape_JE.png', 'mojang office': 'Mojang_Office_Cape_JE.png',
  'home': 'Home_Cape_JE.png',
  'menace': 'Menace_Cape_JE.png',
  'builder': 'Builder_Cape_JE.png',
  'crafter': 'Crafter_Cape_JE.png',
  'minecraftexperience': 'Minecraft_Experience_Cape_JE.png', 'minecraft experience': 'Minecraft_Experience_Cape_JE.png',
  'moonlighttrail': 'Moonlight_Trail_Cape_JE.png', 'moonlight trail': 'Moonlight_Trail_Cape_JE.png',
  'zombiehorse': 'Zombie_Horse_Cape_JE.png', 'zombie horse': 'Zombie_Horse_Cape_JE.png',
}

function wikiImageUrl(alias: string): string | null {
  const lower = alias.toLowerCase()
  const file = WIKI_CAPE_FILES[lower] ?? WIKI_CAPE_FILES[lower.replace(/\s+/g, '')]
  if (!file) return null
  return `https://minecraft.wiki/w/Special:Redirect/file/${encodeURIComponent(file)}`
}

export async function fetchAccountCapes(uuid: string): Promise<CapeInfo[]> {
  const tokenData = await getOrRefreshMinecraftToken(uuid)
  if (tokenData.token === 'offline') return []
  const res = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${tokenData.token}` },
  })
  if (!res.ok) return []
  const profile = await res.json() as { capes?: Omit<CapeInfo, 'dataUrl'>[] }
  const rawCapes = profile.capes ?? []
  return Promise.all(rawCapes.map(async (cape) => {
    const wikiUrl = wikiImageUrl(cape.alias)
    const imageUrl = wikiUrl ?? cape.url
    try {
      const texRes = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      })
      if (texRes.ok) {
        const buf = await texRes.arrayBuffer()
        const mime = (texRes.headers.get('content-type') ?? 'image/png').split(';')[0].trim()
        const dataUrl = `data:${mime};base64,` + Buffer.from(buf).toString('base64')
        return { ...cape, dataUrl, isRender: !!wikiUrl }
      }
    } catch { /* ignore */ }
    return { ...cape }
  }))
}

export async function setActiveCape(uuid: string, capeId: string | null): Promise<void> {
  const tokenData = await getOrRefreshMinecraftToken(uuid)
  if (tokenData.token === 'offline') throw new Error('Offline accounts cannot manage capes')
  const url = 'https://api.minecraftservices.com/minecraft/profile/capes/active'
  if (capeId === null) {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenData.token}` },
    })
    if (!res.ok && res.status !== 204) {
      let msg = res.statusText
      try { const j = await res.json() as { error?: string }; msg = j.error ?? msg } catch { /* ignore */ }
      throw new Error(`Failed to hide cape: ${msg}`)
    }
    return
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenData.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capeId }),
  })
  if (!res.ok) {
    let msg = res.statusText
    try { const j = await res.json() as { error?: string; errorMessage?: string }; msg = j.errorMessage ?? j.error ?? msg } catch { /* ignore */ }
    throw new Error(`Failed to set cape: ${msg}`)
  }
}

export async function uploadSkin(uuid: string, imagePath: string, variant: 'classic' | 'slim'): Promise<void> {
  const config = getConfig()
  const account = config.accounts.find(a => a.uuid === uuid)
  if (!account) throw new Error('Account not found')

  if (account.type === 'microsoft') {
    const tokenData = await getOrRefreshMinecraftToken(uuid)
    const imageBytes = readFileSync(imagePath)
    const blob = new Blob([imageBytes], { type: 'image/png' })
    const form = new FormData()
    form.append('variant', variant)
    form.append('file', blob, 'skin.png')
    const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenData.token}` },
      body: form,
    })
    if (!res.ok) {
      let msg = res.statusText
      try { const j = await res.json() as { error?: string; errorMessage?: string }; msg = j.errorMessage ?? j.error ?? msg } catch { /* ignore */ }
      throw new Error(`Skin upload failed: ${msg}`)
    }
    return
  }

  if (account.type === 'yggdrasil' && account.yggdrasilServer) {
    shell.openExternal(account.yggdrasilServer.replace('authserver.', '').replace(/\/auth.*$/, '').replace(/\/+$/, '') + '/skins')
    return
  }

  // Offline — caller should handle saving as local avatar
  throw new Error('OFFLINE_ONLY')
}
