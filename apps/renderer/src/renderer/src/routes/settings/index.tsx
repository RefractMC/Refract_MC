import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, type AppConfig, type SafeAccount } from '@/lib/api'
import { useThemeStore } from '@/stores/theme'

export const Route = createFileRoute('/settings/')({
  component: Settings,
})

const SIDEBAR_WIDTHS = [
  { label: 'Compact', value: '208px' },
  { label: 'Default', value: '232px' },
  { label: 'Wide', value: '268px' },
]

function Settings() {
  const activeThemeId = useThemeStore((state) => state.activeThemeId)
  const applyBuiltin = useThemeStore((state) => state.applyBuiltin)
  const layoutOverrides = useThemeStore((state) => state.layoutOverrides)
  const setLayoutOverride = useThemeStore((state) => state.setLayoutOverride)

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [accounts, setAccounts] = useState<SafeAccount[]>([])
  const [activeAccount, setActiveAccount] = useState<SafeAccount | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function refresh() {
    const [nextConfig, nextAccounts, nextActive] = await Promise.all([
      api.config.get(),
      api.auth.accounts(),
      api.auth.active(),
    ])
    setConfig(nextConfig)
    setAccounts(nextAccounts)
    setActiveAccount(nextActive)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2600)
  }

  async function chooseTheme(id: 'dark' | 'light') {
    setBusy(`theme-${id}`)
    setError(null)
    try {
      applyBuiltin(id)
      await api.config.set('activeThemeId', id)
      await refresh()
      showToast(`${id === 'dark' ? 'Dark' : 'Light'} theme applied.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  function chooseSidebarWidth(width: string) {
    setLayoutOverride({ sidebarWidth: width })
    showToast('Layout updated.')
  }

  async function setActive(uuid: string) {
    setBusy(`active-${uuid}`)
    setError(null)
    try {
      await api.auth.setActive(uuid)
      await refresh()
      showToast('Active profile updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function removeAccount(uuid: string) {
    setBusy(`remove-${uuid}`)
    setError(null)
    try {
      await api.auth.logout(uuid)
      await refresh()
      showToast('Profile removed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const sidebarWidth = layoutOverrides.sidebarWidth ?? '232px'
  const activeAccess = activeAccount?.canPlayMinecraft ? 'Minecraft play enabled' : 'Content access enabled'

  return (
    <div style={{ display:'grid', gap:18 }}>
      <div style={{ display:'flex', alignItems:'end', justifyContent:'space-between', gap:16 }}>
        <div>
          <h1 style={{ margin:0, color:'var(--ink)', fontSize:24, lineHeight:1.1 }}>Settings</h1>
          <p style={{ margin:'6px 0 0', color:'var(--ink-3)', fontSize:13 }}>
            Tune Refract, manage profiles, and keep guest content access separate from licensed play.
          </p>
        </div>
        <div style={{ color: activeAccount?.canPlayMinecraft ? 'var(--grass)' : 'var(--gold)', fontSize:12, fontWeight:700 }}>
          {activeAccess}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr) 360px', gap:18 }}>
        <div style={{ display:'grid', gap:14 }}>
          <Panel title="Appearance">
            <div style={{ display:'grid', gap:12 }}>
              <Field label="Theme" note="Changes apply immediately and are saved for the app.">
                <Segmented>
                  <SegmentButton active={activeThemeId === 'dark'} disabled={!!busy} onClick={() => chooseTheme('dark')}>
                    Dark
                  </SegmentButton>
                  <SegmentButton active={activeThemeId === 'light'} disabled={!!busy} onClick={() => chooseTheme('light')}>
                    Light
                  </SegmentButton>
                </Segmented>
              </Field>

              <Field label="Sidebar width" note="Adjusts the main navigation width.">
                <Segmented>
                  {SIDEBAR_WIDTHS.map((option) => (
                    <SegmentButton
                      key={option.value}
                      active={sidebarWidth === option.value}
                      disabled={!!busy}
                      onClick={() => chooseSidebarWidth(option.value)}
                    >
                      {option.label}
                    </SegmentButton>
                  ))}
                </Segmented>
              </Field>
            </div>
          </Panel>

          <Panel title="Account Access">
            <div style={{ display:'grid', gap:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:14 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ color:'var(--ink)', fontWeight:700 }}>
                    {activeAccount ? activeAccount.username : 'No active profile'}
                  </div>
                  <div style={{ color:'var(--ink-3)', fontSize:12, marginTop:4 }}>
                    {activeAccount
                      ? activeAccount.canPlayMinecraft
                        ? 'Java license verified through Microsoft.'
                        : 'Guest profile can browse mods and prepare instances.'
                      : 'Create a guest profile or sign in with Microsoft.'}
                  </div>
                </div>
                <Link
                  to="/account"
                  style={{
                    height:34, padding:'0 14px', display:'inline-flex', alignItems:'center',
                    background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)',
                    borderRadius:4, textDecoration:'none', fontSize:12, fontWeight:700,
                  }}
                >
                  Open login
                </Link>
              </div>

              <div style={{ display:'grid', gap:8 }}>
                {accounts.length === 0 ? (
                  <div style={{ color:'var(--ink-4)', fontSize:12 }}>No saved profiles.</div>
                ) : accounts.map((account) => {
                  const isActive = activeAccount?.uuid === account.uuid
                  return (
                    <div
                      key={account.uuid}
                      style={{
                        padding:12, background:isActive ? 'var(--accent-tint)' : 'var(--bg)',
                        border:`1px solid ${isActive ? 'var(--accent)' : 'var(--border-r)'}`,
                        borderRadius:4, display:'flex', alignItems:'center', gap:12,
                      }}
                    >
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ color:'var(--ink)', fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {account.username}
                        </div>
                        <div style={{ color:account.canPlayMinecraft ? 'var(--diamond)' : 'var(--gold)', fontSize:11, marginTop:3 }}>
                          {account.canPlayMinecraft ? 'Licensed Microsoft' : 'Guest content'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActive(account.uuid)}
                        disabled={isActive || !!busy}
                        style={smallButtonStyle(isActive || !!busy)}
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        onClick={() => removeAccount(account.uuid)}
                        disabled={!!busy}
                        style={{ ...smallButtonStyle(!!busy), color:'var(--redstone)', background:'transparent', border:'1px solid rgba(217,59,59,.45)' }}
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </Panel>
        </div>

        <aside style={{ display:'grid', gap:14, alignContent:'start' }}>
          <Panel title="Launcher State">
            <Stat label="Active theme" value={activeThemeId} />
            <Stat label="Profiles" value={String(accounts.length)} />
            <Stat label="Window" value={config ? `${config.windowBounds.width} x ${config.windowBounds.height}` : 'Loading'} />
          </Panel>

          <Panel title="Play Rules">
            <div style={{ color:'var(--ink-3)', fontSize:12, lineHeight:1.55 }}>
              Guest profiles can browse and stage mods, create instances, and manage local content. Minecraft play is enabled only after Microsoft login verifies Java Edition ownership.
            </div>
          </Panel>
        </aside>
      </div>

      {error && (
        <div style={{ padding:12, color:'#fff', background:'rgba(217,59,59,.18)', border:'1px solid var(--redstone)', borderRadius:4, fontSize:13 }}>
          {error}
        </div>
      )}

      {toast && (
        <div style={{
          position:'fixed', bottom:44, left:'50%', transform:'translateX(-50%)',
          padding:'10px 18px', background:'var(--surface-2)', border:'1px solid var(--border-r)',
          borderRadius:'var(--radius)', boxShadow:'0 8px 24px rgba(0,0,0,.5)',
          color:'var(--ink)', fontSize:13, zIndex:50,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius)', overflow:'hidden' }}>
      <div style={{ padding:'13px 16px', borderBottom:'1px solid var(--line)', color:'var(--ink)', fontWeight:700 }}>{title}</div>
      <div style={{ padding:16 }}>{children}</div>
    </section>
  )
}

function Field({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'180px minmax(0, 1fr)', gap:16, alignItems:'center' }}>
      <div>
        <div style={{ color:'var(--ink)', fontWeight:700, fontSize:13 }}>{label}</div>
        <div style={{ color:'var(--ink-4)', fontSize:11, lineHeight:1.35, marginTop:3 }}>{note}</div>
      </div>
      {children}
    </div>
  )
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display:'inline-flex', width:'fit-content', background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:4, padding:3, gap:3 }}>
      {children}
    </div>
  )
}

function SegmentButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        height:30, minWidth:82, padding:'0 12px',
        background:active ? 'var(--accent)' : 'transparent',
        color:active ? '#fff' : 'var(--ink-2)',
        border:'none', borderRadius:3,
        cursor:disabled ? 'not-allowed' : 'pointer',
        opacity:disabled ? .65 : 1,
        fontSize:12, fontWeight:700,
      }}
    >
      {children}
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:12, padding:'7px 0', borderBottom:'1px solid var(--line)' }}>
      <span style={{ color:'var(--ink-4)', fontSize:12 }}>{label}</span>
      <span style={{ color:'var(--ink)', fontSize:12, fontWeight:700, textTransform:'capitalize' }}>{value}</span>
    </div>
  )
}

function smallButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height:30, padding:'0 12px',
    background:'var(--surface-3)', color:'var(--ink)',
    border:'1px solid var(--border-r)', borderRadius:4,
    cursor:disabled ? 'not-allowed' : 'pointer',
    opacity:disabled ? .55 : 1,
    fontSize:12, fontWeight:700,
  }
}
