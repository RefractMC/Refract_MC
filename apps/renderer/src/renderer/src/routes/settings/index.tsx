import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import { analyticsAvailable, api, type AppConfig, type SafeAccount } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { ThemesDialog } from '@/components/settings/ThemesDialog'
import { useThemeStore, type ThemePreference } from '@/stores/theme'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import type { JavaInstallation } from '@refract/core'
import { useT } from '@/i18n'
import { useLanguageStore } from '@/stores/language'

export const Route = createFileRoute('/settings/')({
  component: Settings,
})

const SIDEBAR_WIDTHS_VALUES = ['60px', '232px', '268px'] as const
const MEMORY_MIN_MB = 1024

type ConfirmAction = {
  title: string
  body: string
  confirmLabel: string
  run: () => Promise<void>
}

function safeMemoryMaxMb(systemMaxMb: number): number {
  return Math.max(MEMORY_MIN_MB, Math.floor(systemMaxMb * 0.8 / 512) * 512)
}

function clampMemoryMb(value: number, systemMaxMb: number): number {
  const max = safeMemoryMaxMb(systemMaxMb)
  const clamped = Math.min(Math.max(value, MEMORY_MIN_MB), max)
  return Math.max(MEMORY_MIN_MB, Math.round(clamped / 512) * 512)
}

function ConfirmActionModal({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: ConfirmAction
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const modal = (
    <div style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,.72)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }} onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div style={{ width:380, maxWidth:'100%', background:'var(--surface)', borderRadius:'var(--radius)', padding:18, display:'grid', gap:12 }}>
        <div style={{ fontSize:15, fontWeight:700, color:'var(--lava)' }}>{action.title}</div>
        <div style={{ fontSize:13, lineHeight:1.5, color:'var(--ink-3)' }}>{action.body}</div>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:4 }}>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working...' : action.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

function Settings() {
  const t = useT()
  const analyticsDisabled = !analyticsAvailable
  const languagePreference = useLanguageStore((s) => s.languagePreference)
  const setLanguagePreference = useLanguageStore((s) => s.setLanguagePreference)
  const activeThemeId = useThemeStore((state) => state.activeThemeId)
  const themePreference = useThemeStore((state) => state.themePreference)
  const setThemePreference = useThemeStore((state) => state.setThemePreference)
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
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [confirmActionBusy, setConfirmActionBusy] = useState(false)
  const [themesOpen, setThemesOpen] = useState(false)
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
    showToast('Logs cleared.')
  }

  async function refresh() {
    const [nextConfig, nextAccounts, nextActive] = await Promise.all([
      api.config.get(),
      api.auth.accounts(),
      api.auth.active(),
    ])
    setConfig(nextConfig)
    setMemoryMb(clampMemoryMb(nextConfig.defaultMemoryMb ?? 2048, memoryMaxMb))
    setCfKeyDraft(nextConfig.curseforgeApiKey ?? '')
    setAccounts(nextAccounts)
    setActiveAccount(nextActive)
  }

  function handleMemoryChange(mb: number) {
    const safeMb = clampMemoryMb(mb, memoryMaxMb)
    setMemoryMb(safeMb)
    if (memorySaveTimeout.current) clearTimeout(memorySaveTimeout.current)
    memorySaveTimeout.current = setTimeout(() => {
      api.config.set('defaultMemoryMb', safeMb).catch(() => {})
    }, 400)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    api.system.ramGb().then(gb => {
      const max = Math.max(MEMORY_MIN_MB, gb * 1024)
      setMemoryMaxMb(max)
      setMemoryMb(prev => clampMemoryMb(prev, max))
    }).catch(() => {})
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
      showToast(t.settings.javaAdded)
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingCustom(false)
    }
  }

  async function removeCustomJava(javaPath: string) {
    await api.java.removeCustom(javaPath)
    await scanJava()
    showToast(t.settings.javaRemoved)
  }

  async function confirmAndRun(action: ConfirmAction) {
    setConfirmAction(action)
  }

  async function runConfirmedAction() {
    const action = confirmAction
    if (!action) return
    setConfirmActionBusy(true)
    try {
      await action.run()
      setConfirmAction(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmActionBusy(false)
    }
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

  // Defer Java scan by 3 s so settings page renders instantly
  useEffect(() => { const id = window.setTimeout(() => void scanJava(), 3000); return () => window.clearTimeout(id) }, [])
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

  function chooseTheme(preference: ThemePreference) {
    setThemePreference(preference)
    const message = preference === 'system'
      ? t.settings.themeSystem
      : preference === 'dark'
        ? t.settings.themeDark
        : t.settings.themeLight
    showToast(message)
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
      <div className="library-hero">
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

      <div className="settings-page-grid" style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr) 360px', gap:18 }}>
        <div style={{ display:'grid', gap:14 }}>
          <Panel title={t.settings.appearance}>
            <div style={{ display:'grid', gap:12 }}>
              <Field label={t.settings.accentColor} note={t.settings.accentColorNote}>
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
                      onClick={() => { setAccentColor(hex); showToast(t.settings.accentColorApplied) }}
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
                    title={t.settings.customColour}
                    style={{ width:30, height:22, padding:0, border:'1px solid var(--border-r)', borderRadius:'var(--radius-sm)', cursor:'pointer', background:'none' }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { if (accentColor) { setAccentColor(null); showToast(t.settings.accentColorReset) } }}
                    disabled={!accentColor}
                  >
                    Reset
                  </Button>
                </div>
              </Field>

              <Field label={t.settings.theme} note={t.settings.themeNote}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Segmented>
                    <SegmentButton active={themePreference === 'system'} disabled={!!busy} onClick={() => chooseTheme('system')}>
                      {t.settings.system}
                    </SegmentButton>
                    <SegmentButton active={themePreference === 'dark'} disabled={!!busy} onClick={() => chooseTheme('dark')}>
                      {t.settings.dark}
                    </SegmentButton>
                    <SegmentButton active={themePreference === 'light'} disabled={!!busy} onClick={() => chooseTheme('light')}>
                      {t.settings.light}
                    </SegmentButton>
                  </Segmented>
                  <Button variant="outline" size="sm" onClick={() => setThemesOpen(true)}>Manage themes…</Button>
                </div>
              </Field>

              <Field label={t.settings.memory} note={t.settings.memoryNote}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input
                    type="range"
                    min={MEMORY_MIN_MB} max={safeMemoryMaxMb(memoryMaxMb)} step={512}
                    value={memoryMb}
                    onChange={(e) => handleMemoryChange(Number(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 14, fontWeight: 600, color: 'var(--ink)', minWidth: 56, textAlign: 'right', lineHeight: 1 }}>
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
                  <SegmentButton active={languagePreference === 'system'} disabled={false} onClick={() => setLanguagePreference('system')}>
                    {t.settings.system}
                  </SegmentButton>
                  <SegmentButton active={languagePreference === 'en'} disabled={false} onClick={() => setLanguagePreference('en')}>
                    {t.settings.langEn}
                  </SegmentButton>
                  <SegmentButton active={languagePreference === 'uk'} disabled={false} onClick={() => setLanguagePreference('uk')}>
                    {t.settings.langUk}
                  </SegmentButton>
                  <SegmentButton active={languagePreference === 'zh-CN'} disabled={false} onClick={() => setLanguagePreference('zh-CN')}>
                    {t.settings.langZhCN}
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
                      borderRadius: 'var(--radius-md)', color: 'var(--ink)', fontSize: 12, outline: 'none',
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={async () => {
                      await api.config.set('curseforgeApiKey', cfKeyDraft.trim() || undefined)
                      showToast(t.settings.curseforgeKeySaved)
                    }}
                    style={{ height: 32 }}
                  >
                    {t.account.save}
                  </Button>
                </div>
              </Field>
            </div>
          </Panel>

          <Panel title={t.settings.launchBehavior}>
            <div style={{ display:'grid', gap:12 }}>
              <Field label={t.settings.closeToTray} note={t.settings.closeToTrayNote}>
                <Segmented>
                  <SegmentButton active={!!(config?.minimizeToTray)} disabled={false} onClick={() => { api.config.set('minimizeToTray', true).catch(() => {}); setConfig(c => c ? { ...c, minimizeToTray: true } : c); showToast(t.settings.closeToTrayOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={!(config?.minimizeToTray)} disabled={false} onClick={() => { api.config.set('minimizeToTray', false).catch(() => {}); setConfig(c => c ? { ...c, minimizeToTray: false } : c); showToast(t.settings.closeToTrayOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
              <Field label={t.settings.startMinimized} note={t.settings.startMinimizedNote}>
                <Segmented>
                  <SegmentButton active={!!(config?.startMinimized)} disabled={false} onClick={() => { api.config.set('startMinimized', true).catch(() => {}); setConfig(c => c ? { ...c, startMinimized: true } : c); showToast(t.settings.startMinimizedOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={!(config?.startMinimized)} disabled={false} onClick={() => { api.config.set('startMinimized', false).catch(() => {}); setConfig(c => c ? { ...c, startMinimized: false } : c); showToast(t.settings.startMinimizedOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
              <Field label={t.settings.hideOnLaunch} note={t.settings.hideOnLaunchNote}>
                <Segmented>
                  <SegmentButton active={!!(config?.launchMinimizesToTray)} disabled={false} onClick={() => { api.config.set('launchMinimizesToTray', true).catch(() => {}); setConfig(c => c ? { ...c, launchMinimizesToTray: true } : c); showToast(t.settings.hideOnLaunchOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={!(config?.launchMinimizesToTray)} disabled={false} onClick={() => { api.config.set('launchMinimizesToTray', false).catch(() => {}); setConfig(c => c ? { ...c, launchMinimizesToTray: false } : c); showToast(t.settings.hideOnLaunchOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
              <Field label={t.settings.reopenOnExit} note={t.settings.reopenOnExitNote}>
                <Segmented>
                  <SegmentButton active={!!(config?.reopenOnGameExit)} disabled={false} onClick={() => { api.config.set('reopenOnGameExit', true).catch(() => {}); setConfig(c => c ? { ...c, reopenOnGameExit: true } : c); showToast(t.settings.reopenOnExitOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={!(config?.reopenOnGameExit)} disabled={false} onClick={() => { api.config.set('reopenOnGameExit', false).catch(() => {}); setConfig(c => c ? { ...c, reopenOnGameExit: false } : c); showToast(t.settings.reopenOnExitOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
              <Field label={t.settings.showCat} note={t.settings.showCatNote}>
                <Segmented>
                  <SegmentButton active={!!(config?.showCat)} disabled={false} onClick={() => { api.config.set('showCat', true).catch(() => {}); setConfig(c => c ? { ...c, showCat: true } : c); showToast(t.settings.showCatOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={!(config?.showCat)} disabled={false} onClick={() => { api.config.set('showCat', false).catch(() => {}); setConfig(c => c ? { ...c, showCat: false } : c); showToast(t.settings.showCatOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
            </div>
          </Panel>

          <Panel title={t.privacy.title}>
            <div style={{ display:'grid', gap:12 }}>
              <Field label={t.privacy.analytics} note={analyticsDisabled ? t.privacy.analyticsUnavailable : t.privacy.analyticsNote}>
                <Segmented>
                  <SegmentButton active={!analyticsDisabled && config?.analyticsEnabled !== false} disabled={analyticsDisabled} onClick={() => { if (analyticsDisabled) return; api.config.set('analyticsEnabled', true).catch(() => {}); setConfig(c => c ? { ...c, analyticsEnabled: true } : c); showToast(t.privacy.analyticsOn) }}>{t.settings.on}</SegmentButton>
                  <SegmentButton active={analyticsDisabled || config?.analyticsEnabled === false} disabled={analyticsDisabled} onClick={() => { if (analyticsDisabled) return; api.config.set('analyticsEnabled', false).catch(() => {}); setConfig(c => c ? { ...c, analyticsEnabled: false } : c); showToast(t.privacy.analyticsOff) }}>{t.settings.off}</SegmentButton>
                </Segmented>
              </Field>
            </div>
          </Panel>

          <Panel title={t.settings.accountAccess}>
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleAvatarPick} />
            <div style={{ display:'grid', gap:14 }}>

              {/* Active profile hero row */}
              <div style={{ display:'flex', alignItems:'center', gap:14, padding:14, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)' }}>
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
                      ? activeAccount.type === 'microsoft'
                        ? t.settings.licenseVerified
                        : activeAccount.type === 'yggdrasil'
                          ? t.settings.yggdrasilProfile
                          : t.settings.offlineProfile
                      : t.settings.noProfileCreate}
                  </div>
                  {activeAccount && (
                    <div style={{ fontSize:11, color:'var(--ink-4)', marginTop:4 }}>{t.settings.clickAvatarChange}</div>
                  )}
                </div>
                <Button asChild variant="secondary" style={{ height:34, flexShrink:0 }}>
                  <Link to="/account" style={{ textDecoration:'none' }}>
                    {t.settings.manage}
                  </Link>
                </Button>
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
                        borderRadius:'var(--radius-md)', display:'flex', alignItems:'center', gap:10,
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
                        <div style={{ color:account.type === 'microsoft' ? 'var(--diamond)' : account.type === 'yggdrasil' ? 'var(--ender)' : 'var(--gold)', fontSize:11, marginTop:2 }}>
                          {account.type === 'microsoft' ? t.settings.microsoftLicensed : account.type === 'yggdrasil' ? t.settings.yggdrasilPlay : t.settings.offlinePlay}
                        </div>
                      </div>
                      {isActive && (
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'var(--accent)', flexShrink:0 }}>{t.settings.activeLabel}</div>
                      )}
                      {!isActive && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setActive(account.uuid)}
                          disabled={!!busy}
                        >
                          {t.settings.use}
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => removeAccount(account.uuid)}
                        disabled={!!busy}
                      >
                        {t.settings.signOut}
                      </Button>
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
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={scanJava}
                  disabled={javaLoading}
                >
                  {javaLoading ? t.settings.scanning : t.settings.rescan}
                </Button>
              </div>

              {/* Download needed Java versions */}
              {([8, 17, 21, 25] as const).map(major => {
                const available = javas.some(j => j.version >= major && (major === 8 ? j.version < 17 : major === 17 ? j.version < 21 : true))
                const downloading = javaDownloading.get(major)
                if (available || (!downloading && javas.some(j => j.version === major))) return null
                return (
                  <div key={major} style={{ padding:'10px 12px', background:'rgba(255,255,255,.03)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)' }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                      <div>
                        <div style={{ fontSize:13, fontWeight:700, color:'var(--ink)' }}>Java {major}</div>
                        <div style={{ fontSize:11, color:'var(--ink-4)', marginTop:2 }}>{t.settings.javaVersionLabel(major)}</div>
                      </div>
                      {downloading ? (
                        <div style={{ fontSize:11, color:'var(--ink-3)', textAlign:'right', minWidth:100, fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{downloading.step}</div>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => downloadJava(major)}
                        >
                          {t.settings.download}
                        </Button>
                      )}
                    </div>
                    {downloading && (
                      <div style={{ marginTop:8, height:4, background:'var(--surface-3)', borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${downloading.percent}%`, background:'var(--accent)', transition:'width 200ms linear', borderRadius:'var(--radius-sm)' }} />
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
                      borderRadius:'var(--radius-md)',
                      display:'grid', gap:3,
                    }}
                  >
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:13, fontWeight:700, color: isTop ? 'var(--diamond)' : 'var(--ink)' }}>
                        Java {j.version}
                      </span>
                      <span style={{ fontSize:11, color:'var(--ink-4)' }}>{j.vendor}</span>
                      {isManaged && (
                        <span style={{ fontSize:10, color:'var(--accent)', background:'rgba(83,22,212,.15)', border:'1px solid rgba(83,22,212,.3)', borderRadius:'var(--radius-sm)', padding:'1px 5px' }}>
                          managed
                        </span>
                      )}
                      {isCustom && (
                        <span style={{ fontSize:10, color:'var(--gold)', background:'rgba(228,179,59,.12)', border:'1px solid rgba(228,179,59,.35)', borderRadius:'var(--radius-sm)', padding:'1px 5px' }}>
                          custom
                        </span>
                      )}
                      <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
                        {isTop && (
                          <span style={{ fontSize:11, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'var(--diamond)' }}>
                            {t.settings.bestMatch}
                          </span>
                        )}
                        {isManaged && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              void confirmAndRun({
                                title: `Remove Java ${j.version}?`,
                                body: 'This removes the managed Java runtime from disk. The launcher can download it again later if needed.',
                                confirmLabel: 'Remove Java',
                                run: () => deleteJava(j.version),
                              })
                            }}
                            style={{ fontSize:10, padding:'2px 7px' }}
                          >
                            Remove
                          </Button>
                        )}
                        {isCustom && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              void confirmAndRun({
                                title: 'Remove custom Java?',
                                body: 'This only removes the custom Java entry from Refract. It does not delete the Java files from your computer.',
                                confirmLabel: 'Remove entry',
                                run: () => removeCustomJava(j.path),
                              })
                            }}
                            style={{ fontSize:10, padding:'2px 7px' }}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize:11, color:'var(--ink-4)', lineHeight:1.3 }}>{label}</div>
                    <div style={{ fontSize:10, color:'var(--ink-4)', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', opacity:.7, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {j.path}
                    </div>
                  </div>
                )
              })}

              {/* Custom Java path */}
              <div style={{ marginTop:4, padding:'12px', background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', display:'grid', gap:8 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--ink-3)' }}>Add custom Java installation</div>
                <div style={{ fontSize:11, color:'var(--ink-4)', lineHeight:1.4 }}>
                  Point to a <code style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', color:'var(--ink-3)' }}>java</code> or <code style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', color:'var(--ink-3)' }}>java.exe</code> executable on your system.
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  <input
                    value={customPathInput}
                    onChange={e => { setCustomPathInput(e.target.value); setCustomError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') void addCustomJava() }}
                    placeholder="/usr/lib/jvm/java-17/bin/java"
                    style={{
                      flex:1, height:32, padding:'0 10px', fontSize:12,
                      fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',
                      background:'var(--surface-2)', border:`1px solid ${customError ? 'var(--lava)' : 'var(--border-r)'}`,
                      color:'var(--ink)', borderRadius:'var(--radius-md)', outline:'none',
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={browseAndAddCustomJava}
                    style={{ whiteSpace:'nowrap' }}
                  >
                    Browse…
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={addCustomJava}
                    disabled={!customPathInput.trim() || addingCustom}
                  >
                    {addingCustom ? 'Adding…' : 'Add'}
                  </Button>
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
            <Button variant="secondary" size="sm" onClick={loadLogs} style={{ opacity: logsLoading ? .55 : 1 }}>
              {logsLoading ? t.settings.loading : t.settings.refresh}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                void confirmAndRun({
                  title: 'Clear app logs?',
                  body: 'This deletes the stored launcher log history shown here. It does not affect instances or game files.',
                  confirmLabel: 'Clear logs',
                  run: clearLogs,
                })
              }}
            >
              {t.settings.clearLogs}
            </Button>
          </div>
        </div>
        <div style={{
          background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-sm)',
          height:300, overflowY:'auto', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:11,
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
              <span style={{ fontSize:17, fontWeight:700, letterSpacing:'.10em', color:'var(--ink)' }}>REFRACT</span>
              <span style={{ fontSize:11, fontWeight:600, letterSpacing:'.04em', color:'var(--accent)', background:'var(--accent-tint)', border:'1px solid var(--accent)', borderRadius:'var(--radius-sm)', padding:'2px 8px' }}>
                v{__APP_VERSION__} · {t.settings.earlyAccess}
              </span>
            </div>
            <p style={{ margin:'0 0 12px', fontSize:12, color:'var(--ink-4)', lineHeight:1.5 }}>
              {t.settings.aboutDesc}
            </p>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <Button
                onClick={() => { void api.discord.openInvite() }}
                style={{ height:30, background:'#5865F2', color:'#fff' }}
              >
                {t.settings.joinDiscord}
              </Button>
              <Button
                variant="secondary"
                onClick={() => { void api.external.open('https://github.com/RefractMC/Refract_MC/issues') }}
                style={{ height:30 }}
              >
                {t.settings.reportBug}
              </Button>
              <Button
                variant="secondary"
                onClick={() => { void api.external.open('https://github.com/RefractMC/Refract_MC') }}
                style={{ height:30 }}
              >
                {t.settings.github}
              </Button>
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
            <Button
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              style={{ height: 34, flexShrink: 0 }}
            >
              Delete All Data
            </Button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Are you sure?</span>
              <Button
                variant="danger"
                onClick={async () => {
                  setDeleting(true)
                  try { await api.launcher.deleteAll() } catch { setDeleting(false); setConfirmDelete(false) }
                }}
                disabled={deleting}
                style={{ height: 34 }}
              >
                {deleting ? 'Deleting…' : 'Yes, delete everything'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                style={{ height: 34 }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </section>

      {confirmAction && (
        <ConfirmActionModal
          action={confirmAction}
          busy={confirmActionBusy}
          onCancel={() => { if (!confirmActionBusy) setConfirmAction(null) }}
          onConfirm={() => { void runConfirmedAction() }}
        />
      )}

      {error && (
        <div style={{ padding:12, color:'#fff', background:'rgba(217,59,59,.18)', border:'1px solid var(--redstone)', borderRadius:4, fontSize:13 }}>
          {error}
        </div>
      )}

      {toast && createPortal((
        <div style={{
          position:'fixed', bottom:44, left:'50%', transform:'translateX(-50%)',
          padding:'10px 18px', background:'var(--surface-2)', border:'1px solid var(--border-r)',
          borderRadius:'var(--radius)', boxShadow:'0 8px 24px rgba(0,0,0,.5)',
          color:'var(--ink)', fontSize:13, zIndex:10000,
        }}>
          {toast}
        </div>
      ), document.body)}

      <ThemesDialog open={themesOpen} onOpenChange={setThemesOpen} />
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
        width:size, height:size, borderRadius:'var(--radius-sm)', overflow:'hidden', flexShrink:0,
        border:`1px solid ${hover ? 'var(--accent)' : 'var(--border-r)'}`,
        background:'var(--surface-3)',
        cursor: disabled ? 'default' : 'pointer',
        position:'relative',
        transition:'border-color .14s',
      }}
    >
      {avatar
        ? <img src={avatar} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:size * 0.4, color:'var(--ink-3)' }}>{initial}</div>
      }
      {hover && !disabled && (
        <div style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,.55)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontWeight:700, fontSize:Math.max(9, size * 0.18), letterSpacing:'.10em', color:'#fff',
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
    <div style={{ display:'inline-flex', width:'fit-content', background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', padding:3, gap:3 }}>
      {children}
    </div>
  )
}

function SegmentButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      style={{
        height:30, padding:'0 16px', whiteSpace:'nowrap',
        border:'1px solid transparent',
        borderRadius:'var(--radius-sm)',
        fontSize:12, fontWeight:600,
        ...(active
          ? { background:'var(--accent)', color:'var(--accent-fg)', borderColor:'var(--accent)' }
          : { background:'transparent', color:'var(--ink-2)' }),
      }}
    >
      {children}
    </Button>
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
