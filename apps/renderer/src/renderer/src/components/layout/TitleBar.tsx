import { useEffect, useRef, useState } from 'react'
import { Bell } from '@/components/ui/Icon'
import { api } from '@/lib/api'
import { useT, type T } from '@/i18n'

const LAST_SEEN_KEY = 'refract.notifications.lastSeen'

function timeAgo(ts: number, t: T['titleBar']): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return t.justNow
  if (s < 3600) return t.minutesAgo(Math.floor(s / 60))
  if (s < 86400) return t.hoursAgo(Math.floor(s / 3600))
  return t.daysAgo(Math.floor(s / 86400))
}

function WinBtn({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      className="no-drag-region"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 46, height: '100%',
        background: hover ? (danger ? '#c42b1c' : 'rgba(255,255,255,.08)') : 'var(--chrome-top)',
        border: 'none', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: hover && danger ? '#fff' : 'var(--ink-3)',
        flexShrink: 0,
        transition: 'background 80ms',
      }}
    >
      {children}
    </button>
  )
}

type ActivityEntry = { id: string; label: string; ts: number }

type UpdateState = {
  version: string
  phase: 'pending' | 'downloading' | 'ready' | 'installing' | 'error'
  percent: number
  failedAction?: 'download' | 'install'
  error?: string
}

export function TitleBar() {
  const t = useT()
  const [isMaximized, setIsMaximized] = useState(false)
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [lastSeen, setLastSeen] = useState<number>(() => Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0))
  const [bellHover, setBellHover] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)

  useEffect(() => {
    api.window.isMaximized().then(setIsMaximized).catch(() => {})
    return api.window.onMaximizedChange(setIsMaximized)
  }, [])

  useEffect(() => {
    if (!__APP_UPDATER_ENABLED__) return
    const unA = api.updater.onAvailable(({ version }) => {
      setUpdate({ version, phase: 'pending', percent: 0 })
    })
    const unP = api.updater.onProgress(({ percent }) => setUpdate(u => u ? { ...u, phase: 'downloading', percent } : null))
    const unD = api.updater.onDownloaded(() => setUpdate(u => u ? { ...u, phase: 'ready', percent: 100 } : null))
    return () => { unA(); unP(); unD() }
  }, [])

  useEffect(() => {
    api.activity.list().then(setEntries).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function togglePanel() {
    if (!open) {
      const now = Date.now()
      localStorage.setItem(LAST_SEEN_KEY, String(now))
      setLastSeen(now)
    }
    setOpen(v => !v)
  }

  const unread = entries.filter(e => e.ts > lastSeen).length

  function startDragging(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('.no-drag-region')) return
    api.window.startDragging()
  }

  async function downloadUpdate() {
    setUpdate(current => current ? { ...current, phase: 'downloading', percent: 0 } : null)
    try {
      await api.updater.download()
    } catch (error) {
      setUpdate(current => current ? {
        ...current,
        phase: 'error',
        failedAction: 'download',
        error: error instanceof Error ? error.message : String(error),
      } : null)
    }
  }

  async function installUpdate() {
    setUpdate(current => current ? { ...current, phase: 'installing' } : null)
    try {
      await api.updater.install()
    } catch (error) {
      setUpdate(current => current ? {
        ...current,
        phase: 'error',
        failedAction: 'install',
        error: error instanceof Error ? error.message : String(error),
      } : null)
    }
  }

  return (
    <div
      className="drag-region launcher-titlebar"
      onMouseDown={startDragging}
      style={{
        gridRow: '1 / 2',
        gridColumn: '2 / 3',
        display: 'flex', alignItems: 'center',
        height: '100%',
        background: 'var(--chrome-top)',
        borderBottom: '1px solid rgba(166, 181, 214, .12)',
        color: 'var(--ink-3)',
        fontSize: 11.5, fontWeight: 600, letterSpacing: '.01em',
        userSelect: 'none',
        position: 'relative',
        zIndex: 4,
      }}
    >
      <div style={{ flex: 1 }} />

      {/* Update chip */}
      {update && (
        <div className="no-drag-region" style={{
          display: 'flex', alignItems: 'center', gap: 8, marginRight: 6, padding: '0 8px', height: 22, borderRadius: 'var(--radius-sm)',
          background: update.phase === 'ready' ? 'rgba(74,222,128,.12)' : 'rgba(255,255,255,.06)',
        }}>
          {update.phase === 'ready' ? (
            <>
              <span style={{ fontSize: 10, color: 'var(--grass)', fontWeight: 600 }}>{t.titleBar.versionDownloaded(update.version)}</span>
              <button onClick={() => void installUpdate()} style={{ height: 16, padding: '0 6px', fontSize: 10, fontWeight: 700, background: 'var(--grass)', color: '#000', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1 }}>
                {t.titleBar.restartNow}
              </button>
              <button onClick={() => setUpdate(null)} title={t.titleBar.restartLater} style={{ height: 16, padding: '0 6px', fontSize: 10, fontWeight: 700, background: 'transparent', color: 'var(--ink-4)', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1 }}>
                {t.titleBar.later}
              </button>
            </>
          ) : update.phase === 'installing' ? (
            <span style={{ fontSize: 10, color: 'var(--grass)', fontWeight: 600 }}>
              {t.titleBar.installing}
            </span>
          ) : update.phase === 'downloading' ? (
            <>
              <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>v{update.version}</span>
              <div style={{ width: 48, height: 3, background: 'var(--surface-3)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${update.percent}%`, background: 'var(--accent)', transition: 'width 300ms linear', borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--ink-4)', minWidth: 26, textAlign: 'right' }}>{update.percent}%</span>
            </>
          ) : update.phase === 'error' ? (
            <>
              <span
                title={update.error}
                style={{ fontSize: 10, color: 'var(--lava)', fontWeight: 600 }}
              >
                {t.titleBar.updateFailed}
              </span>
              <button
                onClick={() => void (update.failedAction === 'install' ? installUpdate() : downloadUpdate())}
                style={{ height: 16, padding: '0 6px', fontSize: 10, fontWeight: 700, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1 }}
              >
                {t.titleBar.retry}
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 10, color: 'var(--ink-3)', fontWeight: 600 }}>{t.titleBar.versionAvailable(update.version)}</span>
              <button onClick={() => void downloadUpdate()} style={{ height: 16, padding: '0 6px', fontSize: 10, fontWeight: 700, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', lineHeight: 1 }}>
                {t.titleBar.update}
              </button>
              <button onClick={() => setUpdate(null)} title={t.titleBar.stayCurrent} style={{ height: 16, width: 16, fontSize: 12, background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {/* Activity */}
      <div className="no-drag-region" style={{ position: 'relative', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }} ref={panelRef}>
        <button
          onClick={togglePanel}
          title={t.titleBar.activity}
          aria-label={t.titleBar.activity}
          onMouseEnter={() => setBellHover(true)}
          onMouseLeave={() => setBellHover(false)}
          style={{
            width: 46, height: '100%', borderRadius: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: bellHover ? 'rgba(255,255,255,.08)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: open || unread > 0 ? 'var(--accent)' : 'var(--ink-3)',
            position: 'relative',
            opacity: open || unread > 0 ? 1 : 0.82,
            padding: 0,
            transition: 'background 80ms',
          }}
        >
          <Bell size={16} strokeWidth={1.8} />
          {unread > 0 && (
            <span style={{
              position: 'absolute', top: 4, right: 5,
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--accent)',
              border: '1.5px solid var(--chrome-top)',
            }} />
          )}
        </button>

        {open && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0,
            width: 260,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-r)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-floating)',
            zIndex: 9999,
            overflow: 'hidden',
          }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink-2)', letterSpacing: '.08em', textTransform: 'uppercase' }}>
                {t.titleBar.activity}
              </span>
              {entries.length > 0 && (
                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, color: 'var(--ink-4)' }}>
                  {entries.length}
                </span>
              )}
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {entries.length === 0 ? (
                <div style={{ margin: 12, minHeight: 76, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-r)', borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>
                  {t.titleBar.noRecentActivity}
                </div>
              ) : entries.slice(0, 20).map((entry, index) => (
                <div key={entry.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '8px minmax(0, 1fr) auto',
                  alignItems: 'center',
                  padding: '7px 12px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--line)',
                  gap: 10,
                }}>
                  <span style={{ width: 6, height: 6, background: index === 0 ? 'var(--accent)' : 'var(--surface-3)' }} />
                  <span style={{ fontSize: 12, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {entry.label}
                  </span>
                  <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, color: 'var(--ink-4)', flexShrink: 0 }}>
                    {timeAgo(entry.ts, t.titleBar)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Windows-style controls */}
      <div className="no-drag-region" style={{ display: 'flex', alignSelf: 'stretch', background: 'var(--chrome-top)' }}>
        <WinBtn onClick={() => api.window.minimize()}>
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </WinBtn>
        <WinBtn onClick={() => api.window.maximize()}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="0" width="8" height="8"/>
              <polyline points="0,2 0,10 8,10"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0" y="0" width="10" height="10"/>
            </svg>
          )}
        </WinBtn>
        <WinBtn onClick={() => api.window.close()} danger>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
            <line x1="0" y1="0" x2="10" y2="10"/>
            <line x1="10" y1="0" x2="0" y2="10"/>
          </svg>
        </WinBtn>
      </div>
    </div>
  )
}
