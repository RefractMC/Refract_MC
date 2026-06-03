import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { api, type SafeAccount } from '@/lib/api'
import { SkinViewer3DLazy as SkinViewer3D } from '@/components/ui/SkinViewer3DLazy'
import { useT } from '@/i18n'

export const Route = createFileRoute('/skins/')({ component: SkinsPage })

export interface SavedSkinClient {
  id: string
  name: string
  filename: string
  variant: 'classic' | 'slim'
  addedAt: string
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function SkinsPage() {
  return <SkinsPage_ />
}

function SkinsPage_() {
  const t = useT()
  const [skins, setSkins]           = useState<SavedSkinClient[]>([])
  const [selected, setSelected]     = useState<SavedSkinClient | null>(null)
  const [skinUrl, setSkinUrl]       = useState<string | null>(null)
  const [accounts, setAccounts]     = useState<SafeAccount[]>([])
  const [activeAccount, setActiveAccount] = useState<SafeAccount | null>(null)
  const [applying, setApplying]     = useState(false)
  const [msg, setMsg]               = useState<{ ok: boolean; text: string } | null>(null)
  const [adding, setAdding]         = useState(false)
  const [newName, setNewName]       = useState('')
  const [newVariant, setNewVariant] = useState<'classic' | 'slim'>('classic')
  const [newPath, setNewPath]       = useState<string | null>(null)
  const [newUrl, setNewUrl]         = useState<string | null>(null)
  const [renaming, setRenaming]     = useState<string | null>(null)
  const [renameVal, setRenameVal]   = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    const list = await api.skins.list().catch(() => [])
    setSkins(list)
    if (list.length > 0 && !selected) {
      pick(list[0])
    }
  }

  async function pick(skin: SavedSkinClient) {
    setSelected(skin)
    setSkinUrl(null)
    const dataUrl = await api.skins.getDataUrl(skin.filename).catch(() => null)
    if (dataUrl) setSkinUrl(dataUrl)
  }

  useEffect(() => {
    refresh()
    api.auth.accounts().then(setAccounts).catch(() => {})
    api.auth.active().then(setActiveAccount).catch(() => {})
  }, [])

  async function handleBrowse() {
    const p = await api.skins.browse()
    if (!p) return
    setNewPath(p)
    if (!newName) setNewName(p.split(/[/\\]/).pop()?.replace(/\.png$/i, '') ?? 'My Skin')
    const dataUrl = await api.skins.fileToDataUrl(p).catch(() => null)
    setNewUrl(dataUrl ?? null)
  }

  async function handleAdd() {
    if (!newPath || !newName.trim()) return
    setAdding(true)
    try {
      await api.skins.add(newName.trim(), newPath, newVariant)
      setNewPath(null); setNewUrl(null); setNewName(''); setAdding(false)
      await refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    await api.skins.delete(id).catch(() => {})
    const next = skins.filter(s => s.id !== id)
    setSkins(next)
    if (selected?.id === id) { if (next[0]) pick(next[0]); else { setSelected(null); setSkinUrl(null) } }
  }

  const msAccount = accounts.find(a => a.type === 'microsoft') ?? (activeAccount?.type === 'microsoft' ? activeAccount : null)

  async function handleApply() {
    if (!selected || !msAccount) return
    setApplying(true); setMsg(null)
    try {
      await api.skins.apply(selected.id, msAccount.uuid)
      setMsg({ ok: true, text: t.skins.skinApplied(msAccount.username) })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally { setApplying(false) }
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg)', gap: 0 }}>

      {/* ── Left panel: skin list ─────────────────────────────────────── */}
      <div style={{
        width: 220, flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border-r)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 14px 10px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontFamily: "'VT323',monospace", fontSize: 16, letterSpacing: '.1em', color: 'var(--ink)' }}>{t.skins.mySkins}</div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {skins.map(skin => (
            <SkinListItem
              key={skin.id}
              skin={skin}
              selected={selected?.id === skin.id}
              onSelect={() => pick(skin)}
              onDelete={() => handleDelete(skin.id)}
              renaming={renaming === skin.id}
              renameVal={renameVal}
              onStartRename={() => { setRenaming(skin.id); setRenameVal(skin.name); setTimeout(() => nameInputRef.current?.focus(), 0) }}
              onRenameChange={setRenameVal}
              onRenameCommit={async () => {
                if (!renameVal.trim()) { setRenaming(null); return }
                setSkins(prev => prev.map(s => s.id === skin.id ? { ...s, name: renameVal.trim() } : s))
                if (selected?.id === skin.id) setSelected(s => s ? { ...s, name: renameVal.trim() } : s)
                setRenaming(null)
              }}
              nameInputRef={renaming === skin.id ? nameInputRef : undefined}
            />
          ))}

          {skins.length === 0 && (
            <div style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--ink-4)', fontSize: 12, lineHeight: 1.5 }}>
              {t.skins.noSkinsYet}
            </div>
          )}
        </div>

        {/* Add skin button */}
        <div style={{ padding: 10, borderTop: '1px solid var(--line)' }}>
          <button
            onClick={handleBrowse}
            style={{
              width: '100%', height: 36,
              background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              fontWeight: 700, fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            {t.skins.addSkin}
          </button>
        </div>
      </div>

      {/* ── Main: 3D viewer + info ────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {newPath ? (
          /* ── New skin upload panel ── */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 32 }}>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 20, letterSpacing: '.1em', color: 'var(--ink)' }}>{t.skins.newSkin}</div>
            <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start' }}>
              {/* 3D preview */}
              <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 16, border: '1px solid var(--border-r)' }}>
                <SkinViewer3D skinUrl={newUrl} width={180} height={280} walk rotate />
              </div>
              {/* Form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 240 }}>
                <div>
                  <label style={{ display: 'block', fontFamily: "'VT323',monospace", fontSize: 12, letterSpacing: '.12em', color: 'var(--ink-4)', marginBottom: 6 }}>{t.skins.skinName}</label>
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    style={{ width: '100%', height: 36, background: 'var(--bg)', border: '1px solid var(--border-r)', borderRadius: 6, color: 'var(--ink)', padding: '0 12px', outline: 'none', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontFamily: "'VT323',monospace", fontSize: 12, letterSpacing: '.12em', color: 'var(--ink-4)', marginBottom: 6 }}>{t.skins.model}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['classic', 'slim'] as const).map(v => (
                      <button key={v} onClick={() => setNewVariant(v)} style={{
                        flex: 1, height: 34, fontSize: 13, fontWeight: 600,
                        background: newVariant === v ? 'var(--accent-tint)' : 'var(--surface-2)',
                        color: newVariant === v ? 'var(--accent)' : 'var(--ink-3)',
                        border: `1px solid ${newVariant === v ? 'var(--accent)' : 'var(--border-r)'}`,
                        borderRadius: 6, cursor: 'pointer',
                      }}>
                        {v === 'classic' ? t.skins.classic : t.skins.slim}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={handleAdd} disabled={!newName.trim() || adding} style={{ flex: 1, height: 38, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, opacity: adding ? .6 : 1 }}>
                    {adding ? t.skins.saving : t.skins.saveSkin}
                  </button>
                  <button onClick={() => { setNewPath(null); setNewUrl(null); setNewName('') }} style={{ height: 38, padding: '0 16px', background: 'var(--surface-2)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                    {t.skins.cancel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : selected ? (
          /* ── Selected skin viewer ── */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '24px 32px' }}>
            {/* 3D viewer */}
            <div style={{ background: 'linear-gradient(180deg, var(--surface-2) 0%, var(--bg) 100%)', borderRadius: 16, padding: 20, border: '1px solid var(--border-r)', marginBottom: 24 }}>
              <SkinViewer3D skinUrl={skinUrl} width={200} height={320} walk rotate />
            </div>

            {/* Skin info */}
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>{selected.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                {selected.variant === 'classic' ? t.skins.classicSteve : t.skins.slimAlex} · {t.skins.addedOn(fmtDate(selected.addedAt))}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 400 }}>
              {msAccount && (
                <button
                  onClick={handleApply}
                  disabled={applying || msAccount.type !== 'microsoft'}
                  style={{
                    height: 42, padding: '0 24px',
                    background: msAccount.type === 'microsoft' ? 'var(--accent)' : 'var(--surface-3)',
                    color: msAccount.type === 'microsoft' ? '#fff' : 'var(--ink-4)',
                    border: 'none', borderRadius: 8, cursor: msAccount.type === 'microsoft' ? 'pointer' : 'not-allowed',
                    fontWeight: 700, fontSize: 14,
                    boxShadow: msAccount.type === 'microsoft' ? '0 4px 14px var(--accent-tint)' : 'none',
                    opacity: applying ? .6 : 1,
                  }}
                >
                  {applying ? t.skins.applying : msAccount.type === 'microsoft' ? t.skins.useSkinAs(msAccount.username) : t.skins.microsoftRequired}
                </button>
              )}
              <button
                onClick={() => handleDelete(selected.id)}
                style={{ height: 42, padding: '0 18px', background: 'transparent', color: 'var(--lava)', border: '1px solid rgba(217,59,59,.4)', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                {t.skins.delete}
              </button>
            </div>

            {msg && (
              <div style={{ marginTop: 14, fontSize: 12, color: msg.ok ? 'var(--grass)' : 'var(--lava)', textAlign: 'center', maxWidth: 360 }}>
                {msg.text}
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontSize: 14 }}>
            Add a skin to get started
          </div>
        )}
      </div>
    </div>
  )
}

function SkinListItem({ skin, selected, onSelect, onDelete, renaming, renameVal, onStartRename, onRenameChange, onRenameCommit, nameInputRef }: {
  skin: SavedSkinClient
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  renaming: boolean
  renameVal: string
  onStartRename: () => void
  onRenameChange: (v: string) => void
  onRenameCommit: () => void
  nameInputRef?: React.RefObject<HTMLInputElement>
}) {
  const t = useT()
  const [hover, setHover] = useState(false)
  const [faceUrl, setFaceUrl] = useState<string | null>(null)

  useEffect(() => {
    api.skins.getDataUrl(skin.filename).then(url => setFaceUrl(url)).catch(() => {})
  }, [skin.filename])

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 8, marginBottom: 2,
        background: selected ? 'var(--accent-tint)' : hover ? 'var(--surface-2)' : 'transparent',
        border: `1px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        cursor: 'pointer', transition: 'background 100ms',
      }}
    >
      {/* Small face thumbnail */}
      {faceUrl ? (
        <div style={{
          width: 32, height: 32, flexShrink: 0,
          backgroundImage: `url(${faceUrl})`,
          backgroundSize: '256px 256px',
          backgroundPosition: '-32px -32px',
          imageRendering: 'pixelated',
          borderRadius: 3,
        }} />
      ) : (
        <div style={{
          width: 32, height: 32, flexShrink: 0, borderRadius: 4, overflow: 'hidden',
          background: 'var(--surface-3)', border: '1px solid var(--border-r)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: selected ? 'var(--accent)' : 'var(--ink-4)', fontSize: 16,
        }}>
          {/* shirt/skin icon placeholder */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="8" y="2" width="8" height="6" rx="1"/>
            <path d="M4 8h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/>
            <path d="M4 8L2 5l4-1M20 8l2-3-4-1"/>
          </svg>
        </div>
      )}

      {/* Name */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming ? (
          <input
            ref={nameInputRef}
            value={renameVal}
            onChange={e => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') onRenameChange('') }}
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--ink)', padding: '2px 6px', outline: 'none', fontSize: 13 }}
          />
        ) : (
          <div
            style={{ fontSize: 13, fontWeight: 500, color: selected ? 'var(--ink)' : 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            onDoubleClick={e => { e.stopPropagation(); onStartRename() }}
          >
            {skin.name}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 1 }}>
          {skin.variant === 'classic' ? t.skins.classic : t.skins.slim}
        </div>
      </div>

      {/* Delete on hover */}
      {hover && !renaming && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{ width: 22, height: 22, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-4)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--lava)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
      )}
    </div>
  )
}

