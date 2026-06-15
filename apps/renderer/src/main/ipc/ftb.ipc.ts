import { BrowserWindow } from 'electron'
import { handleIpc } from './handle'
import { installFtbModpack } from '../services/modpack'
import { searchFtbModpacks, getFtbModpack } from '@refract/core'

export function registerFtbIpc(mainWindow?: BrowserWindow): void {
  handleIpc('ftb.search', async (_event, query, limit) =>
    searchFtbModpacks(query ? String(query) : undefined, typeof limit === 'number' ? limit : 20)
  )

  handleIpc('ftb.modpack', async (_event, id) => getFtbModpack(Number(id)))

  handleIpc('ftb.installModpack', async (_event, name, packId, versionId) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    return installFtbModpack(String(name), Number(packId), Number(versionId), win)
  })
}
