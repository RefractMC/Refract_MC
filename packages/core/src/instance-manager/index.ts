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
  playtimeLog?: Record<string, number>  // YYYY-MM-DD → seconds played that day
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
  externalGameDir?: string  // when set, launch uses this dir instead of the default managed path
  externalSource?: string   // human label, e.g. "Prism Launcher"
  // Modpack provenance — set when the instance was created from a modpack, so we
  // can detect and apply newer versions later.
  modpackSource?: 'modrinth' | 'curseforge' | 'ftb'
  modpackProjectId?: string  // Modrinth project id / CurseForge mod id / FTB pack id
  modpackVersionId?: string  // Modrinth version id / CurseForge file id / FTB version id
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
