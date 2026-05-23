import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { handleIpc } from './handle'
import { paths } from '../services/paths'
import { getConfig } from '../services/config'

export interface Friend {
  uuid: string
  username: string
  addedAt: number
  note?: string
}

function friendsPath(): string {
  return join(paths.userData, 'friends.json')
}

function load(): Friend[] {
  const f = friendsPath()
  if (!existsSync(f)) return []
  try { return JSON.parse(readFileSync(f, 'utf8')) as Friend[] } catch { return [] }
}

function persist(friends: Friend[]): void {
  writeFileSync(friendsPath(), JSON.stringify(friends, null, 2), 'utf8')
}

async function lookupMinecraft(username: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`)
  if (res.status === 404) throw new Error(`Player "${username}" not found.`)
  if (!res.ok) throw new Error(`Mojang API error: ${res.status}`)
  return res.json() as Promise<{ id: string; name: string }>
}

function hyphenateUuid(raw: string): string {
  return raw.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}

export function registerFriendsIpc(): void {
  handleIpc('friends.list', () => load())

  handleIpc('friends.add', async (_e, username) => {
    const name = String(username ?? '').trim()
    if (!name) throw new Error('Username is required.')

    const profile = await lookupMinecraft(name)
    const uuid = hyphenateUuid(profile.id)

    const config = getConfig()
    const activeAccount = config.accounts.find(a => a.uuid === config.activeAccountId)
    if (activeAccount && uuid === activeAccount.uuid) {
      throw new Error("You can't add yourself as a friend.")
    }

    const friends = load()
    if (friends.some(f => f.uuid === uuid)) {
      throw new Error(`${profile.name} is already in your friends list.`)
    }

    const friend: Friend = { uuid, username: profile.name, addedAt: Date.now() }
    friends.push(friend)
    persist(friends)
    return friend
  })

  handleIpc('friends.remove', (_e, uuid) => {
    persist(load().filter(f => f.uuid !== String(uuid)))
  })

  handleIpc('friends.updateNote', (_e, uuid, note) => {
    const friends = load()
    const i = friends.findIndex(f => f.uuid === String(uuid))
    if (i === -1) return
    friends[i] = { ...friends[i], note: String(note ?? '').trim() || undefined }
    persist(friends)
  })
}
