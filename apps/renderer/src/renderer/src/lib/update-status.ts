import { parseUpdateMetadata } from './update-metadata'

const phases = [
  'idle',
  'checking',
  'current',
  'available',
  'downloading',
  'ready',
  'installing',
  'restarting',
  'error',
] as const

export type UpdateStatus = {
  revision: number
  phase: (typeof phases)[number]
  update: ReturnType<typeof parseUpdateMetadata>
  version?: string
  percent?: number
  error?: string
  retry?: 'check' | 'download' | 'install'
  slow: boolean
}

export const emptyUpdateStatus: UpdateStatus = {
  revision: 0,
  phase: 'idle',
  update: null,
  slow: false,
}

export function parseUpdateStatus(value: unknown): UpdateStatus {
  const invalid = () => new Error('Invalid native app update status.')
  if (!value || typeof value !== 'object') throw invalid()
  const raw = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !phases.includes(raw.phase as UpdateStatus['phase']) ||
    typeof raw.slow !== 'boolean' ||
    (raw.percent !== null &&
      (typeof raw.percent !== 'number' ||
        !Number.isInteger(raw.percent) ||
        raw.percent < 0 ||
        raw.percent > 100)) ||
    (raw.error !== null && typeof raw.error !== 'string') ||
    (raw.retry !== null && !['check', 'download', 'install'].includes(raw.retry as string))
  )
    throw invalid()
  const update = parseUpdateMetadata(raw.update)
  const phase = raw.phase as UpdateStatus['phase']
  if (
    (['available', 'downloading', 'ready', 'installing', 'restarting'].includes(phase) &&
      !update) ||
    (phase === 'error' && (!raw.error || !raw.retry)) ||
    (phase === 'error' && raw.retry !== 'check' && !update) ||
    (phase !== 'error' && (raw.error !== null || raw.retry !== null)) ||
    (raw.slow && phase !== 'installing' && phase !== 'restarting')
  )
    throw invalid()
  return {
    revision: raw.revision as number,
    phase,
    update,
    version: update?.version,
    percent: raw.percent === null ? undefined : (raw.percent as number),
    error: raw.error === null ? undefined : (raw.error as string),
    retry: raw.retry === null ? undefined : (raw.retry as UpdateStatus['retry']),
    slow: raw.slow,
  }
}

// A delayed response must not overwrite a newer native transition. Subscribers
// replay the last snapshot, including after route changes.
export function createUpdateStatusStore() {
  let current: UpdateStatus | null = null
  const listeners = new Set<(status: UpdateStatus) => void>()
  return {
    get: () => current,
    accept(value: unknown) {
      const next = parseUpdateStatus(value)
      if (current && next.revision < current.revision) return current
      if (current && next.revision === current.revision && next.update?.rid === current.update?.rid)
        return current
      current = next
      for (const listener of listeners) listener(next)
      return next
    },
    subscribe(callback: (status: UpdateStatus) => void) {
      listeners.add(callback)
      if (current) callback(current)
      return () => {
        listeners.delete(callback)
      }
    },
  }
}

// Timing out a read permits reconnection; it never cancels an updater operation.
export function createUpdateStatusReader(
  load: () => Promise<unknown>,
  accept: (value: unknown) => UpdateStatus,
  timeoutMs = 5000
) {
  let active: Promise<UpdateStatus> | null = null
  return function read(): Promise<UpdateStatus> {
    if (active) return active
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('App update status did not respond.')), timeoutMs)
    })
    const job = Promise.race([Promise.resolve().then(load), deadline])
      .then(accept)
      .finally(() => {
        clearTimeout(timer)
        if (active === job) active = null
      })
    active = job
    return job
  }
}
