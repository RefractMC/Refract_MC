import { useState, useEffect } from 'react'
import type React from 'react'
import type { MinecraftVersion } from '@refract/core'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

// Module-level cache — fetched once per app session
let patchNotesCache: Record<string, string> | null = null

interface Props {
  value: string
  onChange: (v: string) => void
  selectStyle?: React.CSSProperties
  selectClassName?: string
  showSnapshots?: boolean
  onShowSnapshotsChange?: (v: boolean) => void
  hideBuiltinCheckbox?: boolean
  showReleaseNote?: boolean
}

export function McVersionSelect({ value, onChange, selectStyle, selectClassName, showSnapshots: externalSnap, onShowSnapshotsChange, hideBuiltinCheckbox, showReleaseNote = true }: Props) {
  const t = useT()
  const [versions, setVersions] = useState<MinecraftVersion[]>([])
  const [internalSnap, setInternalSnap] = useState(false)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<string | null>(null)

  const showSnapshots = externalSnap !== undefined ? externalSnap : internalSnap
  const setShowSnapshots = (v: boolean) => {
    if (onShowSnapshotsChange) onShowSnapshotsChange(v)
    else setInternalSnap(v)
  }

  useEffect(() => {
    api.mc.versions()
      .then(setVersions)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Fetch patch notes once and cache at module level
  useEffect(() => {
    if (!showReleaseNote) return
    if (patchNotesCache !== null) return
    fetch('https://launchercontent.mojang.com/v2/javaPatchNotes.json')
      .then(r => r.ok ? r.json() as Promise<{ entries: Array<{ version: string; shortText: string; type: string }> }> : null)
      .then(data => {
        if (!data) return
        const map: Record<string, string> = {}
        for (const entry of data.entries) {
          map[entry.version] = entry.shortText
        }
        patchNotesCache = map
        // Trigger note update for current value
        setNote(map[value] ?? null)
      })
      .catch(() => {
        // silently ignore — patchNotesCache stays null so we won't retry
        patchNotesCache = {}
      })
  }, [])

  // Update note when selected version changes
  useEffect(() => {
    if (!showReleaseNote) { setNote(null); return }
    if (patchNotesCache === null) return
    const raw = patchNotesCache[value] ?? null
    if (!raw) { setNote(null); return }
    // Truncate to 80 chars
    setNote(raw.length > 80 ? raw.slice(0, 79) + '…' : raw)
  }, [value, showReleaseNote])

  const visible = versions.filter(v =>
    v.type === 'release' || (showSnapshots && v.type === 'snapshot')
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={loading}
        style={{ ...selectStyle, opacity: loading ? 0.6 : 1 }}
        className={selectClassName}
      >
        {loading ? (
          <option value={value}>{t.mcVersionSelect.loadingOption(value)}</option>
        ) : visible.map(v => (
          <option key={v.id} value={v.id}>
            {v.id}{v.type === 'snapshot' ? t.mcVersionSelect.snapshotSuffix : ''}
          </option>
        ))}
      </select>
      {showReleaseNote && note && (
        <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
          {note}
        </div>
      )}
      {!hideBuiltinCheckbox && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={showSnapshots}
            onChange={e => setShowSnapshots(e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.10em', color: 'var(--ink-4)' }}>
            {t.mcVersionSelect.showSnapshots}
          </span>
        </label>
      )}
    </div>
  )
}
