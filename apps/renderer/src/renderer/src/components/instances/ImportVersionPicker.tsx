import { useEffect, useId, useState } from 'react'
import type { MinecraftVersion } from '@refract/core'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

interface Props {
  value: string
  onChange: (value: string) => void
  onConfirm: () => void
}

export function ImportVersionPicker({ value, onChange, onConfirm }: Props) {
  const t = useT()
  const selectId = useId()
  const [versions, setVersions] = useState<MinecraftVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    api.mc
      .versions()
      .then((result) => {
        if (!active) return
        setVersions(result)
        setFailed(result.length === 0)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [attempt])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!loading && !failed && versions.some((version) => version.id === value)) onConfirm()
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0, lineHeight: 1.5 }}>
        {t.home.importVersionHelp}
      </p>
      <label htmlFor={selectId} style={{ fontSize: 12, color: 'var(--ink)' }}>
        {t.home.importVersionLabel}
      </label>
      <select
        id={selectId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading || failed}
        required
        style={{
          background: 'var(--surface-3)',
          color: 'var(--ink)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: 8,
        }}
      >
        <option value="">{t.home.importVersionChoose}</option>
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            {version.id}
          </option>
        ))}
      </select>
      {loading && <div role="status">{t.home.loading}</div>}
      {failed && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--lava)' }}>
          {t.home.importVersionLoadFailed}
          <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t.home.retry}
          </Button>
        </div>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={loading || failed || !versions.some((version) => version.id === value)}
      >
        {t.home.importVersionContinue}
      </Button>
    </form>
  )
}
