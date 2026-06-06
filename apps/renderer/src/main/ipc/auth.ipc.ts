import {
  beginMicrosoftLogin,
  completeMicrosoftLogin,
  createOfflineAccount,
  renameOfflineAccount,
  getActiveAccount,
  listSafeAccounts,
  logoutAccount,
  setActiveAccount,
  loginYggdrasil,
  uploadSkin,
  fetchAccountCapes,
  setActiveCape,
} from '../services/auth'
import { dialog } from 'electron'
import { handleIpc } from './handle'

export function registerAuthIpc(): void {
  handleIpc('auth.accounts', () => listSafeAccounts())
  handleIpc('auth.active', () => getActiveAccount())
  handleIpc('auth.microsoft.begin', () => beginMicrosoftLogin())
  handleIpc('auth.microsoft.complete', (_event, deviceCode) => completeMicrosoftLogin(String(deviceCode)))
  handleIpc('auth.offline.create', (_event, username) => createOfflineAccount(String(username)))
  handleIpc('auth.offline.rename', (_event, uuid, username) => renameOfflineAccount(String(uuid), String(username)))
  handleIpc('auth.setActive', (_event, uuid) => setActiveAccount(String(uuid)))
  handleIpc('auth.logout', (_event, uuid) => logoutAccount(String(uuid)))
  handleIpc('auth.yggdrasil.login', (_event, serverUrl, username, password) =>
    loginYggdrasil(String(serverUrl), String(username), String(password))
  )

  handleIpc('auth.fetchSkinTextureUrl', async (_event, uuid) => {
    try {
      const id = String(uuid).replace(/-/g, '')
      const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`)
      if (!res.ok) return null
      const profile = await res.json() as { properties?: Array<{ name: string; value: string }> }
      const prop = profile.properties?.find(p => p.name === 'textures')
      if (!prop) return null
      const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf-8')) as { textures?: { SKIN?: { url?: string } } }
      return textures.textures?.SKIN?.url ?? null
    } catch { return null }
  })

  handleIpc('auth.browseSkin', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Select Minecraft Skin',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
      properties: ['openFile'],
    })
    return canceled ? null : (filePaths[0] ?? null)
  })

  handleIpc('auth.uploadSkin', async (_event, uuid, imagePath, variant) =>
    uploadSkin(String(uuid), String(imagePath), (String(variant) as 'classic' | 'slim'))
  )

  handleIpc('auth.fetchCapes', async (_event, uuid) => fetchAccountCapes(String(uuid)))

  handleIpc('auth.setCape', async (_event, uuid, capeId) =>
    setActiveCape(String(uuid), capeId == null ? null : String(capeId))
  )
}
