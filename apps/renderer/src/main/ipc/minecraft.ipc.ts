import { ipcMain, BrowserWindow } from 'electron'
import { handleIpc } from './handle'
import { fetchVersionList } from '@refract/core'
import { detectJavaInstallations } from '@refract/core/java-manager'
import { installMinecraft } from '../services/minecraft/downloader'
import { launchInstance, stopInstance, isInstanceRunning } from '../services/minecraft/launcher'

export function registerMinecraftIpc(mainWindow: BrowserWindow): void {
  handleIpc('mc.versions', () => fetchVersionList())

  handleIpc('mc.java', () => detectJavaInstallations())

  handleIpc('mc.isRunning', (_event, instanceId) => isInstanceRunning(String(instanceId)))

  handleIpc('mc.install', async (_event, instanceId, versionId, versionUrl, modLoader, modLoaderVersion) => {
    await installMinecraft(
      String(instanceId),
      String(versionId),
      String(versionUrl),
      modLoader ? String(modLoader) : undefined,
      modLoaderVersion ? String(modLoaderVersion) : undefined,
      (progress) => {
        mainWindow.webContents.send('mc:progress', { instanceId, ...progress })
      }
    )

    // Mark instance as installed
    const instanceStore = await import('../services/instance-store')
    instanceStore.updateInstance(String(instanceId), {
      isInstalled: true,
      modLoaderVersion: modLoaderVersion ? String(modLoaderVersion) : undefined,
    })
  })

  handleIpc('mc.repair', async (_event, instanceId) => {
    const instanceStore = await import('../services/instance-store')
    const instance = instanceStore.getInstanceById(String(instanceId))
    if (!instance) throw new Error(`Instance not found: ${instanceId}`)

    const versions = await fetchVersionList()
    const ver = versions.find(v => v.id === instance.minecraftVersion)
    if (!ver) throw new Error(`Minecraft ${instance.minecraftVersion} not found in Mojang manifest.`)

    await installMinecraft(
      String(instanceId),
      ver.id,
      ver.url,
      instance.modLoader,
      instance.modLoaderVersion,
      (progress) => {
        mainWindow.webContents.send('mc:progress', { instanceId, ...progress })
      }
    )

    instanceStore.updateInstance(String(instanceId), { isInstalled: true })
  })

  handleIpc('mc.launch', (_event, instanceId) =>
    launchInstance(String(instanceId), mainWindow)
  )

  handleIpc('mc.stop', (_event, instanceId) => {
    stopInstance(String(instanceId))
  })
}
