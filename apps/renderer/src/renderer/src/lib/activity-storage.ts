type ActivityEntry = { id: string; label: string; ts: number }
type ActivityStorage = Pick<Storage, 'getItem' | 'setItem'>
const key = 'refract.activity'

export function readPreviewActivity(storage: ActivityStorage): ActivityEntry[] {
  const raw = storage.getItem(key)
  if (raw === null) return []
  const entries: unknown = JSON.parse(raw)
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.id !== 'string' ||
        typeof entry.label !== 'string' ||
        typeof entry.ts !== 'number' ||
        !Number.isFinite(entry.ts)
    )
  )
    throw new Error('Saved activity is invalid. The stored data was preserved.')
  return entries
}

export function addPreviewActivity(storage: ActivityStorage, entry: ActivityEntry): ActivityEntry {
  const entries = [entry, ...readPreviewActivity(storage)].slice(0, 50)
  storage.setItem(key, JSON.stringify(entries))
  return entry
}
