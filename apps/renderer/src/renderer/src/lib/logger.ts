import { describeLogError, safeLogText } from './log-safety.js'

type LogLevel = 'info' | 'warn' | 'error'

interface RendererLogEntry {
  level: LogLevel
  source: string
  message: string
  stack?: string
}

const STORAGE_KEY = 'refract.renderer.logs'
const MAX_ENTRIES = 200
const MAX_STORED_CHARACTERS = 256 * 1024
let forwarding = false
let pendingWrites = 0
let omittedWrites = false
let nativeWriter: ((entry: RendererLogEntry) => Promise<unknown>) | undefined

export function setNativeLogWriter(writer: (entry: RendererLogEntry) => Promise<unknown>): void {
  nativeWriter = writer
}

function serializeError(error: unknown): Pick<RendererLogEntry, 'message' | 'stack'> {
  return describeLogError(error)
}

function persist(entry: RendererLogEntry): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw && raw.length <= MAX_STORED_CHARACTERS ? JSON.parse(raw) : []
    const existing = Array.isArray(parsed)
      ? parsed.slice(-MAX_ENTRIES + 1).flatMap((item) => {
          if (!item || typeof item !== 'object' || typeof item.message !== 'string') return []
          return [
            {
              time: typeof item.time === 'string' ? item.time.slice(0, 40) : '',
              level: item.level === 'error' ? 'error' : item.level === 'warn' ? 'warn' : 'info',
              source: safeLogText(typeof item.source === 'string' ? item.source : 'renderer'),
              message: safeLogText(item.message),
              stack: typeof item.stack === 'string' ? safeLogText(item.stack) : undefined,
            },
          ]
        })
      : []
    const next = [...existing, { time: new Date().toISOString(), ...entry }]
    let encoded = JSON.stringify(next)
    while (encoded.length > MAX_STORED_CHARACTERS && next.length > 1) {
      next.shift()
      encoded = JSON.stringify(next)
    }
    localStorage.setItem(STORAGE_KEY, encoded)
  } catch {
    // Logging must never break rendering.
  }
}

function forwardToMain(entry: RendererLogEntry): void {
  if (forwarding || !nativeWriter) return
  if (pendingWrites >= 8) {
    omittedWrites = true
    return
  }
  try {
    forwarding = true
    pendingWrites++
    if (omittedWrites) {
      entry = {
        ...entry,
        message: `[Refract: excess renderer log entries omitted]\n${entry.message}`,
      }
      omittedWrites = false
    }
    void Promise.resolve(nativeWriter(entry))
      .catch(() => {})
      .finally(() => {
        pendingWrites--
      })
  } catch {
    pendingWrites--
    // Logging must never recursively throw.
  } finally {
    forwarding = false
  }
}

function write(entry: RendererLogEntry): void {
  entry = {
    ...entry,
    source: safeLogText(entry.source),
    message: safeLogText(entry.message),
    stack: entry.stack ? safeLogText(entry.stack) : undefined,
  }
  persist(entry)
  forwardToMain(entry)

  if (entry.level === 'error') {
    console.error(`[${entry.source}] ${entry.message}`, entry.stack ?? '')
  } else if (entry.level === 'warn') {
    console.warn(`[${entry.source}] ${entry.message}`)
  } else {
    console.info(`[${entry.source}] ${entry.message}`)
  }
}

export const logger = {
  info(source: string, message: string): void {
    write({ level: 'info', source, message })
  },
  warn(source: string, message: string): void {
    write({ level: 'warn', source, message })
  },
  error(source: string, error: unknown): void {
    write({ level: 'error', source, ...serializeError(error) })
  },
}

export function installRendererErrorLogging(): void {
  window.addEventListener('error', (event) => {
    logger.error('renderer:error', event.error ?? event.message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    logger.error('renderer:unhandledRejection', event.reason)
  })
}
