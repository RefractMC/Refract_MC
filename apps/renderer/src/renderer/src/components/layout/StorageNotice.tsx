import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

export function StorageNotice() {
  const t = useT()
  const queryClient = useQueryClient()
  useEffect(
    () =>
      api.config.onRecovery(() => {
        void queryClient.invalidateQueries({ queryKey: ['config'] })
      }),
    [queryClient]
  )
  const { data, error } = useQuery({ queryKey: ['config'], queryFn: () => api.config.get() })
  const recovered = data?.storageRecoveryWarnings ?? []
  if (!error && recovered.length === 0) return null

  return (
    <div
      role="alert"
      style={{
        margin: '14px 28px 0',
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
        color: 'var(--ink)',
        fontSize: 12,
        lineHeight: 1.5,
        overflowWrap: 'anywhere',
      }}
    >
      <strong>{error ? t.storage.readFailed : t.storage.recovered}</strong>
      <div style={{ color: 'var(--ink-3)' }}>
        {error ? String(error instanceof Error ? error.message : error) : t.storage.recoveryHint}
      </div>
      {recovered.length > 0 && (
        <details>
          <summary>{t.storage.affectedFiles}</summary>
          <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
            {recovered.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
