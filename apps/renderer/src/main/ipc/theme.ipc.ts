import { join } from 'path'
import { readdirSync, existsSync, copyFileSync, rmSync, readFileSync } from 'fs'
import { paths } from '../services/paths'
import { handleIpc } from './handle'

export function registerThemeIpc(): void {
  handleIpc('theme.list', () => {
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

  handleIpc('theme.install', (_event, sourcePath) => {
    const source = String(sourcePath)
    const fileName = source.split(/[\\/]/).pop() ?? 'theme.json'
    const dest = join(paths.themes, fileName)
    copyFileSync(source, dest)
    return JSON.parse(readFileSync(dest, 'utf-8'))
  })

  handleIpc('theme.delete', (_event, fileName) => {
    const filePath = join(paths.themes, String(fileName))
    if (existsSync(filePath)) rmSync(filePath)
  })
}
