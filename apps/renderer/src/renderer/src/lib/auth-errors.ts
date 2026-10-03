/** Stable native discriminants. Provider messages never determine recovery actions. */
const messageKeys = {
  AUTH_EXPIRED: 'expired',
  AUTH_SERVICE_UNAVAILABLE: 'serviceUnavailable',
  NETWORK_UNAVAILABLE: 'networkUnavailable',
  VAULT_LOCKED: 'vaultLocked',
  VAULT_UNAVAILABLE: 'vaultUnavailable',
  VAULT_KEY_MISSING: 'vaultKeyMissing',
  VAULT_KEY_INVALID: 'vaultKeyInvalid',
  AUTH_STORAGE_FAILED: 'storageFailed',
  AUTH_INVALID_RESPONSE: 'invalidResponse',
  AUTH_ACCOUNT_NOT_FOUND: 'accountNotFound',
  AUTH_ACCOUNT_ACTION_REQUIRED: 'accountActionRequired',
  AUTH_CREDENTIALS_REJECTED: 'credentialsRejected',
  AUTH_NO_LICENSE: 'noLicense',
  AUTH_PENDING: 'pending',
  AUTH_SLOW_DOWN: 'slowDown',
  AUTH_DEVICE_EXPIRED: 'deviceExpired',
  AUTH_DECLINED: 'declined',
  AUTH_BUSY: 'busy',
  operation_cancelled: 'cancelled',
} as const

type Messages = Record<(typeof messageKeys)[keyof typeof messageKeys], string>

export function authErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function authErrorMessage(error: unknown, messages: Messages, fallback: string): string {
  const code = authErrorCode(error)
  if (code && Object.hasOwn(messageKeys, code)) {
    return messages[messageKeys[code as keyof typeof messageKeys]]
  }
  return error instanceof Error ? error.message : fallback
}

export function authRecoveryAction(
  error: unknown
): 'signIn' | 'accounts' | 'offline' | 'retry' | 'none' {
  switch (authErrorCode(error)) {
    case 'AUTH_EXPIRED':
      return 'signIn'
    case 'AUTH_ACCOUNT_NOT_FOUND':
      return 'accounts'
    case 'AUTH_SERVICE_UNAVAILABLE':
    case 'NETWORK_UNAVAILABLE':
      return 'offline'
    case 'VAULT_LOCKED':
    case 'VAULT_UNAVAILABLE':
    case 'AUTH_STORAGE_FAILED':
    case 'AUTH_INVALID_RESPONSE':
    case 'AUTH_BUSY':
      return 'retry'
    default:
      return 'none'
  }
}
