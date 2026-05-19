import { ipcMain } from 'electron'
import { join } from 'path'
import { readdirSync, existsSync, copyFileSync, rmSync, readFileSync } from 'fs'
import { paths } from '../services/paths'

export function registerThemeIpc(): void {
  ipcMain.handle('theme.list', () => {
    if (!existsSync(paths.themes)) return []
    return readdirSync(paths.themes)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(paths.themes, f), 'utf-8'))]
        } catch {
          return []
        }
      })
  })

  ipcMain.handle('theme.install', (_event, sourcePath: string) => {
    const fileName = sourcePath.split(/[\\/]/).pop() ?? 'theme.json'
    const dest = join(paths.themes, fileName)
    copyFileSync(sourcePath, dest)
    return JSON.parse(readFileSync(dest, 'utf-8'))
  })

  ipcMain.handle('theme.delete', (_event, fileName: string) => {
    const filePath = join(paths.themes, fileName)
    if (existsSync(filePath)) rmSync(filePath)
  })
}
