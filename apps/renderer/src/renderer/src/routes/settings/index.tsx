import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { api, type AppConfig, type SafeAccount } from '@/lib/api'
import { useThemeStore } from '@/stores/theme'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import type { JavaInstallation } from '@refract/core'
import { useT } from '@/i18n'
import { useLanguageStore } from '@/stores/language'

export const Route = createFileRoute('/settings/')({
  component: Settings,
})

const SIDEBAR_WIDTHS_VALUES = ['208px', '232px', '268px'] as const

function Settings() {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  const setLang = useLanguageStore((s) => s.setLang)
  const activeThemeId = useThemeStore((state) => state.activeThemeId)
  const applyBuiltin = useThemeStore((state) => state.applyBuiltin)
  const layoutOverrides = useThemeStore((state) => state.layoutOverrides)
  const setLayoutOverride = useThemeStore((state) => state.setLayoutOverride)
  const accentColor = useThemeStore((state) => state.accentColor)
  const setAccentColor = useThemeStore((state) => state.setAccentColor)

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [accounts, setAccounts] = useState<SafeAccount[]>([])
  const [activeAccount, setActiveAccount] = useState<SafeAccount | null>(null)
  const [cfKeyDraft, setCfKeyDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [memoryMb, setMemoryMb] = useState<number>(2048)
  const [memoryMaxMb, setMemoryMaxMb] = useState<number>(16384)
  const memorySaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [javas, setJavas] = useState<JavaInstallation[]>([])
  const [managedJavas, setManagedJavas] = useState<JavaInstallation[]>([])
  const [javaLoading, setJavaLoading] = useState(true)
  const [javaDownloading, setJavaDownloading] = useState<Map<number, { step: string; percent: number }>>(new Map())
  const [customPathInput, setCustomPathInput] = useState('')
  const [addingCustom, setAddingCustom] = useState(false)
  const [customError, setCustomError] = useState<string | null>(null)
  const [logs, setLogs] = useState<Array<{ time: string; level: 'info' | 'warn' | 'error'; source: string; message: string }>>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const avatars = useAvatarStore((s) => s.avatars)
  const setAvatarStore = useAvatarStore((s) => s.setAvatar)
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  async function loadLogs() {
    setLogsLoading(true)
    try { setLogs(await api.log.read(150)) } catch { /* ignore */ } finally { setLogsLoading(false) }
  }

  async function clearLogs() {
    await api.log.clear().catch(() => {})
    setLogs([])
  }

  async function refresh() {
    const [nextConfig, nextAccounts, nextActive] = await Promise.all([
      api.config.get(),
      api.auth.accounts(),
      api.auth.active(),
    ])
    setConfig(nextConfig)
    setMemoryMb(nextConfig.defaultMemoryMb ?? 2048)
    setCfKeyDraft(nextConfig.curseforgeApiKey ?? '')
    setAccounts(nextAccounts)
    setActiveAccount(nextActive)
  }

  function handleMemoryChange(mb: number) {
    setMemoryMb(mb)
    if (memorySaveTimeout.current) clearTimeout(memorySaveTimeout.current)
    memorySaveTimeout.current = setTimeout(() => {
      api.config.set('defaultMemoryMb', mb).catch(() => {})
    }, 400)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    api.system.ramGb().then(gb => setMemoryMaxMb(Math.max(1024, gb * 1024))).catch(() => {})
  }, [])

  async function scanJava() {
    setJavaLoading(true)
    try {
      const [all, managed] = await Promise.all([api.mc.java(), api.java.managedList()])
      setJavas(all)
      setManagedJavas(managed)
    } catch { setJavas([]); setManagedJavas([]) }
    finally { setJavaLoading(false) }
  }

  async function deleteJava(major: number) {
    await api.java.delete(major)
    await scanJava()
    showToast(`Java ${major} removed.`)
  }

  async function browseAndAddCustomJava() {
    const path = await api.java.browseExe()
    if (path) setCustomPathInput(path)
  }

  async function addCustomJava() {
    const path = customPathInput.trim()
    if (!path) return
    setAddingCustom(true)
    setCustomError(null)
    try {
      await api.java.addCustom(path)
      setCustomPathInput('')
      await scanJava()
      showToast('Custom Java added.')
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingCustom(false)
    }
  }

  async function removeCustomJava(javaPath: string) {
    await api.java.removeCustom(javaPath)
    await scanJava()
    showToast('Custom Java removed.')
  }

  async function downloadJava(major: number) {
    if (javaDownloading.has(major)) return
    setJavaDownloading(prev => new Map(prev).set(major, { step: 'Starting…', percent: 0 }))
    try {
      await api.java.download(major)
      await scanJava()
      showToast(t.settings.javaInstalled(major))
    } catch (e) {
      showToast(t.settings.javaFailed(major, e instanceof Error ? e.message : String(e)))
    } finally {
      setJavaDownloading(prev => { const n = new Map(prev); n.delete(major); return n })
    }
  }

  useEffect(() => {
    const unsub = api.java.onProgress(({ major, step, percent }) => {
      setJavaDownloading(prev => new Map(prev).set(major, { step, percent }))
    })
    return () => unsub()
  }, [])

  useEffect(() => { void scanJava() }, [])
  useEffect(() => { void loadLogs() }, [])

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
      showToast(id === 'dark' ? t.settings.themeDark : t.settings.themeLight)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  function chooseSidebarWidth(width: string) {
    setLayoutOverride({ sidebarWidth: width })
    showToast(t.settings.layoutUpdated)
  }

  async function setActive(uuid: string) {
    setBusy(`active-${uuid}`)
    setError(null)
    try {
      await api.auth.setActive(uuid)
      await refresh()
      showToast(t.settings.activeProfileUpdated)
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
      showToast(t.settings.profileRemoved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const sidebarWidth = layoutOverrides.sidebarWidth ?? '232px'
  const activeAccess = activeAccount?.canPlayMinecraft ? t.settings.playEnabled : activeAccount ? t.settings.offlineEnabled : t.settings.noActiveProfile
  const sidebarWidthLabels = [t.settings.compact, t.settings.sidebarDefault, t.settings.wide]

  return (
    <div style={{ display:'grid', gap:18 }}>
      <div style={{ display:'flex', alignItems:'end', justifyContent:'space-between', gap:16 }}>
        <div>
          <h1 style={{ margin:0, color:'var(--ink)', fontSize:24, lineHeight:1.1 }}>{t.settings.title}</h1>
          <p style={{ margin:'6px 0 0', color:'var(--ink-3)', fontSize:13 }}>
            {t.settings.subtitle}
          </p>
        </div>
        <div style={{ color: activeAccount?.canPlayMinecraft ? 'var(--grass)' : 'var(--gold)', fontSize:12, fontWeight:700 }}>
          {activeAccess}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr) 360px', gap:18 }}>
        <div style={{ display:'grid', gap:14 }}>
          <Panel title={t.settings.appearance}>
            <div style={{ display:'grid', gap:12 }}>
              <Field label="Accent color" note="Pick any colour — or reset to the default theme green.">
                <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                  {[
                    { hex:'#5b9c3a', label:'Default green' },
                    { hex:'#5316D4', label:'Refract purple' },
                    { hex:'#3b82f6', label:'Blue' },
                    { hex:'#f97316', label:'Orange' },
                    { hex:'#ef4444', label:'Red' },
                    { hex:'#ec4899', label:'Pink' },
                    { hex:'#14b8a6', label:'Teal' },
                  ].map(({ hex, label }) => (
                    <button
                      key={hex}
                      title={label}
                      onClick={() => { setAccentColor(hex); showToast('Accent colour applied.') }}
                      style={{
                        width:22, height:22, borderRadius:'50%', background:hex, border:'none', cursor:'pointer', flexShrink:0, padding:0,
                        boxShadow: accentColor === hex ? `0 0 0 2px var(--surface), 0 0 0 4px ${hex}` : 'none',
                        transition:'box-shadow 120ms',
                      }}
                    />
                  ))}
                  <input
                    type="color"
                    value={accentColor ?? '#5b9c3a'}
                    onChange={e => setAccentColor(e.target.value)}
                    title="Custom colour"
                    style={{ width:30, height:22, padding:0, border:'1px solid var(--border-r)', borderRadius:3, cursor:'pointer', background:'none' }}
                  />
                  {accentColor && (
                    <button
                      onClick={() => { setAccentColor(null); showToast('Accent colour reset.') }}
                      style={{ fontSize:11, color:'var(--ink-4)', background:'none', border:'1px solid var(--border-r)', borderRadius:3, padding:'2px 8px', cursor:'pointer' }}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </Field>

              <Field label={t.settings.theme} note={t.settings.themeNote}>
                <Segmented>
                  <SegmentButton active={activeThemeId === 'dark'} disabled={!!busy} onClick={() => chooseTheme('dark')}>
                    {t.settings.dark}
                  </SegmentButton>
                  <SegmentButton active={activeThemeId === 'light'} disabled={!!busy} onClick={() => chooseTheme('light')}>
                    {t.settings.light}
                  </SegmentButton>
                </Segmented>
              </Field>

              <Field label={t.settings.memory} note={t.settings.memoryNote}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input
                    type="range"
                    min={512} max={memoryMaxMb} step={512}
                    value={memoryMb}
                    onChange={(e) => handleMemoryChange(Number(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <span style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: 'var(--ink)', minWidth: 56, textAlign: 'right', lineHeight: 1 }}>
                    {memoryMb >= 1024 ? `${memoryMb / 1024}GB` : `${memoryMb}MB`}
                  </span>
                </div>
              </Field>

              <Field label={t.settings.sidebarWidth} note={t.settings.sidebarNote}>
                <Segmented>
                  {SIDEBAR_WIDTHS_VALUES.map((value, i) => (
                    <SegmentButton
                      key={value}
                      active={sidebarWidth === value}
                      disabled={!!busy}
                      onClick={() => chooseSidebarWidth(value)}
                    >
                      {sidebarWidthLabels[i]}
                    </SegmentButton>
                  ))}
                </Segmented>
              </Field>

              <Field label={t.settings.language} note={t.settings.languageNote}>
                <Segmented>
                  <SegmentButton active={lang === 'en'} disabled={false} onClick={() => setLang('en')}>
                    {t.settings.langEn}
                  </SegmentButton>
                  <SegmentButton active={lang === 'uk'} disabled={false} onClick={() => setLang('uk')}>
                    {t.settings.langUk}
                  </SegmentButton>
                </Segmented>
              </Field>

              <Field label={t.settings.curseforgeKey} note={t.settings.curseforgeKeyNote}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="password"
                    value={cfKeyDraft}
                    onChange={e => setCfKeyDraft(e.target.value)}
                    placeholder={t.settings.curseforgeKeyPlaceholder}
                    style={{
                      flex: 1, height: 32, padding: '0 10px',
                      background: 'var(--bg)', border: '1px solid var(--border-r)',
                      borderRadius: 3, color: 'var(--ink)', fontSize: 12, outline: 'none',
                    }}
                  />
                  <button
                    onClick={async () => {
                      await api.config.set('curseforgeApiKey', cfKeyDraft.trim() || undefined)
                      showToast(t.settings.curseforgeKeySaved)
                    }}
                    style={{
                      height: 32, padding: '0 14px', fontSize: 12, fontWeight: 600,
                      background: 'var(--accent)', color: '#fff', border: 'none',
                      borderRadius: 3, cursor: 'pointer',
                    }}
                  >
                    {t.account.save}
                  </button>
                </div>
              </Field>
            </div>
          </Panel>

          <Panel title={t.settings.accountAccess}>
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
                    {activeAccount ? activeAccount.username : t.settings.noActiveProfile}
                  </div>
                  <div style={{ color:'var(--ink-3)', fontSize:12, marginTop:3 }}>
                    {activeAccount
                      ? activeAccount.canPlayMinecraft
                        ? t.settings.licenseVerified
                        : t.settings.offlineProfile
                      : t.settings.noProfileCreate}
                  </div>
                  {activeAccount && (
                    <div style={{ fontSize:11, color:'var(--ink-4)', marginTop:4 }}>{t.settings.clickAvatarChange}</div>
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
                  {t.settings.manage}
                </Link>
              </div>

              {/* Account list */}
              <div style={{ display:'grid', gap:8 }}>
                {accounts.length === 0 ? (
                  <div style={{ color:'var(--ink-4)', fontSize:12 }}>{t.settings.noSavedProfiles}</div>
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
                          {account.canPlayMinecraft ? t.settings.microsoftLicensed : t.settings.offlinePlay}
                        </div>
                      </div>
                      {isActive && (
                        <div style={{ fontSize:11, fontFamily:"'VT323',monospace", letterSpacing:'.06em', color:'var(--accent)', flexShrink:0 }}>{t.settings.activeLabel}</div>
                      )}
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => setActive(account.uuid)}
                          disabled={!!busy}
                          style={smallButtonStyle(!!busy)}
                        >
                          {t.settings.use}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAccount(account.uuid)}
                        disabled={!!busy}
                        style={{ ...smallButtonStyle(!!busy), color:'var(--redstone)', background:'transparent', border:'1px solid rgba(217,59,59,.4)' }}
                      >
                        {t.settings.signOut}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </Panel>

          <Panel title={t.settings.javaRuntime}>
            <div style={{ display:'grid', gap:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                <div style={{ color:'var(--ink-3)', fontSize:12 }}>
                  {javaLoading ? t.settings.scanning : javas.length === 0 ? t.settings.noJava : t.settings.javaDetected(javas.length)}
                </div>
                <button
                  type="button"
                  onClick={scanJava}
                  disabled={javaLoading}
                  style={{ ...smallButtonStyle(javaLoading), fontSize:11 }}
                >
                  {javaLoading ? t.settings.scanning : t.settings.rescan}
                </button>
              </div>

              {/* Download needed Java versions */}
              {([8, 17, 21] as const).map(major => {
                const available = javas.some(j => j.version >= major && (major === 8 ? j.version < 17 : major === 17 ? j.version < 21 : true))
                const downloading = javaDownloading.get(major)
                if (available || (!downloading && javas.some(j => j.version === major))) return null
                return (
                  <div key={major} style={{ padding:'10px 12px', background:'rgba(255,255,255,.03)', border:'1px solid var(--border-r)', borderRadius:4 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                      <div>
                        <div style={{ fontFamily:"'VT323',monospace", fontSize:14, color:'var(--ink)', letterSpacing:'.04em' }}>Java {major}</div>
                        <div style={{ fontSize:11, color:'var(--ink-4)', marginTop:2 }}>{t.settings.javaVersionLabel(major)}</div>
                      </div>
                      {downloading ? (
                        <div style={{ fontSize:11, color:'var(--ink-3)', textAlign:'right', minWidth:100 }}>{downloading.step}</div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => downloadJava(major)}
                          style={{ ...smallButtonStyle(false), background:'var(--accent)', color:'#fff', border:'none', fontSize:11 }}
                        >
                          {t.settings.download}
                        </button>
                      )}
                    </div>
                    {downloading && (
                      <div style={{ marginTop:8, height:4, background:'var(--surface-3)', borderRadius:2, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${downloading.percent}%`, background:'var(--accent)', transition:'width 200ms linear', borderRadius:2 }} />
                      </div>
                    )}
                  </div>
                )
              })}

              {javas.map((j, i) => {
                const label = t.settings.javaVersionLabel(j.version)
                const isTop = i === 0
                const managedEntry = managedJavas.find(m => m.path === j.path) as (JavaInstallation & { custom?: boolean }) | undefined
                const isCustom  = !!managedEntry?.custom
                const isManaged = !!managedEntry && !isCustom
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
                      {isManaged && (
                        <span style={{ fontSize:10, color:'var(--accent)', background:'rgba(83,22,212,.15)', border:'1px solid rgba(83,22,212,.3)', borderRadius:3, padding:'1px 5px' }}>
                          managed
                        </span>
                      )}
                      {isCustom && (
                        <span style={{ fontSize:10, color:'var(--gold)', background:'rgba(228,179,59,.12)', border:'1px solid rgba(228,179,59,.35)', borderRadius:3, padding:'1px 5px' }}>
                          custom
                        </span>
                      )}
                      <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
                        {isTop && (
                          <span style={{ fontFamily:"'VT323',monospace", fontSize:12, letterSpacing:'.06em', color:'var(--diamond)' }}>
                            {t.settings.bestMatch}
                          </span>
                        )}
                        {isManaged && (
                          <button
                            type="button"
                            onClick={() => deleteJava(j.version)}
                            style={{ fontSize:10, padding:'2px 7px', background:'transparent', border:'1px solid var(--border-r)', borderRadius:3, color:'var(--ink-4)', cursor:'pointer' }}
                          >
                            Remove
                          </button>
                        )}
                        {isCustom && (
                          <button
                            type="button"
                            onClick={() => removeCustomJava(j.path)}
                            style={{ fontSize:10, padding:'2px 7px', background:'transparent', border:'1px solid var(--border-r)', borderRadius:3, color:'var(--ink-4)', cursor:'pointer' }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize:11, color:'var(--ink-4)', lineHeight:1.3 }}>{label}</div>
                    <div style={{ fontSize:10, color:'var(--ink-4)', fontFamily:'monospace', opacity:.7, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {j.path}
                    </div>
                  </div>
                )
              })}

              {/* Custom Java path */}
              <div style={{ marginTop:4, padding:'12px', background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:4, display:'grid', gap:8 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--ink-3)' }}>Add custom Java installation</div>
                <div style={{ fontSize:11, color:'var(--ink-4)', lineHeight:1.4 }}>
                  Point to a <code style={{ fontFamily:'monospace', color:'var(--ink-3)' }}>java</code> or <code style={{ fontFamily:'monospace', color:'var(--ink-3)' }}>java.exe</code> executable on your system.
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  <input
                    value={customPathInput}
                    onChange={e => { setCustomPathInput(e.target.value); setCustomError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') void addCustomJava() }}
                    placeholder="/usr/lib/jvm/java-17/bin/java"
                    style={{
                      flex:1, height:32, padding:'0 10px', fontSize:12,
                      background:'var(--surface-2)', border:`1px solid ${customError ? 'var(--lava)' : 'var(--border-r)'}`,
                      color:'var(--ink)', borderRadius:3, outline:'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={browseAndAddCustomJava}
                    style={{ ...smallButtonStyle(false), fontSize:11, whiteSpace:'nowrap' }}
                  >
                    Browse…
                  </button>
                  <button
                    type="button"
                    onClick={addCustomJava}
                    disabled={!customPathInput.trim() || addingCustom}
                    style={{ ...smallButtonStyle(!customPathInput.trim() || addingCustom), background:'var(--accent)', color:'#fff', border:'none', fontSize:11 }}
                  >
                    {addingCustom ? 'Adding…' : 'Add'}
                  </button>
                </div>
                {customError && (
                  <div style={{ fontSize:11, color:'var(--lava)', lineHeight:1.4 }}>{customError}</div>
                )}
              </div>
            </div>
          </Panel>
        </div>

        <aside style={{ display:'grid', gap:14, alignContent:'start' }}>
          <Panel title={t.settings.launcherState}>
            <Stat label={t.settings.activeTheme} value={activeThemeId} />
            <Stat label={t.settings.profiles} value={String(accounts.length)} />
            <Stat label={t.settings.window} value={config ? `${config.windowBounds.width} x ${config.windowBounds.height}` : t.settings.loading} />
          </Panel>

          <Panel title={t.settings.playRules}>
            <div style={{ color:'var(--ink-3)', fontSize:12, lineHeight:1.55 }}>
              {t.settings.playRulesText}
            </div>
          </Panel>
        </aside>
      </div>

      {/* Log Viewer */}
      <Panel title={t.settings.appLogs}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <span style={{ fontSize:12, color:'var(--ink-4)' }}>
            {logs.length === 0 ? t.settings.noEntries : t.settings.recentEntries(logs.length)}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={loadLogs} style={smallButtonStyle(logsLoading)}>
              {logsLoading ? t.settings.loading : t.settings.refresh}
            </button>
            <button
              onClick={clearLogs}
              style={{ ...smallButtonStyle(false), color:'var(--lava)', borderColor:'rgba(217,59,59,.4)' }}
            >
              {t.settings.clearLogs}
            </button>
          </div>
        </div>
        <div style={{
          background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:3,
          height:300, overflowY:'auto', fontFamily:'monospace', fontSize:11,
        }}>
          {logs.length === 0 ? (
            <div style={{ padding:'20px 12px', color:'var(--ink-4)', textAlign:'center' }}>
              {logsLoading ? t.settings.loading : t.settings.noLogEntries}
            </div>
          ) : logs.map((entry, i) => (
            <div
              key={i}
              style={{
                padding:'4px 10px',
                borderBottom:'1px solid rgba(255,255,255,.04)',
                color: entry.level === 'error' ? '#ff6b6b' : entry.level === 'warn' ? '#ffd93d' : 'var(--ink-3)',
                lineHeight:1.5,
              }}
            >
              <span style={{ color:'var(--ink-4)', marginRight:6 }}>
                {entry.time ? new Date(entry.time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }) : ''}
              </span>
              <span style={{
                display:'inline-block', minWidth:56, marginRight:6,
                color: entry.level === 'error' ? '#ff6b6b' : entry.level === 'warn' ? '#ffd93d' : 'var(--ink-4)',
                textTransform:'uppercase', fontSize:10,
              }}>
                [{entry.level}]
              </span>
              <span style={{ color:'var(--accent)', marginRight:6 }}>{entry.source}</span>
              <span style={{ wordBreak:'break-all' }}>{entry.message}</span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </Panel>

      {/* About */}
      <Panel title={t.settings.about}>
        <div style={{ display:'flex', alignItems:'center', gap:18 }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220" width={48} height={48} style={{ flexShrink:0 }}>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#5316D4"/>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#3D0FA3" transform="rotate(30)"/>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#8A52FF" transform="rotate(60)"/>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#3D0FA3" transform="rotate(90)"/>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#5316D4" transform="rotate(120)"/>
            <polygon points="0,-92 14,0 0,92 -14,0" fill="#8A52FF" transform="rotate(150)"/>
            <circle r="24" fill="#1B044F"/>
            <circle r="6" fill="#ECE4FF"/>
          </svg>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
              <span style={{ fontFamily:"'VT323',monospace", fontSize:22, letterSpacing:'.1em', color:'var(--ink)' }}>REFRACT</span>
              <span style={{ fontFamily:"'VT323',monospace", fontSize:14, letterSpacing:'.06em', color:'var(--accent)', background:'var(--accent-tint)', border:'1px solid var(--accent)', borderRadius:3, padding:'1px 8px' }}>
                v{__APP_VERSION__} · {t.settings.earlyAccess}
              </span>
            </div>
            <p style={{ margin:'0 0 12px', fontSize:12, color:'var(--ink-4)', lineHeight:1.5 }}>
              {t.settings.aboutDesc}
            </p>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <button
                onClick={() => window.open('https://discord.gg/SUPuuTjMGU')}
                style={{ height:30, padding:'0 14px', fontSize:12, fontWeight:600, background:'#5865F2', color:'#fff', border:'none', borderRadius:4, cursor:'pointer' }}
              >
                {t.settings.joinDiscord}
              </button>
              <button
                onClick={() => window.open('https://github.com/RefractMC/Refract_MC/issues')}
                style={{ height:30, padding:'0 14px', fontSize:12, fontWeight:600, background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)', borderRadius:4, cursor:'pointer' }}
              >
                {t.settings.reportBug}
              </button>
              <button
                onClick={() => window.open('https://github.com/RefractMC/Refract_MC')}
                style={{ height:30, padding:'0 14px', fontSize:12, fontWeight:600, background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)', borderRadius:4, cursor:'pointer' }}
              >
                {t.settings.github}
              </button>
            </div>
          </div>
        </div>
      </Panel>

      {/* Danger zone */}
      <section style={{
        border: '1px solid rgba(217,59,59,.35)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid rgba(217,59,59,.25)', color: 'var(--lava)', fontWeight: 700, background: 'rgba(217,59,59,.07)' }}>
          Danger Zone
        </div>
        <div style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 13 }}>Delete all launcher data</div>
            <div style={{ color: 'var(--ink-4)', fontSize: 12, marginTop: 3 }}>
              Permanently deletes all instances, mods, saves, themes, Java installations and launcher settings. This cannot be undone.
            </div>
          </div>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                height: 34, padding: '0 16px', flexShrink: 0,
                background: 'transparent', color: 'var(--lava)',
                border: '1px solid rgba(217,59,59,.5)', borderRadius: 4,
                cursor: 'pointer', fontSize: 12, fontWeight: 700,
              }}
            >
              Delete All Data
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Are you sure?</span>
              <button
                onClick={async () => {
                  setDeleting(true)
                  try { await api.launcher.deleteAll() } catch { setDeleting(false); setConfirmDelete(false) }
                }}
                disabled={deleting}
                style={{
                  height: 34, padding: '0 16px',
                  background: 'var(--lava)', color: '#fff',
                  border: 'none', borderRadius: 4,
                  cursor: deleting ? 'not-allowed' : 'pointer',
                  fontSize: 12, fontWeight: 700,
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Deleting…' : 'Yes, delete everything'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                style={{
                  height: 34, padding: '0 14px',
                  background: 'var(--surface-3)', color: 'var(--ink)',
                  border: '1px solid var(--border-r)', borderRadius: 4,
                  cursor: 'pointer', fontSize: 12, fontWeight: 700,
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </section>

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
        height:30, padding:'0 16px', whiteSpace:'nowrap',
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
