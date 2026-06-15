import { join } from 'path'
import { BrowserWindow, dialog } from 'electron'
import { existsSync, rmSync } from 'fs'
import { handleIpc } from './handle'
import type { JavaInstallation } from '@refract/core'
import {
  getManagedJavaDir,
  loadManagedJavas,
  saveManagedJavas,
  requiredJavaVersion,
  probeJavaExe,
  downloadJava,
  ensureJava,
} from '../services/java-manager'

const IS_WIN = process.platform === 'win32'

export function emitJavaProgress(major: number, step: string, percent: number): void {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('java:progress', { major, step, percent }))
}

export function registerJavaIpc(): void {
  handleIpc('java.managedList', () => loadManagedJavas())

  handleIpc('java.requiredFor', (_e, mcVersion: unknown) => requiredJavaVersion(String(mcVersion)))

  handleIpc('java.download', async (_e, major: unknown) => {
    const m = Number(major)
    return downloadJava(m, (step, percent) => emitJavaProgress(m, step, percent))
  })

  // Make sure a runtime for this Minecraft version exists, downloading one if
  // needed. Returns the major that was ensured (so the UI can show progress).
  handleIpc('java.ensureFor', async (_e, mcVersion: unknown) => {
    const major = requiredJavaVersion(String(mcVersion))
    await ensureJava(major, (step, percent) => emitJavaProgress(major, step, percent))
    return major
  })

  handleIpc('java.delete', (_e, major: unknown) => {
    const majorNum = Number(major)
    const extractDir = join(getManagedJavaDir(), `jre-${majorNum}`)
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
    saveManagedJavas(loadManagedJavas().filter(j => j.version !== majorNum || (j as JavaInstallation & { custom?: boolean }).custom))
  })

  handleIpc('java.browseExe', async () => {
    const { filePaths } = await dialog.showOpenDialog({
      title: 'Select Java executable',
      filters: IS_WIN ? [{ name: 'Java Executable', extensions: ['exe'] }] : [{ name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return filePaths[0] ?? null
  })

  handleIpc('java.addCustom', async (_e, javaPath: unknown) => {
    const exe = String(javaPath).trim()
    if (!existsSync(exe)) throw new Error(`File not found: ${exe}`)
    const probed = await probeJavaExe(exe)
    if (!probed) throw new Error('Not a valid Java executable — could not read version.')
    const installation = { ...probed, custom: true } as JavaInstallation & { custom: boolean }
    const managed = loadManagedJavas().filter(j => j.path !== probed.path)
    managed.push(installation)
    saveManagedJavas(managed)
    return installation
  })

  handleIpc('java.removeCustom', (_e, javaPath: unknown) => {
    saveManagedJavas(loadManagedJavas().filter(j => j.path !== String(javaPath)))
  })
}
