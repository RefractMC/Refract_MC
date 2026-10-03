import { useAppUpdate } from '@/hooks/use-app-update'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'

export function AppUpdateNotice() {
  const t = useT()
  const { status, connected, refresh } = useAppUpdate()
  if (!__APP_UPDATER_ENABLED__ || (!status.slow && connected !== false)) return null
  return (
    <div
      role="status"
      style={{
        margin: '14px 28px 0',
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
        color: 'var(--ink)',
        fontSize: 12,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ flex: '1 1 240px', lineHeight: 1.5 }}>
        {connected ? t.appUpdateStatus.slowHint : t.appUpdateStatus.disconnected}
      </span>
      <Button variant="outline" size="sm" onClick={() => void refresh()}>
        {t.appUpdateStatus.refresh}
      </Button>
    </div>
  )
}
