import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { api, type DeviceLogin, type SafeAccount } from '@/lib/api'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import { useT, type T } from '@/i18n'

function SkinFace({ uuid, size }: { uuid: string; size: number }) {
  const id = uuid.replace(/-/g, '')
  const [src, setSrc] = useState(`https://mc-heads.net/avatar/${id}/${size}`)
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={src}
      alt=""
      style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
      onError={() => {
        if (!src.includes('crafatar')) setSrc(`https://crafatar.com/avatars/${id}?size=${size}&overlay=true&default=MHF_Steve`)
        else setFailed(true)
      }}
    />
  )
}

export const Route = createFileRoute('/account/')({
  component: Account,
})

function accountBadge(type: SafeAccount['type']) {
  if (type === 'microsoft') return { label: 'MICROSOFT', color: 'var(--diamond)' }
  if (type === 'offline') return { label: 'GUEST', color: 'var(--gold)' }
  return { label: 'YGGDRASIL', color: 'var(--ender)' }
}

function accessText(account: SafeAccount, t: T) {
  if (account.canPlayMinecraft) return t.account.licenseVerified
  return t.account.offlineAccess
}

function isPendingDeviceLogin(message: string) {
  const lower = message.toLowerCase()
  return lower.includes('authorization_pending') || lower.includes('authorization is pending')
}

function isExpiredDeviceLogin(message: string) {
  const lower = message.toLowerCase()
  return lower.includes('expired_token') || lower.includes('expired')
}

function isDeclinedDeviceLogin(message: string) {
  const lower = message.toLowerCase()
  return lower.includes('authorization_declined') || lower.includes('declined')
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
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const avatars = useAvatarStore((s) => s.avatars)
  const setAvatarStore = useAvatarStore((s) => s.setAvatar)
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [skinTarget, setSkinTarget] = useState<string | null>(null)   // uuid of account being skinned
  const [skinPath, setSkinPath]     = useState<string | null>(null)
  const [skinVariant, setSkinVariant] = useState<'classic' | 'slim'>('classic')
  const [skinUploading, setSkinUploading] = useState(false)
  const [skinMsg, setSkinMsg]       = useState<{ ok: boolean; text: string } | null>(null)

  async function refresh() {
    const [nextAccounts, nextActive] = await Promise.all([
      api.auth.accounts(),
      api.auth.active(),
    ])
    setAccounts(nextAccounts)
    setActive(nextActive)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

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
    if (!device) return

    let cancelled = false
    const currentDevice = device
    const intervalMs = Math.max(currentDevice.interval, 5) * 1000

    async function poll() {
      try {
        const account = await api.auth.microsoftComplete(currentDevice.deviceCode)
        if (cancelled) return
        setDevice(null)
        setLoginExpiresAt(null)
        setLoginMessage(`Signed in as ${account.username}.`)
        await refresh()
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        if (isPendingDeviceLogin(message)) {
          setLoginMessage('Waiting for Microsoft to confirm sign-in...')
          return
        }
        setDevice(null)
        setLoginExpiresAt(null)
        setLoginMessage(null)
        setError(
          isExpiredDeviceLogin(message)
            ? 'The Microsoft sign-in code expired. Start sign-in again to get a fresh code.'
            : isDeclinedDeviceLogin(message)
              ? 'Microsoft sign-in was declined.'
              : message
        )
      }
    }

    const id = window.setInterval(poll, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [device])

  async function run<T>(label: string, action: () => Promise<T>) {
    setBusy(label)
    setError(null)
    try {
      return await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(null)
    }
  }

  async function startMicrosoft() {
    const result = await run('microsoft-begin', () => api.auth.microsoftBegin())
    if (result) {
      setDevice(result)
      setLoginExpiresAt(Date.now() + result.expiresIn * 1000)
      setLoginMessage('Browser opened. Complete Microsoft sign-in, then Refract will continue automatically.')
    }
  }

  async function completeMicrosoft() {
    if (!device) return
    setBusy('microsoft-complete')
    setError(null)
    try {
      const account = await api.auth.microsoftComplete(device.deviceCode)
      setDevice(null)
      setLoginExpiresAt(null)
      setLoginMessage(`Signed in as ${account.username}.`)
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isPendingDeviceLogin(message)) {
        setLoginMessage('Microsoft has not confirmed sign-in yet. Finish in the browser, then this page will update.')
      } else {
        setError(message)
      }
    } finally {
      setBusy(null)
    }
  }

  function cancelMicrosoft() {
    setDevice(null)
    setLoginExpiresAt(null)
    setLoginMessage(null)
  }

  async function copyUserCode() {
    if (!device) return
    await navigator.clipboard?.writeText(device.userCode)
    setLoginMessage('Code copied. Finish sign-in in the Microsoft browser window.')
  }

  async function createOffline() {
    const account = await run('offline-create', () => api.auth.createOffline(offlineName))
    if (account) await refresh()
  }

  async function loginYggdrasil() {
    const account = await run('yggdrasil-login', () => api.auth.yggdrasilLogin(yggServer, yggUsername, yggPassword))
    if (account) {
      setYggPassword('')
      await refresh()
    }
  }

  async function handleSkinUpload(uuid: string) {
    if (!skinPath) return
    setSkinUploading(true)
    setSkinMsg(null)
    try {
      await api.auth.uploadSkin(uuid, skinPath, skinVariant)
      setSkinMsg({ ok: true, text: 'Skin updated! Restart Minecraft to see it.' })
      setSkinTarget(null)
      setSkinPath(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'OFFLINE_ONLY') {
        // For offline accounts treat as local avatar change
        setSkinMsg({ ok: true, text: 'Saved as launcher avatar.' })
        setSkinTarget(null); setSkinPath(null)
      } else {
        setSkinMsg({ ok: false, text: msg })
      }
    } finally {
      setSkinUploading(false)
    }
  }

  async function selectAccount(uuid: string) {
    const account = await run(`active-${uuid}`, () => api.auth.setActive(uuid))
    if (account) await refresh()
  }

  async function logout(uuid: string) {
    await run(`logout-${uuid}`, () => api.auth.logout(uuid))
    await refresh()
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
    <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.05fr) 360px', gap:18, minHeight:'100%' }}>
      <input ref={avatarInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleAvatarPick} />
      <section style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius)', overflow:'hidden' }}>
        <div style={{ padding:'18px 20px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
          <div>
            <h1 style={{ margin:0, color:'var(--ink)', fontSize:24, lineHeight:1.1 }}>{t.account.title}</h1>
            <p style={{ margin:'6px 0 0', color:'var(--ink-3)', fontSize:13 }}>
              {t.account.subtitle}
            </p>
          </div>
          {active && (
            <div style={{ fontFamily:"'VT323',monospace", color:'var(--accent)', fontSize:18, letterSpacing:'.08em' }}>
              {t.account.activeHeader(active.username)}
            </div>
          )}
        </div>

        <div style={{ padding:20, display:'grid', gap:14 }}>
          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:4, padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16 }}>{t.account.microsoftSection}</h2>
            <p style={{ margin:'0 0 14px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.microsoftDesc}
            </p>
            <button
              type="button"
              onClick={startMicrosoft}
              disabled={!!busy}
              style={{
                height:42, padding:'0 18px',
                background:'var(--accent)', color:'#fff',
                border:'none', cursor:busy ? 'not-allowed' : 'pointer',
                fontWeight:700, letterSpacing:'.08em',
                boxShadow:'inset 0 3px 0 var(--accent-hi), inset 0 -4px 0 var(--accent-lo), 0 3px 0 #000',
                opacity: busy ? .6 : 1,
              }}
            >
              {t.account.signInMicrosoft}
            </button>

            {device && (
              <div style={{ marginTop:16, padding:14, background:'var(--bg)', border:'1px solid var(--accent)', borderRadius:4 }}>
                <div style={{ display:'flex', justifyContent:'space-between', gap:12, alignItems:'center', color:'var(--ink-3)', fontSize:12, marginBottom:8 }}>
                  <span>{t.account.enterCodeAt}</span>
                  <span style={{ color:'var(--gold)' }}>{secondsRemaining > 0 ? `${secondsRemaining}s left` : t.account.codeExpired}</span>
                </div>
                <div style={{ fontFamily:"'VT323',monospace", color:'var(--ink)', fontSize:34, letterSpacing:'.18em', lineHeight:1 }}>
                  {device.userCode}
                </div>
                <a href={device.verificationUri} style={{ display:'inline-block', marginTop:10, color:'var(--diamond)', fontSize:13 }}>
                  {device.verificationUri}
                </a>
                {loginMessage && (
                  <div style={{ marginTop:10, color:'var(--ink-3)', fontSize:12, lineHeight:1.45 }}>
                    {loginMessage}
                  </div>
                )}
                <div style={{ marginTop:12, display:'flex', gap:8, flexWrap:'wrap' }}>
                  <button
                    type="button"
                    onClick={copyUserCode}
                    disabled={!!busy}
                    style={{ height:34, padding:'0 14px', background:'var(--surface-2)', color:'var(--ink)', border:'1px solid var(--border-r)', cursor:'pointer' }}
                  >
                    {t.account.copyCode}
                  </button>
                  <button
                    type="button"
                    onClick={completeMicrosoft}
                    disabled={!!busy}
                    style={{ height:34, padding:'0 14px', background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)', cursor:'pointer' }}
                  >
                    {t.account.iFinishedLogin}
                  </button>
                  <button
                    type="button"
                    onClick={cancelMicrosoft}
                    disabled={!!busy}
                    style={{ height:34, padding:'0 14px', background:'transparent', color:'var(--redstone)', border:'1px solid rgba(217,59,59,.45)', cursor:'pointer' }}
                  >
                    {t.account.cancel}
                  </button>
                </div>
              </div>
            )}
            {!device && loginMessage && (
              <div style={{ marginTop:12, color:'var(--grass)', fontSize:12 }}>
                {loginMessage}
              </div>
            )}
          </div>

          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:4, padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16 }}>{t.account.offlineSection}</h2>
            <p style={{ margin:'0 0 12px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.offlineDesc}
            </p>
            <div style={{ display:'flex', gap:8 }}>
              <input
                value={offlineName}
                onChange={(event) => setOfflineName(event.target.value)}
                style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 10px', outline:'none' }}
              />
              <button
                type="button"
                onClick={createOffline}
                disabled={!!busy || !offlineName.trim()}
                style={{ height:36, padding:'0 12px', background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)', cursor:'pointer', opacity:busy ? .6 : 1 }}
              >
                {t.account.add}
              </button>
            </div>
          </div>

          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:4, padding:16 }}>
            <h2 style={{ margin:'0 0 4px', color:'var(--ink)', fontSize:16 }}>{t.account.yggdrasilSection}</h2>
            <div style={{ color:'var(--ender)', fontFamily:"'VT323',monospace", fontSize:14, letterSpacing:'.08em', marginBottom:8 }}>YGGDRASIL</div>
            <p style={{ margin:'0 0 12px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              {t.account.yggdrasilDesc}
            </p>
            <div style={{ display:'grid', gap:8 }}>
              <input
                value={yggServer}
                onChange={e => setYggServer(e.target.value)}
                placeholder={t.account.yggdrasilUrlPlaceholder}
                style={{ height:36, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
              />
              <div style={{ display:'flex', gap:8 }}>
                <input
                  value={yggUsername}
                  onChange={e => setYggUsername(e.target.value)}
                  placeholder={t.account.yggdrasilUserPlaceholder}
                  style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
                />
                <input
                  type="password"
                  value={yggPassword}
                  onChange={e => setYggPassword(e.target.value)}
                  placeholder={t.account.yggdrasilPassPlaceholder}
                  onKeyDown={e => { if (e.key === 'Enter') void loginYggdrasil() }}
                  style={{ flex:1, minWidth:0, height:36, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 10px', outline:'none', fontSize:12 }}
                />
              </div>
              <button
                type="button"
                onClick={loginYggdrasil}
                disabled={!!busy || !yggServer.trim() || !yggUsername.trim() || !yggPassword}
                style={{
                  height:36, padding:'0 14px', background:'var(--ender)', color:'#fff',
                  border:'none', cursor:'pointer', fontWeight:700, letterSpacing:'.06em',
                  opacity: (!!busy || !yggServer.trim() || !yggUsername.trim() || !yggPassword) ? .5 : 1,
                }}
              >
                {busy === 'yggdrasil-login' ? t.account.yggdrasilSigningIn : t.account.yggdrasilSignIn}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ padding:12, color:'#fff', background:'rgba(217,59,59,.18)', border:'1px solid var(--redstone)', borderRadius:4, fontSize:13 }}>
              {error}
            </div>
          )}
        </div>
      </section>

      <aside style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius)', overflow:'hidden' }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--line)', color:'var(--ink)', fontWeight:700 }}>{t.account.savedProfiles}</div>
        <div style={{ padding:12, display:'grid', gap:8 }}>
          {accounts.length === 0 ? (
            <p style={{ color:'var(--ink-3)', fontSize:13, margin:4 }}>{t.account.noAccounts}</p>
          ) : accounts.map((account) => {
            const badge = accountBadge(account.type)
            const isActive = active?.uuid === account.uuid
            return (
              <div
                key={account.uuid}
                style={{
                  padding:12,
                  background:isActive ? 'var(--accent-tint)' : 'var(--surface-2)',
                  border:`1px solid ${isActive ? 'var(--accent)' : 'var(--border-r)'}`,
                  borderRadius:4,
                  display:'grid',
                  gap:10,
                }}
              >
                <div style={{ display:'flex', justifyContent:'space-between', gap:10, alignItems:'start' }}>
                  <div style={{ display:'flex', gap:10, alignItems:'start', minWidth:0, flex:1 }}>
                    <div
                      title="Click to change avatar"
                      onClick={() => { setPickingFor(account.uuid); avatarInputRef.current?.click() }}
                      style={{
                        width:42, height:42, borderRadius:3, overflow:'hidden', flexShrink:0,
                        border:'1px solid var(--border-r)', background:'var(--surface-3)',
                        cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                        imageRendering: 'pixelated',
                      }}
                    >
                      {avatars[account.uuid]
                        ? <img src={avatars[account.uuid]} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                        : account.type !== 'offline'
                          ? <SkinFace uuid={account.uuid} size={42} />
                          : <span style={{ fontFamily:"'VT323',monospace", fontSize:22, color:'var(--ink-3)' }}>
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
                            style={{ flex:1, minWidth:0, height:28, background:'var(--bg)', border:'1px solid var(--accent)', color:'var(--ink)', padding:'0 8px', outline:'none', fontSize:13, borderRadius:3 }}
                          />
                          <button type="button" onClick={() => void commitRename(account.uuid)} disabled={!renameValue.trim() || !!busy} style={{ height:28, padding:'0 10px', background:'var(--accent)', color:'#fff', border:'none', cursor:'pointer', fontSize:12, fontWeight:700, borderRadius:3 }}>{t.account.save}</button>
                          <button type="button" onClick={cancelRename} style={{ height:28, padding:'0 8px', background:'transparent', color:'var(--ink-3)', border:'1px solid var(--border-r)', cursor:'pointer', fontSize:12, borderRadius:3 }}>✕</button>
                        </div>
                      ) : (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <div style={{ color:'var(--ink)', fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{account.username}</div>
                          {account.type === 'offline' && (
                            <button type="button" title="Rename" onClick={() => startRename(account)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--ink-4)', fontSize:13, padding:'0 2px', lineHeight:1 }}>✎</button>
                          )}
                        </div>
                      )}
                      <div style={{ color:badge.color, fontFamily:"'VT323',monospace", fontSize:15, letterSpacing:'.08em', marginTop:2 }}>{badge.label}</div>
                      <div style={{ color:'var(--ink-4)', fontSize:11, lineHeight:1.35, marginTop:4 }}>{accessText(account, t)}</div>
                    </div>
                  </div>
                  {isActive && <div style={{ color:'var(--accent)', fontFamily:"'VT323',monospace", fontSize:15, flexShrink:0 }}>{t.account.activeLabel}</div>}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button
                    type="button"
                    onClick={() => selectAccount(account.uuid)}
                    disabled={isActive || !!busy}
                    style={{ flex:1, height:30, background:'var(--bg)', color:'var(--ink-2)', border:'1px solid var(--border-r)', cursor:'pointer', opacity:isActive ? .5 : 1 }}
                  >
                    {t.account.use}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSkinTarget(skinTarget === account.uuid ? null : account.uuid); setSkinPath(null); setSkinMsg(null) }}
                    style={{ height:30, padding:'0 10px', background:'transparent', color:'var(--ink-3)', border:'1px solid var(--border-r)', cursor:'pointer', fontSize:12 }}
                  >
                    🎨 Skin
                  </button>
                  <button
                    type="button"
                    onClick={() => logout(account.uuid)}
                    disabled={!!busy}
                    style={{ height:30, padding:'0 10px', background:'transparent', color:'var(--redstone)', border:'1px solid rgba(217,59,59,.45)', cursor:'pointer' }}
                  >
                    {t.account.signOut}
                  </button>
                </div>

                {/* Skin change panel */}
                {skinTarget === account.uuid && (
                  <div style={{ marginTop:8, padding:12, background:'var(--bg)', border:'1px solid var(--border-r)', borderRadius:4, display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--ink-3)' }}>
                      {account.type === 'microsoft' ? 'Upload skin to Minecraft account' : account.type === 'yggdrasil' ? 'Change skin (opens browser)' : 'Set launcher avatar skin'}
                    </div>

                    {account.type === 'yggdrasil' ? (
                      <button
                        type="button"
                        onClick={() => api.auth.uploadSkin(account.uuid, '', 'classic').catch(() => {})}
                        style={{ height:32, padding:'0 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:3, cursor:'pointer', fontSize:12, fontWeight:600 }}
                      >
                        Open skin page ↗
                      </button>
                    ) : (
                      <>
                        <div style={{ display:'flex', gap:8 }}>
                          <button
                            type="button"
                            onClick={async () => { const p = await api.auth.browseSkin(); if (p) setSkinPath(p) }}
                            style={{ flex:1, height:32, background:'var(--surface-2)', color:'var(--ink-2)', border:'1px solid var(--border-r)', borderRadius:3, cursor:'pointer', fontSize:12 }}
                          >
                            {skinPath ? '✓ ' + skinPath.split(/[/\\]/).pop() : 'Browse PNG…'}
                          </button>
                          {account.type === 'microsoft' && (
                            <select
                              value={skinVariant}
                              onChange={e => setSkinVariant(e.target.value as 'classic' | 'slim')}
                              style={{ height:32, background:'var(--bg)', border:'1px solid var(--border-r)', color:'var(--ink)', padding:'0 8px', borderRadius:3, cursor:'pointer', fontSize:12 }}
                            >
                              <option value="classic">Classic (Steve)</option>
                              <option value="slim">Slim (Alex)</option>
                            </select>
                          )}
                        </div>
                        {skinPath && (
                          <img
                            src={`file://${skinPath}`}
                            alt="skin preview"
                            style={{ width:64, height:64, imageRendering:'pixelated', border:'1px solid var(--border-r)', borderRadius:3, alignSelf:'flex-start' }}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => void handleSkinUpload(account.uuid)}
                          disabled={!skinPath || skinUploading}
                          style={{ height:32, padding:'0 14px', background: skinPath && !skinUploading ? 'var(--accent)' : 'var(--surface-3)', color: skinPath && !skinUploading ? '#fff' : 'var(--ink-4)', border:'none', borderRadius:3, cursor: skinPath && !skinUploading ? 'pointer' : 'not-allowed', fontSize:12, fontWeight:600 }}
                        >
                          {skinUploading ? 'Uploading…' : account.type === 'microsoft' ? 'Upload skin' : 'Save as avatar'}
                        </button>
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
