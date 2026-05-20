import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { paths } from './paths'

export interface ActivityEntry {
  id: string
  label: string
  ts: number
}

function getPath() { return join(paths.userData, 'activity.json') }

export function readActivity(): ActivityEntry[] {
  try {
    return JSON.parse(readFileSync(getPath(), 'utf-8')) as ActivityEntry[]
  } catch {
    return []
  }
}

export function appendActivity(label: string): ActivityEntry {
  const entry: ActivityEntry = { id: randomUUID(), label, ts: Date.now() }
  const entries = [entry, ...readActivity()].slice(0, 50)
  try {
    writeFileSync(getPath(), JSON.stringify(entries, null, 2), 'utf-8')
  } catch { /* ignore */ }
  return entry
}
