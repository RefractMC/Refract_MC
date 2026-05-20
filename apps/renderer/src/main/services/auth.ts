import { safeStorage, shell } from 'electron'
import { randomUUID } from 'crypto'
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
    return Buffer.from(value, 'utf8').toString('base64')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function toSafeAccount(account: AppConfig['accounts'][number]): SafeAccount {
  const { encryptedAccessToken: _access, encryptedRefreshToken: _refresh, ...safe } = account
  return {
    ...safe,
    canManageContent: true,
    canPlayMinecraft: account.type === 'microsoft',
    licenseStatus: account.type === 'microsoft' ? 'verified' : 'guest',
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

export function logoutAccount(uuid: string): void {
  const config = getConfig()
  config.accounts = config.accounts.filter((account) => account.uuid !== uuid)
  if (config.activeAccountId === uuid) {
    config.activeAccountId = config.accounts[0]?.uuid ?? null
  }
  saveConfig(config)
}
