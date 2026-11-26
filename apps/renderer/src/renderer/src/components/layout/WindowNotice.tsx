import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { useAppUpdate } from '@/hooks/use-app-update'

export function WindowNotice() {
  const t = useT()
  const [error, setError] = useState<'window' | 'tray' | 'settings' | 'busy' | 'updater' | null>(
    null
  )
  const [quitting, setQuitting] = useState(false)
  const { status } = useAppUpdate()
  const installing = status.phase === 'installing' || status.phase === 'restarting'
  useEffect(() => api.window.onError(setError), [])
  // The labels arrive already resolved for the selected language, so the tray follows every
  // locale file, including the English fallback for strings that are not translated yet.
  const show = t.windowLifecycle.showLauncher
  const quit = t.windowLifecycle.quitLauncher
  useEffect(() => {
    let alive = true
    void api.window.setTrayLabels({ show, quit }).catch(() => {
      if (alive) setError('tray')
    })
    return () => {
      alive = false
    }
  }, [show, quit])
  if (!error) return null
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
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ flex: 1 }}>{t.windowLifecycle[error]}</span>
      {error === 'updater' && (
        <Button
          variant="outline"
          size="sm"
          disabled={quitting || installing}
          onClick={() => {
            setQuitting(true)
            void api.window
              .quit(true)
              .catch(() => setError('window'))
              .finally(() => setQuitting(false))
          }}
        >
          {t.windowLifecycle.quitWithoutUpdate}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => setError(null)}>
        {t.windowLifecycle.dismiss}
      </Button>
    </div>
  )
}
