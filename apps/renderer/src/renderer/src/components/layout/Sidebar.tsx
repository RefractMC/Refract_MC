import { Link, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { LibraryIcon, ModsIcon, ModpacksIcon, AccountIcon, CogIcon, SignOutIcon } from '../ui/BlockIcons'
import { useAvatarStore } from '@/stores/avatar'
import { compressImage } from '@/lib/image'
import { api, type SafeAccount } from '@/lib/api'
import { useT } from '@/i18n'

interface Friend {
  uuid: string
  username: string
  addedAt: number
}

function crafatarUrl(uuid: string): string {
  return `https://crafatar.com/avatars/${uuid}?size=32&overlay=true&default=MHF_Steve`
}

interface NavItemProps { to: string; label: string; Icon: ComponentType; exact: boolean }
function NavItem({ to, label, Icon, exact }: NavItemProps) {
  const matchRoute = useMatchRoute()
  const active = !!matchRoute({ to: to as '/', fuzzy: !exact })

  return (
    <Link
      to={to as '/'}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 4,
        color: active ? 'var(--ink)' : 'var(--ink-2)',
        fontSize: 13, fontWeight: 500, textDecoration: 'none',
        background: active ? 'var(--accent-tint)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        userSelect: 'none',
      }}
    >
      {active && <div style={{ position:'absolute', left:-13, top:6, bottom:6, width:3, background:'var(--accent)' }} />}
      <div style={{ width:18, height:18, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <Icon />
      </div>
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
  const [hover, setHover] = useState(false)
  const avatars = useAvatarStore((s) => s.avatars)
  const setAvatar = useAvatarStore((s) => s.setAvatar)
  const removeAvatar = useAvatarStore((s) => s.removeAvatar)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.auth.active().then(setAccount).catch(() => setAccount(null))
    const id = window.setInterval(() => {
      api.auth.active().then(setAccount).catch(() => setAccount(null))
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !account) return
    try {
      const dataUrl = await compressImage(file, 200)
      setAvatar(account.uuid, dataUrl)
    } catch { /* ignore */ }
    e.target.value = ''
  }

  async function signOut() {
    if (!account) return
    try {
      await api.auth.logout(account.uuid)
      removeAvatar(account.uuid)
      setAccount(null)
    } catch { /* ignore */ }
  }

  const avatar = account ? avatars[account.uuid] : undefined
  const initial = account?.username[0]?.toUpperCase() ?? '?'


  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 6px 14px', borderBottom:'1px solid var(--sb-line)', marginBottom:10 }}>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleImagePick} />

      {/* Avatar */}
      <div
        onClick={() => account && fileInputRef.current?.click()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width:38, height:38, flexShrink:0,
          border:`1px solid ${hover && account ? 'var(--accent)' : '#000'}`,
          position:'relative', overflow:'hidden',
          background:'#1a1f2e', cursor: account ? 'pointer' : 'default',
          transition:'border-color .14s',
        }}
      >
        {avatar ? (
          <img src={avatar} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        ) : (
          <div style={{
            width:'100%', height:'100%',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontFamily:"'VT323',monospace", fontSize:20, color:'var(--ink-3)',
          }}>
            {initial}
          </div>
        )}
        {hover && account && (
          <div style={{
            position:'absolute', inset:0, background:'rgba(0,0,0,.55)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontFamily:"'VT323',monospace", fontSize:11, letterSpacing:'.06em', color:'#fff',
          }}>
            ✎
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

      {/* Sign out icon */}
      {account && (
        <button
          onClick={signOut}
          title="Sign out"
          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--ink-4)', padding:4, display:'flex', opacity:.7 }}
        >
          <SignOutIcon />
        </button>
      )}
    </div>
  )
}

function FriendsPanel() {
  const t = useT()
  const [friends, setFriends] = useState<Friend[]>([])
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.friends.list().then(list => setFriends(list as Friend[])).catch(() => {})
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
          <FriendRow key={friend.uuid} friend={friend} onRemove={() => removeFriend(friend.uuid)} />
        ))
      )}
    </div>
  )
}

function FriendRow({ friend, onRemove }: { friend: Friend; onRemove: () => void }) {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const addedDaysAgo = Math.floor((Date.now() - friend.addedAt) / (1000 * 60 * 60 * 24))
  const timeLabel = addedDaysAgo === 0 ? t.sidebar.addedToday : addedDaysAgo === 1 ? t.sidebar.addedYesterday : t.sidebar.addedDaysAgo(addedDaysAgo)

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 6px', borderRadius: 4,
        background: hovered ? 'var(--surface-2)' : 'transparent',
        transition: 'background .1s',
        position: 'relative',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar */}
      <div style={{
        width: 24, height: 24, flexShrink: 0,
        position: 'relative', overflow: 'hidden',
        border: '1px solid var(--line)',
        background: 'var(--surface-3)',
        imageRendering: 'pixelated',
      }}>
        {!imgFailed ? (
          <img
            src={crafatarUrl(friend.uuid.replace(/-/g, ''))}
            alt={friend.username}
            style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--ink-3)',
          }}>
            {friend.username[0]?.toUpperCase()}
          </div>
        )}
        {/* Offline indicator */}
        <div style={{
          position: 'absolute', right: -2, bottom: -2,
          width: 7, height: 7,
          background: 'var(--ink-4)',
          border: '1px solid var(--sb)',
        }} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 500, color: 'var(--ink)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {friend.username}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {timeLabel}
        </div>
      </div>

      {/* Remove */}
      {hovered && (
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          title="Remove friend"
          style={{
            position: 'absolute', right: 4,
            background: 'none', border: 'none',
            color: 'var(--ink-4)', cursor: 'pointer',
            fontSize: 12, lineHeight: 1, padding: '2px 4px',
          }}
          onMouseEnter={e => { (e.currentTarget).style.color = 'var(--lava)' }}
          onMouseLeave={e => { (e.currentTarget).style.color = 'var(--ink-4)' }}
        >
          ✕
        </button>
      )}
    </div>
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
    { to: '/',          label: t.nav.library, Icon: LibraryIcon,  exact: true  },
    { to: '/browse/',   label: t.nav.browse,  Icon: ModsIcon,     exact: false },
    { to: '/modpacks/', label: t.nav.content, Icon: ModpacksIcon, exact: false },
    { to: '/account/',  label: t.nav.account, Icon: AccountIcon,  exact: false },
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

      <AvatarBlock />

      {/* Nav */}
      <div style={{ fontSize:10, fontWeight:600, letterSpacing:'.16em', textTransform:'uppercase', color:'var(--ink-4)', padding:'10px 8px 6px' }}>{t.nav.header}</div>
      <nav style={{ display:'flex', flexDirection:'column', gap:2 }}>
        {navItems.map(n => <NavItem key={n.to} {...n} />)}
      </nav>

      {/* Friends */}
      <FriendsPanel />

      {/* Bottom */}
      <div style={{ marginTop:'auto', display:'flex', flexDirection:'column', gap:2, paddingTop:10, borderTop:'1px solid var(--sb-line)' }}>
        <Link to="/settings" style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:4, color:'var(--ink-2)', fontSize:13, fontWeight:500, textDecoration:'none', border:'1px solid transparent' }}>
          <div style={{ width:18, height:18, display:'flex', alignItems:'center', justifyContent:'center' }}><CogIcon /></div>
          <span>{t.nav.settings}</span>
        </Link>
        <button
          onClick={() => window.open('https://discord.gg/7Q5sGzhUQJ')}
          style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:4, color:'var(--ink-2)', fontSize:13, fontWeight:500, background:'none', border:'1px solid transparent', cursor:'pointer', textAlign:'left' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#5865F2'; e.currentTarget.style.background = 'rgba(88,101,242,.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-2)'; e.currentTarget.style.background = 'none' }}
        >
          <div style={{ width:18, height:18, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>💬</div>
          <span>{t.nav.discord}</span>
        </button>
      </div>
    </aside>
  )
}
