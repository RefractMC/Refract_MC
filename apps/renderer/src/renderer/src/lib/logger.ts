type LogLevel = 'info' | 'warn' | 'error'

interface RendererLogEntry {
  level: LogLevel
  source: string
  message: string
  stack?: string
}

const STORAGE_KEY = 'refract.renderer.logs'
const MAX_ENTRIES = 200

function serializeError(error: unknown): Pick<RendererLogEntry, 'message' | 'stack'> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }

  if (typeof error === 'string') return { message: error }

  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function persist(entry: RendererLogEntry): void {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Array<RendererLogEntry & { time: string }>
    const next = [...existing, { time: new Date().toISOString(), ...entry }].slice(-MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Logging must never break rendering.
  }
}

function forwardToMain(entry: RendererLogEntry): void {
  try {
    const maybeApi = (window as Window & { api?: Window['api'] }).api
    maybeApi?.log?.write(entry)
  } catch {
    // Logging must never recursively throw.
  }
}

function write(entry: RendererLogEntry): void {
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
