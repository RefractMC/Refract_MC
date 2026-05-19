import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/account/')({
  component: Account,
})

type SafeAccount = Awaited<ReturnType<typeof window.api.auth.accounts>>[number]
type DeviceLogin = Awaited<ReturnType<typeof window.api.auth.microsoftBegin>>

function accountBadge(type: SafeAccount['type']) {
  if (type === 'microsoft') return { label: 'MICROSOFT', color: 'var(--diamond)' }
  if (type === 'offline') return { label: 'OFFLINE', color: 'var(--gold)' }
  return { label: 'YGGDRASIL', color: 'var(--ender)' }
}

function Account() {
  const [accounts, setAccounts] = useState<SafeAccount[]>([])
  const [active, setActive] = useState<SafeAccount | null>(null)
  const [device, setDevice] = useState<DeviceLogin | null>(null)
  const [offlineName, setOfflineName] = useState('Steve')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const [nextAccounts, nextActive] = await Promise.all([
      window.api.auth.accounts(),
      window.api.auth.active(),
    ])
    setAccounts(nextAccounts)
    setActive(nextActive)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

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
    const result = await run('microsoft-begin', () => window.api.auth.microsoftBegin())
    if (result) setDevice(result)
  }

  async function completeMicrosoft() {
    if (!device) return
    const account = await run('microsoft-complete', () => window.api.auth.microsoftComplete(device.deviceCode))
    if (account) {
      setDevice(null)
      await refresh()
    }
  }

  async function createOffline() {
    const account = await run('offline-create', () => window.api.auth.createOffline(offlineName))
    if (account) await refresh()
  }

  async function selectAccount(uuid: string) {
    const account = await run(`active-${uuid}`, () => window.api.auth.setActive(uuid))
    if (account) await refresh()
  }

  async function logout(uuid: string) {
    await run(`logout-${uuid}`, () => window.api.auth.logout(uuid))
    await refresh()
  }

  return (
    <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.05fr) 360px', gap:18, minHeight:'100%' }}>
      <section style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius)', overflow:'hidden' }}>
        <div style={{ padding:'18px 20px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
          <div>
            <h1 style={{ margin:0, color:'var(--ink)', fontSize:24, lineHeight:1.1 }}>Accounts</h1>
            <p style={{ margin:'6px 0 0', color:'var(--ink-3)', fontSize:13 }}>
              Sign in with Microsoft to use your licensed Minecraft profile.
            </p>
          </div>
          {active && (
            <div style={{ fontFamily:"'VT323',monospace", color:'var(--accent)', fontSize:18, letterSpacing:'.08em' }}>
              ACTIVE: {active.username}
            </div>
          )}
        </div>

        <div style={{ padding:20, display:'grid', gap:14 }}>
          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:4, padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16 }}>Microsoft Minecraft Account</h2>
            <p style={{ margin:'0 0 14px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              Refract uses Microsoft device login. Tokens are saved only in the Electron main process config and encrypted when OS encryption is available.
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
              SIGN IN WITH MICROSOFT
            </button>

            {device && (
              <div style={{ marginTop:16, padding:14, background:'var(--bg)', border:'1px solid var(--accent)', borderRadius:4 }}>
                <div style={{ color:'var(--ink-3)', fontSize:12, marginBottom:8 }}>Enter this code at Microsoft:</div>
                <div style={{ fontFamily:"'VT323',monospace", color:'var(--ink)', fontSize:34, letterSpacing:'.18em', lineHeight:1 }}>
                  {device.userCode}
                </div>
                <a href={device.verificationUri} style={{ display:'inline-block', marginTop:10, color:'var(--diamond)', fontSize:13 }}>
                  {device.verificationUri}
                </a>
                <div style={{ marginTop:12 }}>
                  <button
                    type="button"
                    onClick={completeMicrosoft}
                    disabled={!!busy}
                    style={{ height:34, padding:'0 14px', background:'var(--surface-3)', color:'var(--ink)', border:'1px solid var(--border-r)', cursor:'pointer' }}
                  >
                    I finished login
                  </button>
                </div>
              </div>
            )}
          </div>

          <div style={{ background:'var(--surface-2)', border:'1px solid var(--border-r)', borderRadius:4, padding:16 }}>
            <h2 style={{ margin:'0 0 8px', color:'var(--ink)', fontSize:16 }}>Offline Profile</h2>
            <p style={{ margin:'0 0 12px', color:'var(--ink-3)', fontSize:13, lineHeight:1.5 }}>
              Useful for launcher development and local vanilla testing. Online services require Microsoft login.
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
                Add
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
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--line)', color:'var(--ink)', fontWeight:700 }}>Saved Profiles</div>
        <div style={{ padding:12, display:'grid', gap:8 }}>
          {accounts.length === 0 ? (
            <p style={{ color:'var(--ink-3)', fontSize:13, margin:4 }}>No accounts yet.</p>
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
                  <div style={{ minWidth:0 }}>
                    <div style={{ color:'var(--ink)', fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{account.username}</div>
                    <div style={{ color:badge.color, fontFamily:"'VT323',monospace", fontSize:15, letterSpacing:'.08em' }}>{badge.label}</div>
                  </div>
                  {isActive && <div style={{ color:'var(--accent)', fontFamily:"'VT323',monospace", fontSize:15 }}>ACTIVE</div>}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button
                    type="button"
                    onClick={() => selectAccount(account.uuid)}
                    disabled={isActive || !!busy}
                    style={{ flex:1, height:30, background:'var(--bg)', color:'var(--ink-2)', border:'1px solid var(--border-r)', cursor:'pointer', opacity:isActive ? .5 : 1 }}
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    onClick={() => logout(account.uuid)}
                    disabled={!!busy}
                    style={{ height:30, padding:'0 10px', background:'transparent', color:'var(--redstone)', border:'1px solid rgba(217,59,59,.45)', cursor:'pointer' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
