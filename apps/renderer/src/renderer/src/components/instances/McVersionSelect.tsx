import { useState, useEffect } from 'react'
import type React from 'react'
import type { MinecraftVersion } from '@refract/core'
import { api } from '@/lib/api'

interface Props {
  value: string
  onChange: (v: string) => void
  selectStyle?: React.CSSProperties
  selectClassName?: string
  showSnapshots?: boolean
  onShowSnapshotsChange?: (v: boolean) => void
  hideBuiltinCheckbox?: boolean
}

export function McVersionSelect({ value, onChange, selectStyle, selectClassName, showSnapshots: externalSnap, onShowSnapshotsChange, hideBuiltinCheckbox }: Props) {
  const [versions, setVersions] = useState<MinecraftVersion[]>([])
  const [internalSnap, setInternalSnap] = useState(false)
  const [loading, setLoading] = useState(true)

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
          <option value={value}>{value} (loading…)</option>
        ) : visible.map(v => (
          <option key={v.id} value={v.id}>
            {v.id}{v.type === 'snapshot' ? ' (snapshot)' : ''}
          </option>
        ))}
      </select>
      {!hideBuiltinCheckbox && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={showSnapshots}
            onChange={e => setShowSnapshots(e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 12, letterSpacing: '.08em', color: 'var(--ink-4)' }}>
            SHOW SNAPSHOTS
          </span>
        </label>
      )}
    </div>
  )
}
