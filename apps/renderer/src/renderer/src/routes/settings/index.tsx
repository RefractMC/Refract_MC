import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { api, type AppConfig, type SafeAccount } from '@/lib/api'
import { useThemeStore } from '@/stores/theme'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import type { JavaInstallation } from '@refract/core'

export const Route = createFileRoute('/settings/')({
  component: Settings,
})

function javaVersionLabel(version: number): string {
  if (version >= 21) return 'Recommended for MC 1.20.5+'
  if (version >= 17) return 'Suitable for MC 1.18–1.20.4'
  if (version === 16) return 'Suitable for MC 1.17'
  return 'Suitable for MC ≤1.16.5'
}

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
  const [javas, setJavas] = useState<JavaInstallation[]>([])
  const [javaLoading, setJavaLoading] = useState(true)
  const avatars = useAvatarStore((s) => s.avatars)
  const setAvatarStore = useAvatarStore((s) => s.setAvatar)
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

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

  async function scanJava() {
    setJavaLoading(true)
    try { setJavas(await api.mc.java()) } catch { setJavas([]) }
    finally { setJavaLoading(false) }
  }

  useEffect(() => { void scanJava() }, [])

  async function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const uuid = pickingFor
    if (!file || !uuid) return
    try {
      const dataUrl = await compressImage(file, 200)
      setAvatarStore(uuid, dataUrl)
    } catch { /* ignore */ }
    e.target.value = ''
    setPickingFor(null)
  }

  function pickAvatar(uuid: string) {
    setPickingFor(uuid)
    avatarInputRef.current?.click()
  }

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
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleAvatarPick} />
            <div style={{ display:'grid', gap:14 }}>

              {/* Active profile hero row */}
              <div style={{ display:'flex', alignItems:'center', gap:14, padding:14, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:4 }}>
                <AvatarPicker
                  avatar={activeAccount ? avatars[activeAccount.uuid] : undefined}
                  initial={activeAccount?.username[0]?.toUpperCase() ?? '?'}
                  size={56}
                  onClick={() => activeAccount && pickAvatar(activeAccount.uuid)}
                  disabled={!activeAccount}
                />
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ color:'var(--ink)', fontWeight:700, fontSize:15 }}>
                    {activeAccount ? activeAccount.username : 'No active profile'}
                  </div>
                  <div style={{ color:'var(--ink-3)', fontSize:12, marginTop:3 }}>
                    {activeAccount
                      ? activeAccount.canPlayMinecraft
                        ? 'Java license verified through Microsoft.'
                        : 'Guest profile — browse mods and prepare instances.'
                      : 'Create a guest profile or sign in with Microsoft.'}
                  </div>
                  {activeAccount && (
                    <div style={{ fontSize:11, color:'var(--ink-4)', marginTop:4 }}>Click avatar to change profile picture</div>
                  )}
                </div>
                <Link
                  to="/account"
                  style={{
                    height:34, padding:'0 14px', display:'inline-flex', alignItems:'center',
                    background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)',
                    borderRadius:4, textDecoration:'none', fontSize:12, fontWeight:700, flexShrink:0,
                  }}
                >
                  Manage
                </Link>
              </div>

              {/* Account list */}
              <div style={{ display:'grid', gap:8 }}>
                {accounts.length === 0 ? (
                  <div style={{ color:'var(--ink-4)', fontSize:12 }}>No saved profiles.</div>
                ) : accounts.map((account) => {
                  const isActive = activeAccount?.uuid === account.uuid
                  return (
                    <div
                      key={account.uuid}
                      style={{
                        padding:'10px 12px', background:isActive ? 'var(--accent-tint)' : 'var(--bg)',
                        border:`1px solid ${isActive ? 'var(--accent)' : 'var(--border-r)'}`,
                        borderRadius:4, display:'flex', alignItems:'center', gap:10,
                      }}
                    >
                      <AvatarPicker
                        avatar={avatars[account.uuid]}
                        initial={account.username[0]?.toUpperCase() ?? '?'}
                        size={34}
                        onClick={() => pickAvatar(account.uuid)}
                      />
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ color:'var(--ink)', fontWeight:700, fontSize:13, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {account.username}
                        </div>
                        <div style={{ color:account.canPlayMinecraft ? 'var(--diamond)' : 'var(--gold)', fontSize:11, marginTop:2 }}>
                          {account.canPlayMinecraft ? 'Licensed Microsoft' : 'Guest content'}
                        </div>
                      </div>
                      {isActive && (
                        <div style={{ fontSize:11, fontFamily:"'VT323',monospace", letterSpacing:'.06em', color:'var(--accent)', flexShrink:0 }}>ACTIVE</div>
                      )}
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => setActive(account.uuid)}
                          disabled={!!busy}
                          style={smallButtonStyle(!!busy)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAccount(account.uuid)}
                        disabled={!!busy}
                        style={{ ...smallButtonStyle(!!busy), color:'var(--redstone)', background:'transparent', border:'1px solid rgba(217,59,59,.4)' }}
                      >
                        Sign out
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </Panel>

          <Panel title="Java Runtime">
            <div style={{ display:'grid', gap:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                <div style={{ color:'var(--ink-3)', fontSize:12 }}>
                  {javaLoading ? 'Scanning…' : javas.length === 0 ? 'No Java installations found.' : `${javas.length} installation${javas.length !== 1 ? 's' : ''} detected.`}
                </div>
                <button
                  type="button"
                  onClick={scanJava}
                  disabled={javaLoading}
                  style={{ ...smallButtonStyle(javaLoading), fontSize:11 }}
                >
                  {javaLoading ? 'Scanning…' : 'Re-scan'}
                </button>
              </div>

              {!javaLoading && javas.length === 0 && (
                <div style={{ padding:14, background:'rgba(217,59,59,.1)', border:'1px solid rgba(217,59,59,.35)', borderRadius:4 }}>
                  <div style={{ color:'var(--redstone)', fontWeight:700, fontSize:13, marginBottom:6 }}>Java not found</div>
                  <div style={{ color:'var(--ink-3)', fontSize:12, marginBottom:10, lineHeight:1.5 }}>
                    Refract needs Java 21 to run modern Minecraft. Download Adoptium Temurin (free, open-source).
                  </div>
                  <a
                    href="https://adoptium.net/temurin/releases/?version=21"
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6,
                      height:32, padding:'0 14px',
                      background:'var(--accent)', color:'#fff',
                      borderRadius:3, textDecoration:'none', fontSize:12, fontWeight:700,
                      boxShadow:'inset 0 -2px 0 var(--accent-lo)',
                    }}
                  >
                    Download Temurin 21 ↗
                  </a>
                </div>
              )}

              {javas.map((j, i) => {
                const label = javaVersionLabel(j.version)
                const isTop = i === 0
                return (
                  <div
                    key={j.path}
                    style={{
                      padding:'10px 12px',
                      background: isTop ? 'rgba(79,184,232,.07)' : 'var(--bg)',
                      border:`1px solid ${isTop ? 'var(--diamond)' : 'var(--border-r)'}`,
                      borderRadius:4,
                      display:'grid', gap:3,
                    }}
                  >
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontFamily:"'VT323',monospace", fontSize:16, color: isTop ? 'var(--diamond)' : 'var(--ink)', letterSpacing:'.04em' }}>
                        Java {j.version}
                      </span>
                      <span style={{ fontSize:11, color:'var(--ink-4)' }}>{j.vendor}</span>
                      {isTop && (
                        <span style={{ marginLeft:'auto', fontFamily:"'VT323',monospace", fontSize:12, letterSpacing:'.06em', color:'var(--diamond)' }}>
                          RECOMMENDED
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize:11, color:'var(--ink-4)', lineHeight:1.3 }}>{label}</div>
                    <div style={{ fontSize:10, color:'var(--ink-4)', fontFamily:'monospace', opacity:.7, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {j.path}
                    </div>
                  </div>
                )
              })}
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

function AvatarPicker({ avatar, initial, size, onClick, disabled }: { avatar?: string; initial: string; size: number; onClick: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => { if (!disabled) setHover(true) }}
      onMouseLeave={() => setHover(false)}
      style={{
        width:size, height:size, borderRadius:3, overflow:'hidden', flexShrink:0,
        border:`1px solid ${hover ? 'var(--accent)' : 'var(--border-r)'}`,
        background:'var(--surface-3)',
        cursor: disabled ? 'default' : 'pointer',
        position:'relative',
        transition:'border-color .14s',
      }}
    >
      {avatar
        ? <img src={avatar} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'VT323',monospace", fontSize:size * 0.45, color:'var(--ink-3)' }}>{initial}</div>
      }
      {hover && !disabled && (
        <div style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,.55)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily:"'VT323',monospace", fontSize:Math.max(10, size * 0.22), letterSpacing:'.06em', color:'#fff',
        }}>
          {size >= 48 ? 'CHANGE' : '✎'}
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
