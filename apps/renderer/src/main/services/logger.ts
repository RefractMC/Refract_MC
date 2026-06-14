import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { paths } from './paths'
import { trackEvent } from './analytics'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  source: string
  message: string
  stack?: string
}

function serializeError(error: unknown): Pick<LogEntry, 'message' | 'stack'> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }

  if (typeof error === 'string') {
    return { message: error }
  }

  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

export function writeLog(entry: LogEntry): void {
  try {
    mkdirSync(paths.logs, { recursive: true })
    const line = JSON.stringify({
      time: new Date().toISOString(),
      ...entry,
    })
    appendFileSync(join(paths.logs, 'refract.log'), `${line}\n`, 'utf-8')
  } catch {
    // Logging must never break the app.
  }
}

export function logError(source: string, error: unknown): void {
  writeLog({
    level: 'error',
    source,
    ...serializeError(error),
  })
  // Forward an anonymized error signal — the source label only, never the
  // message or stack (those can contain file paths or tokens).
  try { trackEvent('app_error', { source }) } catch { /* never let telemetry break logging */ }
}

export function installProcessErrorLogging(): void {
  process.on('uncaughtException', (error) => {
    logError('main:uncaughtException', error)
  })

  process.on('unhandledRejection', (reason) => {
    logError('main:unhandledRejection', reason)
  })
}
