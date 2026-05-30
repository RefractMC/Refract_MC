export type ModLoader = 'fabric' | 'forge' | 'quilt' | 'neoforge'

export interface InstalledMod {
  projectId: string
  versionId: string
  name: string
  fileName: string
  fileSize: number
  loader: string
  gameVersion: string
  installedAt: string
}

export interface Instance {
  id: string
  name: string
  folderName?: string   // human-readable folder on disk; falls back to id for legacy instances
  customPath?: string   // absolute path when user chose a non-default location
  minecraftVersion: string
  modLoader?: ModLoader
  modLoaderVersion?: string
  javaPath?: string
  javaArgs?: string
  memoryMb: number
  iconPath?: string
  groupId?: string
  lastPlayed?: string
  totalTimePlayed: number
  createdAt: string
  mods?: InstalledMod[]
  isInstalled?: boolean
  pinned?: boolean
}

export type CreateInstanceInput = Omit<Instance, 'id' | 'createdAt' | 'totalTimePlayed' | 'mods' | 'isInstalled'>

export function createInstance(input: CreateInstanceInput): Instance {
  return {
    ...input,
    id: crypto.randomUUID(),
    totalTimePlayed: 0,
    createdAt: new Date().toISOString(),
    mods: [],
    isInstalled: false,
  }
}
