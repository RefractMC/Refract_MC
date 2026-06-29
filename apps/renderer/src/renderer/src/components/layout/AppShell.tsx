import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { Info, X } from 'lucide-react'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

function MigrationNotice120({ onDismiss }: { onDismiss: () => void }) {
  const t = useT()

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
        alignItems: 'center',
        gap: 10,
        margin: '14px 28px 0',
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        background: 'color-mix(in srgb, var(--diamond) 14%, var(--surface))',
        color: 'var(--ink)',
        minWidth: 0,
      }}
    >
      <Info size={17} color="var(--diamond)" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 750, color: 'var(--ink)' }}>{t.migration.title}</div>
        <div style={{ marginTop: 2, fontSize: 12, lineHeight: 1.45, color: 'var(--ink-3)' }}>
          {t.migration.body}
        </div>
      </div>
      <Link
        to="/account"
        onClick={onDismiss}
        style={{
          justifySelf: 'end',
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          fontSize: 12,
          fontWeight: 750,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {t.migration.openAccounts}
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t.migration.dismiss}
        title={t.migration.dismiss}
        style={{
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          color: 'var(--ink-3)',
          cursor: 'pointer',
        }}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [showMigrationNotice, setShowMigrationNotice] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.config.get()
      .then((cfg) => {
        if (!cancelled && cfg.migrationNotice120Shown !== true) setShowMigrationNotice(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  function dismissMigrationNotice() {
    setShowMigrationNotice(false)
    api.config.set('migrationNotice120Shown', true).catch(() => {})
  }
  return (
    <div className="launcher-root" style={{
      height: '100dvh',
      display: 'grid',
      gridTemplateColumns: 'var(--sidebar-width) 1fr',
      gridTemplateRows: 'var(--titlebar-height) 1fr',
      overflow: 'hidden',
      transition: 'grid-template-columns 220ms cubic-bezier(.4,0,.2,1)',
      background: 'transparent',
      position: 'relative',
      zIndex: 1,
    }}>
      <div
        aria-hidden="true"
        className="chrome-top-fill"
        style={{
          gridRow: '1 / 2',
          gridColumn: '1 / -1',
          background: 'var(--chrome-top)',
          borderBottom: '1px solid rgba(166, 181, 214, .12)',
          position: 'relative',
          zIndex: 2,
        }}
      />
      <TitleBar />
      <Sidebar />
      <div style={{ gridRow:'2/3', gridColumn:'2/3', display:'flex', flexDirection:'column', minHeight:0, minWidth:0, overflow:'hidden', background:'transparent', position:'relative' }}>
        {showMigrationNotice && <MigrationNotice120 onDismiss={dismissMigrationNotice} />}
        <div
          key={pathname}
          className="app-scroll"
          // `backwards` (not `both`): the entrance animation must NOT persist a
          // transform — a lingering transform makes this the containing block for
          // position:fixed modals, so they'd center on the scroller (off-screen,
          // scrollable) instead of the viewport.
          style={{ flex:1, minHeight:0, overflowY:'auto', overflowX:'hidden', padding: showMigrationNotice ? '16px 28px 28px' : '24px 28px 28px', position:'relative', zIndex:1, animation:'page-enter 160ms ease-out backwards' }}
        >
          {children}
        </div>
        <StatusBar />
      </div>
    </div>
  )
}
