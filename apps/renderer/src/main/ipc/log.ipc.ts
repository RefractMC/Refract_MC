import { ipcMain } from 'electron'
import { writeLog, type LogLevel } from '../services/logger'

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
    }
  )
}
