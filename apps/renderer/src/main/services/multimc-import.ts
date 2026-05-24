import { join, basename } from 'path'
import { existsSync, readFileSync, mkdirSync, readdirSync, cpSync } from 'fs'
import { createAndSaveInstance, resolveInstanceDir } from './instance-store'
import type { Instance } from '@refract/core'

interface MmcComponent {
  uid: string
  version?: string
}

interface MmcPack {
  components: MmcComponent[]
}

function parseInstanceCfg(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq === -1 || line.startsWith('[')) continue
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return result
}

function detectLoader(components: MmcComponent[]): { modLoader?: string; modLoaderVersion?: string } {
  for (const c of components) {
    if (c.uid === 'net.minecraftforge')           return { modLoader: 'forge',   modLoaderVersion: c.version }
    if (c.uid === 'net.neoforged.neoforge')       return { modLoader: 'neoforge', modLoaderVersion: c.version }
    if (c.uid === 'net.fabricmc.fabric-loader')   return { modLoader: 'fabric',  modLoaderVersion: c.version }
    if (c.uid === 'org.quiltmc.quilt-loader')     return { modLoader: 'quilt',   modLoaderVersion: c.version }
  }
  return {}
}

const COPY_DIRS = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'saves', 'datapacks']

export function importMultiMcInstance(instanceFolder: string): Instance {
  const cfgPath  = join(instanceFolder, 'instance.cfg')
  const packPath = join(instanceFolder, 'mmc-pack.json')

  if (!existsSync(cfgPath) || !existsSync(packPath))
    throw new Error('Not a valid MultiMC/Prism instance folder (missing instance.cfg or mmc-pack.json)')

  const cfg  = parseInstanceCfg(readFileSync(cfgPath, 'utf-8'))
  const pack = JSON.parse(readFileSync(packPath, 'utf-8')) as MmcPack

  const name = cfg['name'] ?? basename(instanceFolder)

  const mcComponent = pack.components.find(c => c.uid === 'net.minecraft')
  if (!mcComponent?.version) throw new Error('Could not determine Minecraft version from mmc-pack.json')

  const { modLoader, modLoaderVersion } = detectLoader(pack.components)

  const instance = createAndSaveInstance({
    name,
    minecraftVersion: mcComponent.version,
    modLoader,
    modLoaderVersion,
    isInstalled: false,
    group: 'Imported',
  })

  // Copy game content from minecraft/ subdir
  const mcDir = join(instanceFolder, '.minecraft')
  const srcDir = existsSync(mcDir) ? mcDir : join(instanceFolder, 'minecraft')
  if (existsSync(srcDir)) {
    const destDir = join(resolveInstanceDir(instance.id), 'minecraft')
    for (const dir of COPY_DIRS) {
      const src = join(srcDir, dir)
      if (!existsSync(src)) continue
      const dest = join(destDir, dir)
      mkdirSync(dest, { recursive: true })
      for (const entry of readdirSync(src)) {
        cpSync(join(src, entry), join(dest, entry), { recursive: true })
      }
    }
  }

  return instance
}
