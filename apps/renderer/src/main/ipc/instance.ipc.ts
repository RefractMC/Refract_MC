import {
  listInstances,
  getInstanceById,
  createAndSaveInstance,
  updateInstance,
  deleteInstance,
} from '../services/instance-store'
import type { CreateInstanceInput, Instance } from '@refract/core'
import { handleIpc } from './handle'
import { shell, dialog, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { spawn } from 'child_process'
import { resolveInstanceDir } from '../services/instance-store'
import { importMultiMcInstance } from '../services/multimc-import'
import { paths } from '../services/paths'

function zipDirectory(src: string, dst: string): Promise<void> {
  const psEscape = (s: string) => s.replace(/'/g, "''")
  const cmd = `Compress-Archive -LiteralPath '${psEscape(src)}' -DestinationPath '${psEscape(dst)}' -Force`
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => { code === 0 ? resolve() : reject(new Error(`Export failed (code ${code}): ${stderr.slice(0, 300)}`)) })
    proc.on('error', reject)
  })
}

export function registerInstanceIpc(): void {
  handleIpc('instance.list', () => listInstances())

  handleIpc('instance.getById', (_event, id) => getInstanceById(String(id)))

  handleIpc('instance.create', (_event, input) =>
    createAndSaveInstance(input as CreateInstanceInput)
  )

  handleIpc(
    'instance.update',
    (_event, id, patch) =>
      updateInstance(String(id), patch as Partial<Omit<Instance, 'id' | 'createdAt'>>)
  )

  handleIpc('instance.delete', (_event, id) => {
    deleteInstance(String(id))
  })

  handleIpc('instance.openFolder', (_event, id) => {
    const gameDir = join(resolveInstanceDir(String(id)), 'minecraft')
    if (!existsSync(gameDir)) mkdirSync(gameDir, { recursive: true })
    shell.openPath(gameDir)
  })

  handleIpc('instance.duplicate', (_event, id) => {
    const src = getInstanceById(String(id))
    if (!src) throw new Error(`Instance not found: ${id}`)
    const srcDir = resolveInstanceDir(String(id))

    const copy = createAndSaveInstance({
      name: `${src.name} (copy)`,
      minecraftVersion: src.minecraftVersion,
      modLoader: src.modLoader,
      modLoaderVersion: src.modLoaderVersion,
      memoryMb: src.memoryMb,
      iconPath: src.iconPath,
      javaPath: src.javaPath,
      javaArgs: src.javaArgs,
      pinned: false,
    })
    const dstDir = resolveInstanceDir(copy.id)

    const COPY_DIRS = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks', 'config']
    for (const dir of COPY_DIRS) {
      const s = join(srcDir, 'minecraft', dir)
      if (existsSync(s)) cpSync(s, join(dstDir, 'minecraft', dir), { recursive: true })
    }

    if (src.isInstalled) updateInstance(copy.id, { isInstalled: true, mods: src.mods ?? [] })

    return getInstanceById(copy.id)
  })

  handleIpc('instance.importMultiMc', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select MultiMC / Prism Instance Folder',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importMultiMcInstance(result.filePaths[0])
  })

  handleIpc('instance.export', async (_event, id) => {
    const instanceDir = resolveInstanceDir(String(id))
    if (!existsSync(instanceDir)) throw new Error('Instance folder not found.')
    const instance = getInstanceById(String(id))
    const safeName = (instance?.name ?? String(id)).replace(/[<>:"/\\|?*]+/g, '').trim() || 'instance'
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export Instance',
      defaultPath: `${safeName}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    })
    if (canceled || !filePath) return null
    await zipDirectory(instanceDir, filePath)
    return filePath
  })

  handleIpc('launcher.deleteAll', async () => {
    const userData = paths.userData
    const subdirs = ['instances', 'themes', 'plugins', 'java', 'assets', 'libraries', 'versions', 'cache', 'logs'] as const
    for (const sub of subdirs) {
      const p = join(userData, sub)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    // Delete config file
    const configPath = join(userData, 'config.json')
    if (existsSync(configPath)) rmSync(configPath)
    app.exit(0)
  })
}
