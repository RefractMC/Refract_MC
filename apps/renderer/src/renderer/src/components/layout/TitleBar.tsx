import { useRouterState } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { BellIcon } from '../ui/BlockIcons'

const CRUMBS: Record<string, string> = {
  '/':           'Instance Library',
  '/browse/':    'Browse Mods',
  '/modpacks/':  'Modpacks',
  '/account/':   'Account',
  '/settings/':  'Settings',
}

const traffic: Array<{ color: string; action: () => void }> = [
  { color: '#ff5f57', action: () => api.window.close()    },
  { color: '#febc2e', action: () => api.window.minimize() },
  { color: '#28c840', action: () => api.window.maximize() },
]

export function TitleBar() {
  const pathname = useRouterState({ select: s => s.location.pathname })
  const crumb = CRUMBS[pathname] ?? ''

  return (
    <div
      className="drag-region"
      style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px',
        background: 'var(--sb)',
        borderBottom: '1px solid var(--line)',
        color: 'var(--ink-3)',
        fontSize: 11.5, fontWeight: 500, letterSpacing: '.01em',
        userSelect: 'none',
      }}
    >
      {/* macOS-style traffic lights */}
      <div className="no-drag-region" style={{ display:'flex', gap:8, alignItems:'center' }}>
        {traffic.map((t, i) => (
          <button key={i} onClick={t.action} style={{ width:11, height:11, borderRadius:'50%', background:t.color, border:'1px solid rgba(0,0,0,.4)', cursor:'default', padding:0, flexShrink:0 }} />
        ))}
      </div>

      {/* Logo + breadcrumb */}
      <div style={{ marginLeft:12, display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:14, height:14, background:'linear-gradient(135deg, var(--accent-hi) 0% 50%, var(--accent) 50% 100%)', boxShadow:'inset 0 0 0 1px rgba(0,0,0,.4)' }} />
        <b style={{ color:'var(--ink)', fontWeight:600 }}>Refract</b>
        {crumb && <span style={{ color:'var(--ink-3)' }}>/ {crumb}</span>}
      </div>

      <div style={{ flex:1 }} />

      <div className="no-drag-region" style={{ display:'flex', gap:4, color:'var(--ink-3)' }}>
        <div style={{ width:26, height:26, borderRadius:4, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <BellIcon />
        </div>
      </div>
    </div>
  )
}
