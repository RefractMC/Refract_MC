import { Client } from '@xhayper/discord-rpc'

// Register a Discord application at https://discord.com/developers/applications
// Enable Rich Presence, then paste the Application ID here.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '1507941943190093844'

let client: Client | null = null
let connected = false
let startTimestamps: Map<string, number> = new Map()

async function ensureConnected(): Promise<boolean> {
  if (!DISCORD_CLIENT_ID) return false
  if (connected && client) return true
  try {
    client = new Client({ clientId: DISCORD_CLIENT_ID })
    await client.connect()
    connected = true
    return true
  } catch {
    client = null
    connected = false
    return false
  }
}

export async function setGameActivity(instanceId: string, instanceName: string, mcVersion: string, modLoader?: string): Promise<void> {
  startTimestamps.set(instanceId, Date.now())
  if (!await ensureConnected()) return
  try {
    const loaderLabel = modLoader ? ` · ${modLoader.charAt(0).toUpperCase()}${modLoader.slice(1)}` : ''
    await client!.user?.setActivity({
      details: instanceName,
      state: `MC ${mcVersion}${loaderLabel}`,
      startTimestamp: startTimestamps.get(instanceId),
      largeImageKey: 'grass_block',
      largeImageText: 'Refract Launcher',
      instance: false,
    })
  } catch {
    connected = false
  }
}

export async function clearGameActivity(instanceId: string): Promise<void> {
  startTimestamps.delete(instanceId)
  if (!connected || !client) return
  try {
    if (startTimestamps.size === 0) {
      await client.user?.clearActivity()
    }
  } catch {
    connected = false
  }
}
