import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { paths } from './paths'

export interface SavedSkin {
  id: string
  name: string
  filename: string      // basename inside userData/skins/
  variant: 'classic' | 'slim'
  addedAt: string
}

function skinsDir(): string {
  return join(paths.userData, 'skins')
}

function manifestPath(): string {
  return join(paths.userData, 'skins-manifest.json')
}

export function listSkins(): SavedSkin[] {
  try {
    if (!existsSync(manifestPath())) return []
    return JSON.parse(readFileSync(manifestPath(), 'utf-8')) as SavedSkin[]
  } catch { return [] }
}

function saveManifest(skins: SavedSkin[]): void {
  writeFileSync(manifestPath(), JSON.stringify(skins, null, 2), 'utf-8')
}

export function addSkin(name: string, sourcePath: string, variant: 'classic' | 'slim'): SavedSkin {
  const id = randomUUID()
  const filename = `${id}.png`
  const dir = skinsDir()
  mkdirSync(dir, { recursive: true })
  copyFileSync(sourcePath, join(dir, filename))
  const skin: SavedSkin = { id, name, filename, variant, addedAt: new Date().toISOString() }
  saveManifest([...listSkins(), skin])
  return skin
}

export function deleteSkin(id: string): void {
  const skins = listSkins()
  const skin = skins.find(s => s.id === id)
  if (skin) {
    try { rmSync(join(skinsDir(), skin.filename)) } catch { /* ignore */ }
  }
  saveManifest(skins.filter(s => s.id !== id))
}

export function getSkinPath(filename: string): string {
  return join(skinsDir(), filename)
}
