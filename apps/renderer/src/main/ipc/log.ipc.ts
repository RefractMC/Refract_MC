import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { writeLog, type LogLevel } from '../services/logger'
import { paths } from '../services/paths'
import { handleIpc } from './handle'

const LOG_FILE = () => join(paths.logs, 'refract.log')
const MAX_LOG_BYTES = 2 * 1024 * 1024 // 2 MB hard cap before rotation

function rotateLogs(): void {
  const file = LOG_FILE()
  if (!existsSync(file)) return
  if (statSync(file).size > MAX_LOG_BYTES) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    // Keep last 500 lines
    writeFileSync(file, lines.slice(-500).join('\n') + '\n', 'utf-8')
  }
}

export function registerLogIpc(): void {
  ipcMain.on(
    'log.write',
    (_event, entry: { level?: LogLevel; source?: string; message?: string; stack?: string }) => {
      writeLog({
        level: entry.level ?? 'info',
        source: entry.source ?? 'renderer',
        message: entry.message ?? '',
        stack: entry.stack,
      })
      rotateLogs()
    }
  )

  handleIpc('logs.read', (_e, limit) => {
    const file = LOG_FILE()
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    const n = typeof limit === 'number' ? limit : 200
    return lines.slice(-n).reverse().map(line => {
      try { return JSON.parse(line) } catch { return { level: 'info', source: 'unknown', message: line, time: '' } }
    })
  })

  handleIpc('logs.clear', () => {
    const file = LOG_FILE()
    if (existsSync(file)) writeFileSync(file, '', 'utf-8')
  })
}
