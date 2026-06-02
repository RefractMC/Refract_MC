import { Link, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { SignOutIcon } from '../ui/BlockIcons'
import { api, type SafeAccount } from '@/lib/api'
import { useT } from '@/i18n'
import type { Instance } from '@refract/core'
import discordIcon          from '@/assets/discord-icon.webp'
import libraryIconRaw    from '@/assets/instance-library.svg?raw'
import browseModsIconRaw from '@/assets/browse-mods.svg?raw'
import modpacksIconRaw   from '@/assets/modpacks.svg?raw'
import accountIconRaw    from '@/assets/account.svg?raw'
import settingsIconRaw   from '@/assets/settings.svg?raw'

function svgDataUrl(raw: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`
}

const libraryIcon    = svgDataUrl(libraryIconRaw)
const browseModsIcon = svgDataUrl(browseModsIconRaw)
const modpacksIcon   = svgDataUrl(modpacksIconRaw)
const accountIcon    = svgDataUrl(accountIconRaw)
const settingsIcon   = svgDataUrl(settingsIconRaw)

function NavIcon({ src, size = 18 }: { src: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: 'currentColor',
      WebkitMaskImage: `url(${src})`,
      WebkitMaskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskImage: `url(${src})`,
      maskSize: 'contain',
      maskRepeat: 'no-repeat',
      maskPosition: 'center',
    }} />
  )
}

interface Friend {
  uuid: string
  username: string
  addedAt: number
  note?: string
}

function avatarUrl(uuid: string, fallback = false): string {
  const id = uuid.replace(/-/g, '')
  return fallback
    ? `https://crafatar.com/avatars/${id}?size=32&overlay=true&default=MHF_Steve`
    : `https://mc-heads.net/avatar/${id}/32`
}

interface NavItemProps { to: string; label: string; iconSrc: string; exact: boolean }
function NavItem({ to, label, iconSrc, exact }: NavItemProps) {
  const matchRoute = useMatchRoute()
  const active = !!matchRoute({ to: to as '/', fuzzy: !exact })
  const [hover, setHover] = useState(false)

  return (
    <Link
      to={to as '/'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 4,
        color: active ? 'var(--ink)' : hover ? 'var(--ink)' : 'var(--ink-2)',
        fontSize: 13, fontWeight: 500, textDecoration: 'none',
        background: active ? 'var(--accent-tint)' : hover ? 'rgba(255,255,255,.05)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : hover ? 'rgba(255,255,255,.08)' : 'transparent'}`,
        userSelect: 'none',
        transition: 'background 100ms, color 100ms, border-color 100ms',
      }}
    >
      {active && <div style={{ position:'absolute', left:-13, top:6, bottom:6, width:3, background:'var(--accent)' }} />}
      <NavIcon src={iconSrc} />
      <span>{label}</span>
    </Link>
  )
}

function AvatarStatus({ account }: { account: SafeAccount | null }) {
  const t = useT()
  if (!account) return <>{t.sidebar.notSignedIn}</>
  return <>{account.canPlayMinecraft ? t.sidebar.playEnabled : t.sidebar.offline}</>
}

function AvatarBlock() {
  const [account, setAccount] = useState<SafeAccount | null>(null)
  const [skinFailed, setSkinFailed] = useState(false)
  const [skinFallback, setSkinFallback] = useState(false)

  useEffect(() => {
    setSkinFailed(false)
    setSkinFallback(false)
    api.auth.active().then(setAccount).catch(() => setAccount(null))
    const id = window.setInterval(() => {
      api.auth.active().then(setAccount).catch(() => setAccount(null))
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  async function signOut() {
    if (!account) return
    try { await api.auth.logout(account.uuid); setAccount(null) } catch { /* ignore */ }
  }

  const initial = account?.username[0]?.toUpperCase() ?? '?'
  const hasSkin = !!account && account.type !== 'offline'

  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 6px 14px', borderBottom:'1px solid var(--sb-line)', marginBottom:10 }}>
      {/* Avatar */}
      <div style={{ width:38, height:38, flexShrink:0, border:'1px solid #000', position:'relative', overflow:'hidden', background:'#1a1f2e', imageRendering:'pixelated' }}>
        {hasSkin && !skinFailed ? (
          <img
            src={skinFallback ? avatarUrl(account.uuid, true) : avatarUrl(account.uuid)}
            alt={account.username}
            style={{ width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated' }}
            onError={() => { if (!skinFallback) setSkinFallback(true); else setSkinFailed(true) }}
          />
        ) : (
          <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'VT323',monospace", fontSize:20, color:'var(--ink-3)' }}>
            {initial}
          </div>
        )}
      </div>

      {/* Name + status */}
      <div style={{ minWidth:0, flex:1 }}>
        <div style={{ fontFamily:"'VT323',monospace", fontSize:18, letterSpacing:'.10em', color:'var(--ink)', lineHeight:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {account ? account.username.toUpperCase() : 'GUEST'}
        </div>
        <div style={{ fontFamily:"'VT323',monospace", fontSize:12, color: account?.canPlayMinecraft ? 'var(--grass)' : 'var(--gold)', letterSpacing:'.04em', lineHeight:1.4 }}>
          <AvatarStatus account={account} />
        </div>
      </div>

      {/* Sign out */}
      {account && (
        <button onClick={signOut} title="Sign out" style={{ background:'none', border:'none', cursor:'pointer', color:'var(--ink-4)', padding:4, display:'flex', opacity:.7 }}>
          <SignOutIcon />
        </button>
      )}
    </div>
  )
}

function FriendsPanel() {
  const t = useT()
  const [friends, setFriends] = useState<Friend[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [myUsername, setMyUsername] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.friends.list().then(list => setFriends(list as Friend[])).catch(() => {})
    api.auth.active().then(a => setMyUsername(a?.username ?? null)).catch(() => {})
    api.instance.list().then(setInstances).catch(() => {})
  }, [])

  const handleNoteChange = useCallback(async (uuid: string, note: string) => {
    await api.friends.updateNote(uuid, note).catch(() => {})
    setFriends(prev => prev.map(f => f.uuid === uuid ? { ...f, note: note.trim() || undefined } : f))
  }, [])

  function startAdd() {
    setAdding(true)
    setInput('')
    setError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function cancelAdd() {
    setAdding(false)
    setInput('')
    setError(null)
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    const name = input.trim()
    if (!name) return
    if (myUsername && name.toLowerCase() === myUsername.toLowerCase()) {
      setError("That's you — you can't add yourself as a friend.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const friend = await api.friends.add(name) as Friend
      setFriends(prev => [...prev, friend])
      setAdding(false)
      setInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add friend.')
    } finally {
      setLoading(false)
    }
  }

  async function removeFriend(uuid: string) {
    try {
      await api.friends.remove(uuid)
      setFriends(prev => prev.filter(f => f.uuid !== uuid))
    } catch { /* ignore */ }
  }

  return (
    <div style={{ marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--sb-line)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 6px' }}>
        <h5 style={{ margin: 0, fontSize: 10, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
          {t.sidebar.friends}{friends.length > 0 && ` · ${friends.length}`}
        </h5>
        {!adding && (
          <button
            onClick={startAdd}
            title="Add friend"
            style={{
              background: 'none', border: '1px solid var(--border-r)',
              color: 'var(--ink-4)', cursor: 'pointer',
              width: 18, height: 18, borderRadius: 3,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, lineHeight: 1, padding: 0,
              transition: 'color .12s, border-color .12s',
            }}
            onMouseEnter={e => {
              const b = e.currentTarget
              b.style.color = 'var(--accent)'
              b.style.borderColor = 'var(--accent)'
            }}
            onMouseLeave={e => {
              const b = e.currentTarget
              b.style.color = 'var(--ink-4)'
              b.style.borderColor = 'var(--border-r)'
            }}
          >
            +
          </button>
        )}
      </div>

      {/* Add friend form */}
      {adding && (
        <form onSubmit={submitAdd} style={{ padding: '0 6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={t.sidebar.usernamePlaceholder}
              disabled={loading}
              style={{
                flex: 1, height: 26, fontSize: 11, padding: '0 7px',
                background: 'var(--bg)', border: '1px solid var(--border-r)',
                color: 'var(--ink)', borderRadius: 3, outline: 'none',
                opacity: loading ? 0.6 : 1,
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              style={{
                height: 26, padding: '0 8px', fontSize: 11, fontWeight: 600,
                background: loading || !input.trim() ? 'var(--surface-3)' : 'var(--accent)',
                color: loading || !input.trim() ? 'var(--ink-4)' : '#fff',
                border: 'none', borderRadius: 3,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? '…' : t.sidebar.addFriend}
            </button>
            <button
              type="button"
              onClick={cancelAdd}
              disabled={loading}
              style={{
                height: 26, width: 26, fontSize: 13,
                background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                color: 'var(--ink-4)', borderRadius: 3, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          </div>
          {error && (
            <div style={{ fontSize: 10, color: 'var(--lava)', lineHeight: 1.3 }}>{error}</div>
          )}
        </form>
      )}

      {/* Friend list */}
      {friends.length === 0 && !adding ? (
        <div style={{ padding: '6px 8px 4px', fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>
          {t.sidebar.noFriends}{' '}
          <button
            onClick={startAdd}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}
          >
            {t.sidebar.addOne}
          </button>
        </div>
      ) : (
        friends.map(friend => (
          <FriendRow key={friend.uuid} friend={friend} instances={instances} onRemove={() => removeFriend(friend.uuid)} onNoteChange={(note) => handleNoteChange(friend.uuid, note)} />
        ))
      )}
    </div>
  )
}

function FriendRow({ friend, instances, onRemove, onNoteChange }: {
  friend: Friend
  instances: Instance[]
  onRemove: () => void
  onNoteChange: (note: string) => void
}) {
  const [hovered, setHovered]       = useState(false)
  const [imgSrc, setImgSrc] = useState(() => avatarUrl(friend.uuid))
  const [imgFailed, setImgFailed]   = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft]   = useState(friend.note ?? '')
  const [copied, setCopied]         = useState<string | null>(null)
  const noteRef = useRef<HTMLInputElement>(null)

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(key)
    setTimeout(() => setCopied(null), 1600)
  }

  function openNameMC() {
    const shell = (window as Window & { electron?: { shell?: { openExternal?: (url: string) => void } } }).electron?.shell
    if (shell?.openExternal) shell.openExternal(`https://namemc.com/profile/${friend.uuid}`)
    else window.open(`https://namemc.com/profile/${friend.uuid}`, '_blank')
  }

  function startNote() {
    setNoteDraft(friend.note ?? '')
    setEditingNote(true)
    setTimeout(() => noteRef.current?.focus(), 0)
  }

  function commitNote() {
    setEditingNote(false)
    const trimmed = noteDraft.trim()
    if (trimmed !== (friend.note ?? '')) onNoteChange(trimmed)
  }

  // installed instances shared with this friend (same MC version)
  const sharedInstances = instances.filter(i => i.isInstalled)
  const versionChips = [...new Set(sharedInstances.map(i =>
    i.modLoader ? `${i.minecraftVersion} ${i.modLoader}` : i.minecraftVersion
  ))].slice(0, 3)

  return (
    <div
      style={{ padding: '5px 6px', borderRadius: 4, background: hovered ? 'var(--surface-2)' : 'transparent', transition: 'background .1s' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row: avatar + name + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Avatar — click opens NameMC */}
        <div
          onClick={openNameMC}
          title="View on NameMC"
          style={{ width: 24, height: 24, flexShrink: 0, position: 'relative', overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-3)', imageRendering: 'pixelated', cursor: 'pointer' }}
        >
          {!imgFailed ? (
            <img src={imgSrc} alt={friend.username}
              style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
              onError={() => {
                if (!imgSrc.includes('crafatar')) setImgSrc(avatarUrl(friend.uuid, true))
                else setImgFailed(true)
              }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--ink-3)' }}>
              {friend.username[0]?.toUpperCase()}
            </div>
          )}
        </div>

        {/* Username — click opens NameMC */}
        <div
          onClick={openNameMC}
          title="View on NameMC"
          style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}
        >
          {friend.username}
        </div>

        {/* Action buttons (visible on hover) */}
        {hovered && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <ActionBtn title="Copy UUID" active={copied === 'uuid'} onClick={() => copy(friend.uuid, 'uuid')}>
              {copied === 'uuid' ? '✓' : '#'}
            </ActionBtn>
            <ActionBtn title="Copy /whitelist add command" active={copied === 'wl'} onClick={() => copy(`/whitelist add ${friend.username}`, 'wl')}>
              {copied === 'wl' ? '✓' : '⊕'}
            </ActionBtn>
            <ActionBtn title="Add note" onClick={startNote}>✎</ActionBtn>
            <ActionBtn title="Remove friend" danger onClick={onRemove}>✕</ActionBtn>
          </div>
        )}
      </div>

      {/* Note row */}
      {editingNote ? (
        <input
          ref={noteRef}
          value={noteDraft}
          onChange={e => setNoteDraft(e.target.value)}
          onBlur={commitNote}
          onKeyDown={e => { if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') { setEditingNote(false) } }}
          placeholder="Add a note…"
          style={{ marginTop: 4, width: '100%', fontSize: 10, padding: '2px 5px', background: 'var(--bg)', border: '1px solid var(--accent)', color: 'var(--ink)', borderRadius: 2, outline: 'none', boxSizing: 'border-box' }}
        />
      ) : friend.note ? (
        <div onClick={startNote} title="Click to edit note" style={{ marginTop: 3, fontSize: 10, color: 'var(--ink-4)', fontStyle: 'italic', cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 32 }}>
          {friend.note}
        </div>
      ) : null}

      {/* Shared instances chips */}
      {versionChips.length > 0 && hovered && (
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4, paddingLeft: 32 }}>
          {versionChips.map(v => (
            <span key={v} style={{ fontSize: 9, padding: '1px 5px', background: 'var(--accent-tint)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 2, whiteSpace: 'nowrap' }}>
              {v}
            </span>
          ))}
          {sharedInstances.length > versionChips.length && (
            <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>+{sharedInstances.length - versionChips.length}</span>
          )}
        </div>
      )}
    </div>
  )
}

function ActionBtn({ title, onClick, children, danger, active }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      title={title}
      style={{
        width: 18, height: 18, padding: 0, border: 'none',
        background: active ? 'var(--grass)' : 'transparent',
        color: active ? '#fff' : danger ? 'var(--lava)' : 'var(--ink-4)',
        cursor: 'pointer', borderRadius: 2, fontSize: 11, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color .1s, background .1s',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget).style.color = danger ? 'var(--lava)' : 'var(--ink)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget).style.color = danger ? 'var(--lava)' : 'var(--ink-4)' }}
    >
      {children}
    </button>
  )
}

function RefractLogo({ size = 32 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220" width={size} height={size} style={{ flexShrink: 0 }}>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#5316D4"/>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#3D0FA3" transform="rotate(30)"/>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#8A52FF" transform="rotate(60)"/>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#3D0FA3" transform="rotate(90)"/>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#5316D4" transform="rotate(120)"/>
      <polygon points="0,-92 14,0 0,92 -14,0" fill="#8A52FF" transform="rotate(150)"/>
      <circle r="24" fill="#1B044F"/>
      <circle r="6" fill="#ECE4FF"/>
    </svg>
  )
}

export function Sidebar() {
  const t = useT()
  const navItems: NavItemProps[] = [
    { to: '/',          label: t.nav.library, iconSrc: libraryIcon,    exact: true  },
    { to: '/browse/',   label: t.nav.browse,  iconSrc: browseModsIcon, exact: false },
    { to: '/modpacks/', label: t.nav.content, iconSrc: modpacksIcon,   exact: false },
  ]
  return (
    <aside style={{
      gridRow:'2/3', gridColumn:'1/2',
      background:'var(--sb)', borderRight:'1px solid var(--line)',
      display:'flex', flexDirection:'column',
      padding:'14px 12px 12px', minHeight:0, overflowY:'auto',
    }}>
      {/* Brand mark */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'0 6px 14px', borderBottom:'1px solid var(--sb-line)', marginBottom:12 }}>
        <RefractLogo size={32} />
        <span style={{ fontFamily:"'VT323',monospace", fontSize:20, letterSpacing:'.12em', color:'var(--ink)', lineHeight:1 }}>REFRACT</span>
      </div>

      <Link to="/account" style={{ textDecoration:'none', display:'block', borderRadius:4, transition:'background 120ms' }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,.05)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
      >
        <AvatarBlock />
      </Link>

      {/* Nav */}
      <div style={{ fontSize:10, fontWeight:600, letterSpacing:'.16em', textTransform:'uppercase', color:'var(--ink-4)', padding:'10px 8px 6px' }}>{t.nav.header}</div>
      <nav style={{ display:'flex', flexDirection:'column', gap:2 }}>
        {navItems.map(n => <NavItem key={n.to} {...n} />)}
      </nav>

      {/* Friends */}
      <FriendsPanel />

      {/* Bottom */}
      <div style={{ marginTop:'auto', display:'flex', flexDirection:'column', gap:2, paddingTop:10, borderTop:'1px solid var(--sb-line)' }}>
        <NavItem to="/settings" label={t.nav.settings} iconSrc={settingsIcon} exact={true} />
        <button
          onClick={() => window.open('https://discord.gg/SUPuuTjMGU')}
          style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:4, color:'var(--ink-2)', fontSize:13, fontWeight:500, background:'none', border:'1px solid transparent', cursor:'pointer', textAlign:'left' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#5865F2'; e.currentTarget.style.background = 'rgba(88,101,242,.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-2)'; e.currentTarget.style.background = 'none' }}
        >
          <div style={{ width:18, height:18, display:'flex', alignItems:'center', justifyContent:'center' }}><img src={discordIcon} alt="Discord" style={{ width:16, height:16, objectFit:'contain', opacity:.75 }} /></div>
          <span>{t.nav.discord}</span>
        </button>
      </div>
    </aside>
  )
}
