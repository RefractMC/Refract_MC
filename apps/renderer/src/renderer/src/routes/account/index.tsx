import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { api, type DeviceLogin, type SafeAccount } from '@/lib/api'
import { authErrorMessage } from '@/lib/auth-errors'
import { startDevicePolling } from '@/lib/device-poll'
import { SkinViewer3DLazy as SkinViewer3D } from '@/components/ui/SkinViewer3DLazy'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import { useT, type T } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { invalidateSkinFaceCache, loadSkinFaceDataUrl, primeSkinFaceCacheFromSkinUrl, subscribeSkinFaceRefresh } from '@/lib/skin-face'

function SkinFace({ uuid, size }: { uuid: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const face = await loadSkinFaceDataUrl(uuid, size, api.auth.fetchSkinTextureUrl)
      if (alive) setSrc(face)
    }
    setSrc(null)
    void load()
    const unsubscribe = subscribeSkinFaceRefresh((detail) => {
      if (!detail.uuid || detail.uuid === uuid) void load()
    })
    return () => { alive = false; unsubscribe() }
  }, [uuid, size])

  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
      onError={() => setSrc(null)}
    />
  )
}

export const Route = createFileRoute('/account/')({
  component: Account,
})

function accountBadge(type: SafeAccount['type'], t: T) {
  if (type === 'microsoft') return { label: t.account.microsoftBadge, color: 'var(--diamond)' }
  if (type === 'offline') return { label: t.account.guestBadge, color: 'var(--gold)' }
  return { label: t.account.yggdrasilBadge, color: 'var(--ender)' }
}

function accessText(account: SafeAccount, t: T) {
  if (account.type === 'microsoft') return t.account.licenseVerified
  if (account.type === 'yggdrasil') return t.account.yggdrasilAccess
  return t.account.offlineAccess
}

function Account() {
  const t = useT()
  const [accounts, setAccounts] = useState<SafeAccount[]>([])
  const [active, setActive] = useState<SafeAccount | null>(null)
  const [device, setDevice] = useState<DeviceLogin | null>(null)
  const [loginMessage, setLoginMessage] = useState<string | null>(null)
  const [loginExpiresAt, setLoginExpiresAt] = useState<number | null>(null)
  const [secondsRemaining, setSecondsRemaining] = useState(0)
  const [offlineName, setOfflineName] = useState('Steve')
  const [yggServer, setYggServer] = useState('')
  const [yggUsername, setYggUsername] = useState('')
  const [yggPassword, setYggPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<Record<string, unknown>>({})
  const [checkingSession, setCheckingSession] = useState<string | null>(null)
  const mounted = useRef(false)
  const translations = useRef(t)
  translations.current = t
  const poller = useRef<ReturnType<typeof startDevicePolling<SafeAccount>> | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const avatars = useAvatarStore((s) => s.avatars)
  const setAvatarStore = useAvatarStore((s) => s.setAvatar)
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [skinTarget, setSkinTarget]   = useState<string | null>(null)
  const [skinPath, setSkinPath]       = useState<string | null>(null)
  const [skinTextureUrl, setSkinTexUrl] = useState<string | null>(null)  // 3D preview URL
  const [skinVariant, setSkinVariant] = useState<'classic' | 'slim'>('classic')
  const [skinUploading, setSkinUploading] = useState(false)
  const [skinMsg, setSkinMsg]         = useState<{ ok: boolean; text: string } | null>(null)
  const [capeTarget, setCapeTarget]   = useState<string | null>(null)
  const [capes, setCapes]             = useState<Array<{ id: string; state: string; url: string; alias: string; dataUrl?: string; isRender?: boolean }>>([])
  const [capesLoading, setCapesLoading] = useState(false)
  const [capeUpdating, setCapeUpdating] = useState(false)
  const [capeMsg, setCapeMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  async function refresh(isCurrent = () => mounted.current) {
    const [nextAccounts, nextActive] = await Promise.all([
      api.auth.accounts(),
      api.auth.active(),
    ])
    if (isCurrent()) {
      setAccounts(nextAccounts)
      setActive(nextActive)
    }
  }

  useEffect(() => {
    let alive = true
    mounted.current = true
    void (async () => {
      try {
        const [accs, selected] = await Promise.all([api.auth.accounts(), api.auth.active()])
        if (!alive) return
        setAccounts(accs)
        setActive(selected)
        const authed = accs.filter(a => a.type === 'microsoft' || a.type === 'yggdrasil')
        await Promise.all(authed.map(async account => {
          try { await api.auth.validate(account.uuid) }
          catch (err) {
            if (alive) setValidationErrors(prev => ({ ...prev, [account.uuid]: err }))
          }
        }))
        if (alive) await refresh(() => alive)
      } catch (err) {
        if (alive) setError(authErrorMessage(err, translations.current.authErrors, translations.current.home.unknownError))
      }
    })()
    return () => { alive = false; mounted.current = false }
  }, [])

  async function retryValidation(uuid: string) {
    setCheckingSession(uuid)
    try {
      await api.auth.validate(uuid)
      if (!mounted.current) return
      setValidationErrors(prev => { const next = { ...prev }; delete next[uuid]; return next })
      await refresh()
    } catch (err) {
      if (mounted.current) setValidationErrors(prev => ({ ...prev, [uuid]: err }))
    } finally {
      if (mounted.current) setCheckingSession(null)
    }
  }

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

  useEffect(() => {
    if (!loginExpiresAt) {
      setSecondsRemaining(0)
      return
    }

    const tick = () => setSecondsRemaining(Math.max(0, Math.ceil((loginExpiresAt - Date.now()) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [loginExpiresAt])

  useEffect(() => {
    if (!device || !loginExpiresAt) return
    const current = startDevicePolling({
      interval: device.interval,
      expiresAt: loginExpiresAt,
      complete: () => api.auth.microsoftComplete(device.deviceCode),
      success: account => {
        setValidationErrors(prev => { const next = { ...prev }; delete next[account.uuid]; return next })
        setDevice(null)
        setLoginExpiresAt(null)
        setLoginMessage(translations.current.account.signedInAs(account.username))
        void refresh().catch(err => {
          if (mounted.current) setError(authErrorMessage(err, translations.current.authErrors, translations.current.home.unknownError))
        })
      },
      pending: slowDown => setLoginMessage(slowDown
        ? translations.current.authErrors.slowDown
        : translations.current.account.waitingForMicrosoft),
      failure: err => {
        setDevice(null)
        setLoginExpiresAt(null)
        setLoginMessage(null)
        setError(authErrorMessage(err, translations.current.authErrors, translations.current.home.unknownError))
      },
    })
    poller.current = current
    return () => {
      current.dispose()
      if (poller.current === current) poller.current = null
    }
  }, [device, loginExpiresAt])

  async function run<T>(label: string, action: () => Promise<T>) {
    setBusy(label)
    setError(null)
    try {
      return await action()
    } catch (err) {
      if (mounted.current) setError(authErrorMessage(err, t.authErrors, t.home.unknownError))
      return null
    } finally {
      setBusy(null)
    }
  }

  async function startMicrosoft() {
    const result = await run('microsoft-begin', () => api.auth.microsoftBegin())
    if (result && mounted.current) {
      setDevice(result)
      setLoginExpiresAt(Date.now() + result.expiresIn * 1000)
      await openMicrosoftVerification(result.verificationUri)
    }
  }

  async function openMicrosoftVerification(url: string) {
    try {
      await api.external.open(url)
      setLoginMessage(t.account.browserOpened)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoginMessage(t.account.openSignInLink)
    }
  }

  function completeMicrosoft() {
    setError(null)
    setLoginMessage(t.account.waitingForMicrosoft)
    void poller.current?.check()
  }

  function cancelMicrosoft() {
    poller.current?.dispose()
    setDevice(null)
    setLoginExpiresAt(null)
    setLoginMessage(null)
  }

  async function copyUserCode() {
    if (!device) return
    await navigator.clipboard?.writeText(device.userCode)
    setLoginMessage(t.account.codeCopied)
  }

  async function createOffline() {
    const account = await run('offline-create', () => api.auth.createOffline(offlineName))
    if (account) await refresh()
  }

  async function loginYggdrasil() {
    const account = await run('yggdrasil-login', () => api.auth.yggdrasilLogin(yggServer, yggUsername, yggPassword))
    if (account) {
      setYggPassword('')
      setValidationErrors(prev => { const next = { ...prev }; delete next[account.uuid]; return next })
      await refresh()
    }
  }

  async function handleSkinUpload(uuid: string) {
    if (!skinPath) return
    setSkinUploading(true)
    setSkinMsg(null)
    try {
      await api.auth.uploadSkin(uuid, skinPath, skinVariant)
      if (skinTextureUrl) await primeSkinFaceCacheFromSkinUrl(uuid, skinTextureUrl)
      else invalidateSkinFaceCache(uuid)
      setSkinMsg({ ok: true, text: t.skins.skinUpdated })
      setSkinTarget(null)
      setSkinPath(null)
    } catch (e) {
      const msg = authErrorMessage(e, t.authErrors, t.home.unknownError)
      if (msg === 'OFFLINE_ONLY') {
        // For offline accounts treat as local avatar change
        setSkinMsg({ ok: true, text: t.skins.savedAsAvatar })
        setSkinTarget(null); setSkinPath(null)
      } else {
        setSkinMsg({ ok: false, text: msg })
      }
    } finally {
      setSkinUploading(false)
    }
  }

  async function handleSetCape(uuid: string, capeId: string | null) {
    setCapeUpdating(true)
    setCapeMsg(null)
    try {
      await api.auth.setCape(uuid, capeId)
      setCapes(prev => prev.map(c => ({ ...c, state: c.id === capeId ? 'ACTIVE' : 'INACTIVE' })))
      setCapeMsg({ ok: true, text: capeId ? t.account.capeActivated : t.account.capeHidden })
    } catch (e) {
      setCapeMsg({ ok: false, text: authErrorMessage(e, t.authErrors, t.home.unknownError) })
    } finally {
      setCapeUpdating(false)
    }
  }

  async function selectAccount(uuid: string) {
    const account = await run(`active-${uuid}`, () => api.auth.setActive(uuid))
    if (account) await refresh()
  }

  async function logout(uuid: string) {
    const result = await run(`logout-${uuid}`, () => api.auth.logout(uuid))
    if (result !== null) {
      if (skinTarget === uuid) setSkinTarget(null)
      if (capeTarget === uuid) setCapeTarget(null)
      await refresh()
    }
  }

  function startRename(account: SafeAccount) {
    setRenamingId(account.uuid)
    setRenameValue(account.username)
  }

  async function commitRename(uuid: string) {
    if (!renameValue.trim()) return
    await run(`rename-${uuid}`, () => api.auth.renameOffline(uuid, renameValue))
    setRenamingId(null)
    await refresh()
  }

  function cancelRename() {
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <div className="account-page-grid" style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.05fr) 360px', gap:18, minHeight:'100%' }}>
      <input ref={avatarInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleAvatarPick} />
      <section style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
        <div style={{ padding:'18px 20px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
          <div>
            <h1 style={{ margin:0, color:'var(--ink)', fontSize:24, lineHeight:1.1, fontWeight:700 }}>{t.account.title}</h1>
            <p style={{ margin:'6px 0 0', color:'var(--ink-3)', fontSize:13 }}>
              {t.account.subtitle}
            </p>
          </div>
          {active && (
            <div style={{ color:'var(--accent)', fontSize:14, fontWeight:600, letterSpacing:'.02em' }}>
              {t.account.activeHeader(active.username)}
            </div>
          )}
        </div>

        <div style={{ padding:20, display:'grid', gap:14 }}>
          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16, fontWeight:600 }}>{t.account.microsoftSection}</h2>
            <p style={{ margin:'0 0 14px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.microsoftDesc}
            </p>
            <Button
              variant="primary"
              type="button"
              onClick={startMicrosoft}
              disabled={!!busy}
              style={{ height:42 }}
            >
              {t.account.signInMicrosoft}
            </Button>

            {device && (
              <div style={{ marginTop:16, padding:14, background:'var(--bg)', border:'1px solid var(--accent)', borderRadius:'var(--radius-md)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', gap:12, alignItems:'center', color:'var(--ink-3)', fontSize:12, marginBottom:8 }}>
                  <span>{t.account.enterCodeAt}</span>
                  <span style={{ color:'var(--gold)', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{secondsRemaining > 0 ? t.account.secondsLeft(secondsRemaining) : t.account.codeExpired}</span>
                </div>
                <div style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', color:'var(--ink)', fontSize:26, letterSpacing:'.12em', lineHeight:1, fontWeight:600 }}>
                  {device.userCode}
                </div>
                <a
                  href={device.verificationUri}
                  onClick={(event) => {
                    event.preventDefault()
                    void openMicrosoftVerification(device.verificationUri)
                  }}
                  style={{ display:'inline-block', marginTop:10, color:'var(--diamond)', fontSize:13 }}
                >
                  {device.verificationUri}
                </a>
                {loginMessage && (
                  <div style={{ marginTop:10, color:'var(--ink-3)', fontSize:12, lineHeight:1.45 }}>
                    {loginMessage}
                  </div>
                )}
                <div style={{ marginTop:12, display:'flex', gap:8, flexWrap:'wrap' }}>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={copyUserCode}
                    disabled={!!busy}
                    style={{ height:34 }}
                  >
                    {t.account.copyCode}
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={completeMicrosoft}
                    disabled={!!busy}
                    style={{ height:34 }}
                  >
                    {t.account.iFinishedLogin}
                  </Button>
                  <Button
                    variant="danger"
                    type="button"
                    onClick={cancelMicrosoft}
                    disabled={!!busy}
                    style={{ height:34 }}
                  >
                    {t.account.cancel}
                  </Button>
                </div>
              </div>
            )}
            {!device && loginMessage && (
              <div style={{ marginTop:12, color:'var(--grass)', fontSize:12 }}>
                {loginMessage}
              </div>
            )}
          </div>

          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16, fontWeight:600 }}>{t.account.offlineSection}</h2>
            <p style={{ margin:'0 0 12px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.offlineDesc}
            </p>
            <div style={{ display:'flex', gap:8 }}>
              <input
                value={offlineName}
                onChange={(event) => setOfflineName(event.target.value)}
                style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', color:'var(--ink)', padding:'0 10px', outline:'none' }}
              />
              <Button
                variant="primary"
                type="button"
                onClick={createOffline}
                disabled={!!busy || !offlineName.trim()}
                style={{ height:36 }}
              >
                {t.account.add}
              </Button>
            </div>
          </div>

          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', padding:16 }}>
            <h2 style={{ margin:'0 0 4px', color:'var(--ink)', fontSize:16, fontWeight:600 }}>{t.account.yggdrasilSection}</h2>
            <div style={{ color:'var(--ender)', fontSize:11, fontWeight:600, letterSpacing:'.08em', marginBottom:8 }}>{t.account.yggdrasilBadge}</div>
            <p style={{ margin:'0 0 12px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.yggdrasilDesc}
            </p>
            <div style={{ display:'grid', gap:8 }}>
              <input
                value={yggServer}
                onChange={e => setYggServer(e.target.value)}
                placeholder={t.account.yggdrasilUrlPlaceholder}
                style={{ height:36, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
              />
              <div style={{ display:'flex', gap:8 }}>
                <input
                  value={yggUsername}
                  onChange={e => setYggUsername(e.target.value)}
                  placeholder={t.account.yggdrasilUserPlaceholder}
                  style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
                />
                <input
                  type="password"
                  value={yggPassword}
                  onChange={e => setYggPassword(e.target.value)}
                  placeholder={t.account.yggdrasilPassPlaceholder}
                  onKeyDown={e => { if (e.key === 'Enter') void loginYggdrasil() }}
                  style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
                />
              </div>
              <Button
                variant="primary"
                type="button"
                onClick={loginYggdrasil}
                disabled={!!busy || !yggServer.trim() || !yggUsername.trim() || !yggPassword}
                style={{ height:36, background:'var(--ender)', color:'#fff' }}
              >
                {busy === 'yggdrasil-login' ? t.account.yggdrasilSigningIn : t.account.yggdrasilSignIn}
              </Button>
            </div>
          </div>

          {error && (
            <div style={{ padding:12, color:'#fff', background:'rgba(217,59,59,.18)', border:'1px solid var(--redstone)', borderRadius:'var(--radius-md)', fontSize:13 }}>
              {error}
            </div>
          )}
        </div>
      </section>

      <aside style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--line)', color:'var(--ink)', fontWeight:700 }}>{t.account.savedProfiles}</div>
        <div style={{ padding:12, display:'grid', gap:8 }}>
          {accounts.length === 0 ? (
            <p style={{ color:'var(--ink-3)', fontSize:13, margin:4 }}>{t.account.noAccounts}</p>
          ) : accounts.map((account) => {
            const badge = accountBadge(account.type, t)
            const isActive = active?.uuid === account.uuid
            return (
              <div
                key={account.uuid}
                style={{
                  padding:12,
                  background:isActive ? 'var(--accent-tint)' : 'var(--surface-2)',
                  border:`1px solid ${isActive ? 'var(--accent)' : 'var(--border-r)'}`,
                  borderRadius:'var(--radius-md)',
                  display:'grid',
                  gap:10,
                }}
              >
                <div style={{ display:'flex', justifyContent:'space-between', gap:10, alignItems:'start' }}>
                  <div style={{ display:'flex', gap:10, alignItems:'start', minWidth:0, flex:1 }}>
                    <div
                      title={t.account.changeAvatar}
                      onClick={() => { setPickingFor(account.uuid); avatarInputRef.current?.click() }}
                      style={{
                        width:42, height:42, borderRadius:'var(--radius-sm)', overflow:'hidden', flexShrink:0,
                        border:'1px solid var(--border-r)', background:'var(--surface-3)',
                        cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                        imageRendering: 'pixelated',
                      }}
                    >
                      {avatars[account.uuid]
                        ? <img src={avatars[account.uuid]} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                        : account.type !== 'offline'
                          ? <SkinFace uuid={account.uuid} size={42} />
                          : <span style={{ fontSize:18, fontWeight:700, color:'var(--ink-3)' }}>
                              {account.username[0]?.toUpperCase()}
                            </span>
                      }
                    </div>
                    <div style={{ minWidth:0, flex:1 }}>
                      {renamingId === account.uuid ? (
                        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void commitRename(account.uuid); if (e.key === 'Escape') cancelRename() }}
                            style={{ flex:1, minWidth:0, height:28, background:'var(--bg)', border:'1px solid var(--accent)', color:'var(--ink)', padding:'0 8px', outline:'none', fontSize:13, borderRadius:'var(--radius-md)' }}
                          />
                          <Button variant="primary" size="sm" type="button" onClick={() => void commitRename(account.uuid)} disabled={!renameValue.trim() || !!busy} style={{ height:28, fontSize:12 }}>{t.account.save}</Button>
                          <Button variant="ghost" size="icon" type="button" onClick={cancelRename} style={{ height:28, width:28, fontSize:12 }}>✕</Button>
                        </div>
                      ) : (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <div style={{ color:'var(--ink)', fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{account.username}</div>
                          {account.type === 'offline' && (
                            <Button variant="ghost" size="icon" type="button" title={t.account.rename} onClick={() => startRename(account)} style={{ width:20, height:20, color:'var(--ink-4)', fontSize:13 }}>✎</Button>
                          )}
                        </div>
                      )}
                      <div style={{ color:badge.color, fontSize:11, fontWeight:600, letterSpacing:'.08em', marginTop:2 }}>{badge.label}</div>
                      <div style={{ color:'var(--ink-4)', fontSize:11, lineHeight:1.35, marginTop:4 }}>{accessText(account, t)}</div>
                      {account.needsReauth && (
                        account.type === 'microsoft' ? (
                          <Button
                            variant="danger"
                            size="sm"
                            type="button"
                            onClick={() => { void startMicrosoft() }}
                            disabled={!!busy}
                            style={{ marginTop:6, fontSize:11, height:'auto', padding:'4px 9px' }}
                          >
                            ⚠ {t.account.signInAgain}
                          </Button>
                        ) : (
                          <div style={{ marginTop:6, fontSize:11, color:'var(--lava)', fontWeight:600 }}>⚠ {t.account.sessionExpired}</div>
                        )
                      )}
                      {validationErrors[account.uuid] != null && (
                        <div role="status" style={{ marginTop: 6, fontSize: 12, color: 'var(--lava)' }}>
                          <p>{authErrorMessage(validationErrors[account.uuid], t.authErrors, t.home.unknownError)}</p>
                          <Button variant="secondary" size="sm" type="button"
                            disabled={!!checkingSession || !!busy}
                            onClick={() => { void retryValidation(account.uuid) }}>
                            {checkingSession === account.uuid ? t.authErrors.checking : t.authErrors.retryCheck}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  {isActive && <div style={{ color:'var(--accent)', fontSize:12, fontWeight:600, flexShrink:0 }}>{t.account.activeLabel}</div>}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => selectAccount(account.uuid)}
                    disabled={isActive || !!busy}
                    style={{ flex:1, height:30 }}
                  >
                    {t.account.use}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={async () => {
                      if (skinTarget === account.uuid) { setSkinTarget(null); return }
                      setCapeTarget(null)
                      setSkinTarget(account.uuid); setSkinPath(null); setSkinMsg(null); setSkinTexUrl(null)
                      if (account.type !== 'offline') {
                        const url = await api.auth.fetchSkinTextureUrl(account.uuid).catch(() => null)
                        setSkinTexUrl(url)
                      }
                    }}
                    style={{ height:30, fontSize:12 }}
                  >
                    {t.account.skin}
                  </Button>
                  {account.type === 'microsoft' && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={async () => {
                        if (capeTarget === account.uuid) { setCapeTarget(null); return }
                        setSkinTarget(null)
                        setCapeTarget(account.uuid)
                        setCapeMsg(null)
                        setCapesLoading(true)
                        try {
                          const list = await api.auth.fetchCapes(account.uuid)
                          setCapes(list)
                        } catch (err) {
                          setCapes([])
                          setCapeMsg({ ok: false, text: authErrorMessage(err, t.authErrors, t.home.unknownError) })
                        }
                        finally { setCapesLoading(false) }
                      }}
                      style={{ height:30, fontSize:12 }}
                    >
                      {t.account.cape}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    type="button"
                    onClick={() => logout(account.uuid)}
                    disabled={!!busy}
                    style={{ height:30 }}
                  >
                    {t.account.signOut}
                  </Button>
                </div>

                {/* Cape panel */}
                {capeTarget === account.uuid && (
                  <div style={{ marginTop:8, padding:12, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'.10em' }}>{t.account.capes}</div>
                    {capesLoading ? (
                      <div style={{ color:'var(--ink-4)', fontSize:12 }}>{t.account.loadingCapes}</div>
                    ) : capes.length === 0 ? (
                      <div style={{ color:'var(--ink-4)', fontSize:12, lineHeight:1.5 }}>
                        {t.account.noCapes}
                      </div>
                    ) : (
                      <div style={{ display:'flex', gap:8, overflowX:'auto', paddingBottom:2 }}>
                        {/* Hide cape option */}
                        <button
                          type="button"
                          title={t.account.hideCape}
                          disabled={capeUpdating}
                          onClick={() => void handleSetCape(account.uuid, null)}
                          style={{
                            flexShrink:0, display:'flex', flexDirection:'column', alignItems:'center', gap:4,
                            padding:'6px 8px', background:'var(--surface-2)',
                            border:`1px solid ${capes.every(c => c.state !== 'ACTIVE') ? 'var(--accent)' : 'var(--border-r)'}`,
                            borderRadius:'var(--radius-md)', cursor: capeUpdating ? 'not-allowed' : 'pointer',
                            opacity: capeUpdating ? .6 : 1,
                          }}
                        >
                          <div style={{
                            width:50, height:80, background:'var(--surface-3)',
                            border:'1px solid var(--border-r)', borderRadius:'var(--radius-sm)',
                            display:'flex', alignItems:'center', justifyContent:'center',
                            color:'var(--ink-4)', fontSize:18,
                          }}>—</div>
                          <span style={{ fontSize:9, color:'var(--ink-3)', whiteSpace:'nowrap' }}>{t.account.none}</span>
                        </button>

                        {capes.map(cape => (
                          <button
                            key={cape.id}
                            type="button"
                            title={cape.alias}
                            disabled={capeUpdating}
                            onClick={() => void handleSetCape(account.uuid, cape.id)}
                            style={{
                              flexShrink:0, display:'flex', flexDirection:'column', alignItems:'center', gap:4,
                              padding:'6px 8px', background:'var(--surface-2)',
                              border:`1px solid ${cape.state === 'ACTIVE' ? 'var(--accent)' : 'var(--border-r)'}`,
                              borderRadius:'var(--radius-md)', cursor: capeUpdating ? 'not-allowed' : 'pointer',
                              opacity: capeUpdating ? .6 : 1,
                            }}
                          >
                            <img
                              src={cape.dataUrl ?? cape.url}
                              alt={cape.alias}
                              style={{ display:'block', width:50, height:80, objectFit:'contain' }}
                            />
                            <span style={{ fontSize:9, color: cape.state === 'ACTIVE' ? 'var(--accent)' : 'var(--ink-3)', maxWidth:58, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {cape.alias}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {capeMsg && (
                      <div style={{ fontSize:11, color: capeMsg.ok ? 'var(--grass)' : 'var(--lava)', lineHeight:1.4 }}>
                        {capeMsg.text}
                      </div>
                    )}
                  </div>
                )}

                {/* Skin change panel */}
                {skinTarget === account.uuid && (
                  <div style={{ marginTop:8, padding:12, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:'var(--radius-md)', display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--ink-3)' }}>
                      {account.type === 'microsoft' ? t.skins.uploadTitle : account.type === 'yggdrasil' ? t.skins.yggdrasilTitle : t.skins.offlineTitle}
                    </div>

                    {account.type === 'yggdrasil' ? (
                      <Button
                        variant="primary"
                        type="button"
                        onClick={() => api.auth.uploadSkin(account.uuid, '', 'classic').catch(() => {})}
                        style={{ height:32, fontSize:12 }}
                      >
                        {t.skins.openSkinPage}
                      </Button>
                    ) : (
                      <>
                        <div style={{ display:'flex', gap:8 }}>
                          <Button
                            variant="secondary"
                            type="button"
                            onClick={async () => {
                              const p = await api.auth.browseSkin()
                              if (p) {
                                setSkinPath(p)
                                const dataUrl = await api.skins.fileToDataUrl(p).catch(() => null)
                                setSkinTexUrl(dataUrl ?? null)
                              }
                            }}
                            style={{ flex:1, height:32, fontSize:12 }}
                          >
                            {skinPath ? '✓ ' + skinPath.split(/[/\\]/).pop() : t.account.browsePng}
                          </Button>
                          {account.type === 'microsoft' && (
                            <select
                              value={skinVariant}
                              onChange={e => setSkinVariant(e.target.value as 'classic' | 'slim')}
                              style={{ height:32, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 8px', borderRadius:'var(--radius-md)', cursor:'pointer', fontSize:12 }}
                            >
                              <option value="classic">{t.skins.classicSteve}</option>
                              <option value="slim">{t.skins.slimAlex}</option>
                            </select>
                          )}
                        </div>
                        {/* 3D skin viewer — shows current skin or newly selected one */}
                        {(skinTextureUrl || skinPath) && (
                          <div style={{ display:'flex', justifyContent:'center', background:'var(--surface-2)', borderRadius:'var(--radius-md)', padding:8, border:'1px solid var(--border-r)' }}>
                            <SkinViewer3D skinUrl={skinTextureUrl} width={160} height={240} walk rotate />
                          </div>
                        )}
                        <Button
                          variant="primary"
                          type="button"
                          onClick={() => void handleSkinUpload(account.uuid)}
                          disabled={!skinPath || skinUploading}
                          style={{ height:32, fontSize:12 }}
                        >
                          {skinUploading ? t.skins.uploading : account.type === 'microsoft' ? t.skins.uploadSkin : t.skins.saveAsAvatar}
                        </Button>
                      </>
                    )}

                    {skinMsg && (
                      <div style={{ fontSize:11, color: skinMsg.ok ? 'var(--grass)' : 'var(--lava)', lineHeight:1.4 }}>
                        {skinMsg.text}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

