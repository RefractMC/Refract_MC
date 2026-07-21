import { Link, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { SignOutIcon } from '../ui/BlockIcons'
import { api, type SafeAccount } from '@/lib/api'
import { useT } from '@/i18n'
import { useThemeStore } from '@/stores/theme'
import { loadSkinFaceDataUrl, subscribeSkinFaceRefresh } from '@/lib/skin-face'
import { SkinViewer3DLazy } from '../ui/SkinViewer3DLazy'
import discordIcon          from '@/assets/discord-icon.webp'
import libraryIconRaw    from '@/assets/instance-library.svg?raw'
import browseModsIconRaw from '@/assets/browse-mods.svg?raw'
import modpacksIconRaw   from '@/assets/modpacks.svg?raw'
import settingsIconRaw   from '@/assets/settings.svg?raw'
import skinsIconRaw      from '@/assets/skins.svg?raw'

function svgDataUrl(raw: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`
}

const libraryIcon    = svgDataUrl(libraryIconRaw)
const browseModsIcon = svgDataUrl(browseModsIconRaw)
const modpacksIcon   = svgDataUrl(modpacksIconRaw)
const settingsIcon   = svgDataUrl(settingsIconRaw)
const skinsIcon      = svgDataUrl(skinsIconRaw)
const newsIcon       = svgDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 6h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/>
  <path d="M4 10h16"/>
  <path d="M8 6v12"/>
  <path d="M12 10h4"/>
  <path d="M12 14h4"/>
</svg>`)

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

interface NavItemProps { to: string; label: string; iconSrc: string; exact: boolean; compact?: boolean }
function NavItem({ to, label, iconSrc, exact, compact }: NavItemProps) {
  const matchRoute = useMatchRoute()
  const active = !!matchRoute({ to: to as '/', fuzzy: !exact })
  const [hover, setHover] = useState(false)

  return (
    <Link
      to={to as '/'}
      title={compact ? label : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start',
        gap: compact ? 0 : 10,
        padding: compact ? '9px 0' : '9px 10px', borderRadius: 'var(--radius-sm)',
        color: active ? 'var(--ink)' : hover ? 'var(--ink)' : 'var(--ink-2)',
        fontSize: 13, fontWeight: 500, textDecoration: 'none',
        background: active ? 'var(--sidebar-item-active-bg)' : hover ? 'var(--sidebar-item-hover-bg)' : 'transparent',
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 58%, transparent)' : hover ? 'rgba(255,255,255,.08)' : 'transparent'}`,
        userSelect: 'none',
        transition: 'background 100ms, color 100ms, border-color 100ms',
      }}
    >
      {active && !compact && <div style={{ position:'absolute', left:-13, top:6, bottom:6, width:3, background:'var(--accent)', borderRadius:2, boxShadow:'0 0 12px var(--accent)' }} />}
      <NavIcon src={iconSrc} size={compact ? 20 : 18} />
      {!compact && <span>{label}</span>}
    </Link>
  )
}

function AvatarStatus({ account }: { account: SafeAccount | null }) {
  const t = useT()
  if (!account) return <>{t.sidebar.notSignedIn}</>
  return <>{account.canPlayMinecraft ? t.sidebar.playEnabled : t.sidebar.offline}</>
}

function AvatarBlock({ compact }: { compact: boolean }) {
  const t = useT()
  const [account, setAccount] = useState<SafeAccount | null>(null)
  const [faceUrl, setFaceUrl] = useState<string | null>(null)

  useEffect(() => {
    api.auth.active().then(setAccount).catch(() => setAccount(null))
    const id = window.setInterval(() => {
      api.auth.active().then(setAccount).catch(() => setAccount(null))
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!account || account.type === 'offline') {
      setFaceUrl(null)
      return
    }

    let alive = true
    const load = async () => {
      const face = await loadSkinFaceDataUrl(account.uuid, 64, api.auth.fetchSkinTextureUrl)
      if (alive) setFaceUrl(face)
    }
    setFaceUrl(null)
    void load()
    const unsubscribe = subscribeSkinFaceRefresh(({ uuid }) => {
      if (!uuid || uuid === account.uuid) void load()
    })
    return () => { alive = false; unsubscribe() }
  }, [account?.uuid, account?.type])

  async function signOut() {
    if (!account) return
    try { await api.auth.logout(account.uuid); setAccount(null) } catch { /* ignore */ }
  }

  const initial = account?.username[0]?.toUpperCase() ?? '?'
  const avatar = (
    <div style={{ width:38, height:38, flexShrink:0, border:'1px solid #000', position:'relative', overflow:'hidden', background:'#1a1f2e', imageRendering:'pixelated' }}>
      {faceUrl ? (
        <img
          src={faceUrl}
          alt={account?.username}
          style={{ width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated' }}
          onError={() => setFaceUrl(null)}
        />
      ) : (
        <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:600, color:'var(--ink-3)' }}>
          {initial}
        </div>
      )}
    </div>
  )

  if (compact) {
    return (
      <div title={account?.username ?? t.sidebar.guest} style={{ display:'flex', justifyContent:'center', padding:'6px 0 12px', borderBottom:'1px solid var(--sb-line)' }}>
        {avatar}
      </div>
    )
  }

  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, minHeight:52, padding:'6px 6px 12px', borderBottom:'1px solid var(--sb-line)' }}>
      {avatar}
      <div style={{ minWidth:0, flex:1, display:'flex', flexDirection:'column', justifyContent:'center', alignSelf:'stretch' }}>
        <div style={{ fontSize:14, fontWeight:600, color:'var(--ink)', lineHeight:'18px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {account ? account.username : t.sidebar.guest}
        </div>
        <div style={{ fontSize:11, color: account?.canPlayMinecraft ? 'var(--grass)' : 'var(--gold)', lineHeight:'14px' }}>
          <AvatarStatus account={account} />
        </div>
      </div>
      {account && (
        <button onClick={signOut} title={t.sidebar.signOut} style={{ width:28, height:28, background:'none', border:'none', cursor:'pointer', color:'var(--ink-4)', padding:0, display:'flex', alignItems:'center', justifyContent:'center', opacity:.7, flexShrink:0 }}>
          <SignOutIcon />
        </button>
      )}
    </div>
  )
}

function SkinPopup({ friend, onClose }: { friend: Friend; onClose: () => void }) {
  const [skinUrl, setSkinUrl] = useState<string | null>(null)

  useEffect(() => {
    api.auth.fetchSkinTextureUrl(friend.uuid).then(url => setSkinUrl(url ?? null)).catch(() => {})
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [friend.uuid, onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 8, padding: '16px 16px 12px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          position: 'relative', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
        }}
      >
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-4)', fontSize: 16, lineHeight: 1, padding: 4 }}
        >✕</button>
        <SkinViewer3DLazy skinUrl={skinUrl} width={160} height={240} walk rotate />
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
          {friend.username}
        </div>
      </div>
    </div>
  )
}

function FriendsPanel() {
  const t = useT()
  const [friends, setFriends] = useState<Friend[]>([])
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [myUsername, setMyUsername] = useState<string | null>(null)
  const [skinTarget, setSkinTarget] = useState<Friend | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refreshFriends = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true)
    else setListLoading(true)
    setError(null)
    try {
      const [list, active] = await Promise.all([
        api.friends.list(),
        api.auth.active().catch(() => null),
      ])
      setFriends(list as Friend[])
      setMyUsername(active?.username ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.sidebar.refreshFriendsFailed)
    } finally {
      if (showRefreshing) setRefreshing(false)
      else setListLoading(false)
    }
  }, [t.sidebar.refreshFriendsFailed])

  useEffect(() => {
    void refreshFriends(false)
  }, [refreshFriends])

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
      setError(t.sidebar.selfAddError)
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
      setError(err instanceof Error ? err.message : t.sidebar.addFriendFailed)
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => void refreshFriends(true)}
            title={t.sidebar.refreshFriends}
            disabled={refreshing || listLoading}
            style={{
              background: 'none', border: '1px solid var(--border-r)',
              color: refreshing || listLoading ? 'var(--ink-5)' : 'var(--ink-4)',
              cursor: refreshing || listLoading ? 'wait' : 'pointer',
              width: 18, height: 18, borderRadius: 3,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, lineHeight: 1, padding: 0,
              transition: 'color .12s, border-color .12s',
            }}
          >
            {refreshing ? '...' : 'R'}
          </button>
          {!adding && (
            <button
              onClick={startAdd}
              title={t.sidebar.addFriendTitle}
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
      {listLoading ? (
        <div style={{ padding: '6px 8px 4px', fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>
          {t.sidebar.loadingFriends}
        </div>
      ) : friends.length === 0 && !adding ? (
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
          <FriendRow key={friend.uuid} friend={friend} onRemove={() => removeFriend(friend.uuid)} onNoteChange={(note) => handleNoteChange(friend.uuid, note)} onSkinClick={() => setSkinTarget(friend)} />
        ))
      )}
      {skinTarget && <SkinPopup friend={skinTarget} onClose={() => setSkinTarget(null)} />}
    </div>
  )
}

function FriendRow({ friend, onRemove, onNoteChange, onSkinClick }: {
  friend: Friend
  onRemove: () => void
  onNoteChange: (note: string) => void
  onSkinClick: () => void
}) {
  const t = useT()
  const [hovered, setHovered]       = useState(false)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [faceLoading, setFaceLoading] = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft]   = useState(friend.note ?? '')
  const [copied, setCopied]         = useState<string | null>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  const nameMcUrl = 'https://namemc.com/profile/' + friend.uuid

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(key)
    setTimeout(() => setCopied(null), 1600)
  }

  function openNameMC() {
    void api.external.open(nameMcUrl)
  }

  useEffect(() => {
    let alive = true
    const load = async () => {
      setFaceLoading(true)
      const face = await loadSkinFaceDataUrl(friend.uuid, 64, api.auth.fetchSkinTextureUrl)
      if (alive) {
        setImgSrc(face)
        setFaceLoading(false)
      }
    }
    setImgSrc(null)
    void load()
    const unsubscribe = subscribeSkinFaceRefresh(({ uuid }) => {
      if (!uuid || uuid === friend.uuid) void load()
    })
    return () => { alive = false; unsubscribe() }
  }, [friend.uuid])

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

  return (
    <div
      style={{ padding: '5px 6px', borderRadius: 4, background: hovered ? 'var(--surface-2)' : 'transparent', transition: 'background .1s' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row: avatar + name + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Avatar — click opens skin preview */}
        <div
          onClick={onSkinClick}
          title={t.sidebar.viewSkin}
          style={{ width: 24, height: 24, flexShrink: 0, position: 'relative', overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-3)', imageRendering: 'pixelated', cursor: 'pointer' }}
        >
          {imgSrc ? (
            <img
              src={imgSrc}
              alt={friend.username}
              style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
              onError={() => setImgSrc(null)}
            />
          ) : faceLoading ? (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: 'var(--ink-4)' }}>
              ...
            </div>
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: 'var(--ink-3)' }}>
              {friend.username[0]?.toUpperCase()}
            </div>
          )}
        </div>

        {/* Username — click opens NameMC */}
        <div
          onClick={openNameMC}
          title={t.sidebar.viewNameMc}
          style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}
        >
          {friend.username}
        </div>

        {/* Action buttons (visible on hover) */}
        {hovered && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <ActionBtn title={t.sidebar.copyUsername} active={copied === 'name'} onClick={() => copy(friend.username, 'name')}>
              A
            </ActionBtn>
            <ActionBtn title={t.sidebar.copyUuid} active={copied === 'uuid'} onClick={() => copy(friend.uuid, 'uuid')}>
              #
            </ActionBtn>
            <ActionBtn title={t.sidebar.copyNameMcLink} active={copied === 'namemc'} onClick={() => copy(nameMcUrl, 'namemc')}>
              N
            </ActionBtn>
            <ActionBtn title={t.sidebar.copyWhitelistCommand} active={copied === 'wl'} onClick={() => copy('/whitelist add ' + friend.username, 'wl')}>
              +
            </ActionBtn>
            <ActionBtn title={t.sidebar.addNote} onClick={startNote}>✎</ActionBtn>
            <ActionBtn title={t.sidebar.removeFriend} danger onClick={onRemove}>✕</ActionBtn>
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
          placeholder={t.sidebar.notePlaceholder}
          style={{ marginTop: 4, width: '100%', fontSize: 10, padding: '2px 5px', background: 'var(--bg)', border: '1px solid var(--accent)', color: 'var(--ink)', borderRadius: 2, outline: 'none', boxSizing: 'border-box' }}
        />
      ) : friend.note ? (
        <div onClick={startNote} title={t.sidebar.editNote} style={{ marginTop: 3, fontSize: 10, color: 'var(--ink-4)', fontStyle: 'italic', cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 32 }}>
          {friend.note}
        </div>
      ) : null}

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

function CollapseToggle({ compact, onClick, label }: { compact: boolean; onClick: () => void; label: string }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        height: 34,
        flexShrink: 0,
        padding: compact ? 0 : '0 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: compact ? 'center' : 'flex-start',
        gap: compact ? 0 : 10,
        background: hover ? 'var(--sidebar-item-hover-bg)' : 'transparent',
        border: '1px solid transparent',
        borderRadius: 4,
        cursor: 'pointer',
        color: hover ? 'var(--ink)' : 'var(--ink-2)',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1,
        textAlign: 'left',
        transition: 'background 100ms, color 100ms',
      }}
    >
      <svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d={compact ? 'M6 4l5 5-5 5' : 'M12 4L7 9l5 5'} />
      </svg>
      {!compact && <span>{label}</span>}
    </button>
  )
}

export function Sidebar() {
  const t = useT()
  const layoutOverrides = useThemeStore(s => s.layoutOverrides)
  const setLayoutOverride = useThemeStore(s => s.setLayoutOverride)
  const sidebarWidth = layoutOverrides.sidebarWidth ?? '232px'
  const compact = sidebarWidth === '60px'

  // Remember the last expanded width so the collapse toggle restores the user's
  // chosen Default/Wide size (kept in sync with the Settings → sidebar control)
  // rather than snapping to a fixed value.
  const lastExpanded = useRef(compact ? '232px' : sidebarWidth)
  useEffect(() => { if (!compact) lastExpanded.current = sidebarWidth }, [compact, sidebarWidth])
  const toggleCollapsed = () => setLayoutOverride({ sidebarWidth: compact ? lastExpanded.current : '60px' })
  const openDiscord = () => {
    void api.discord.openInvite()
  }

  const navItems: NavItemProps[] = [
    { to: '/',          label: t.nav.library,    iconSrc: libraryIcon,    exact: true  },
    { to: '/browse/',   label: t.nav.browse,     iconSrc: browseModsIcon, exact: false },
    { to: '/news/',     label: t.nav.news,       iconSrc: newsIcon,       exact: false },
    { to: '/modpacks/', label: t.nav.content,    iconSrc: modpacksIcon,   exact: false },
    { to: '/skins',     label: t.skins.navLabel, iconSrc: skinsIcon,      exact: false },
  ]

  return (
    <aside className="launcher-sidebar" style={{
      gridRow:'1 / -1', gridColumn:'1/2',
      background:'var(--sidebar-bg)',
      display:'flex', flexDirection:'column',
      padding: compact ? '14px 8px 12px' : '14px 12px 12px',
      transition: 'padding 220ms cubic-bezier(.4,0,.2,1)',
      minHeight:0, overflow:'hidden',
      position:'relative',
      zIndex:4,
    }}>
      {/* Brand */}
      {compact ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'0 0 12px', borderBottom:'1px solid var(--sb-line)', marginBottom:8 }}>
          <RefractLogo size={32} />
        </div>
      ) : (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'0 6px 12px', borderBottom:'1px solid var(--sb-line)', marginBottom:8 }}>
          <RefractLogo size={32} />
          <span style={{ fontSize:16, fontWeight:800, letterSpacing:'.14em', color:'var(--ink)', lineHeight:1 }}>REFRACT</span>
        </div>
      )}

      <Link to="/account" style={{ textDecoration:'none', display:'block', borderRadius:4, transition:'background 100ms, border-color 100ms', border:'1px solid transparent', marginBottom:10 }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'rgba(255,255,255,.05)'; el.style.borderColor = 'rgba(255,255,255,.07)' }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.borderColor = 'transparent' }}
      >
        <AvatarBlock compact={compact} />
      </Link>

      {/* Nav */}
      {!compact && <div style={{ fontSize:10, fontWeight:600, letterSpacing:'.16em', textTransform:'uppercase', color:'var(--ink-4)', padding:'10px 8px 6px' }}>{t.nav.header}</div>}
      <nav style={{ display:'flex', flexDirection:'column', gap:2 }}>
        {navItems.map(n => <NavItem key={n.to} {...n} compact={compact} />)}
      </nav>

      {/* Friends — hidden in compact */}
      {!compact && <FriendsPanel />}

      {/* Bottom */}
      <div style={{ marginTop:'auto', flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:10, borderTop:'1px solid var(--sb-line)' }}>
        <NavItem to="/settings" label={t.nav.settings} iconSrc={settingsIcon} exact={true} compact={compact} />
        <button
          title={compact ? t.nav.discord : undefined}
          onClick={openDiscord}
          style={{ display:'flex', alignItems:'center', justifyContent: compact ? 'center' : 'flex-start', gap: compact ? 0 : 10, padding: compact ? '9px 0' : '8px 10px', borderRadius:4, color:'var(--ink-2)', fontSize:13, fontWeight:500, background:'none', border:'1px solid transparent', cursor:'pointer', textAlign:'left' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#5865F2'; e.currentTarget.style.background = 'rgba(88,101,242,.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-2)'; e.currentTarget.style.background = 'none' }}
        >
          <div style={{ width: compact ? 20 : 18, height: compact ? 20 : 18, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <img src={discordIcon} alt="Discord" style={{ width: compact ? 20 : 16, height: compact ? 20 : 16, objectFit:'contain', opacity:.75 }} />
          </div>
          {!compact && <span>{t.nav.discord}</span>}
        </button>
        <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--sb-line)' }}>
          <CollapseToggle compact={compact} onClick={toggleCollapsed} label={compact ? t.sidebar.expand : t.sidebar.collapse} />
        </div>
      </div>
    </aside>
  )
}
