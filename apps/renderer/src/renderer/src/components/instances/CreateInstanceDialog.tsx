import { useState, useId } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type React from 'react'
import type { ModLoader } from '@refract/core'
import { McVersionSelect } from './McVersionSelect'
import { useT } from '@/i18n'

const LOADERS: Array<{ value: ModLoader | ''; label: string }> = [
  { value: '',         label: 'Vanilla'  },
  { value: 'fabric',   label: 'Fabric'   },
  { value: 'forge',    label: 'Forge'    },
  { value: 'quilt',    label: 'Quilt'    },
  { value: 'neoforge', label: 'NeoForge' },
]

const MEM_PRESETS = [1, 2, 4, 8, 16]

interface CreateInput {
  name: string
  minecraftVersion: string
  modLoader?: ModLoader
  memoryMb: number
  iconPath?: string
  groupId?: string
  customPath?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreateInput) => Promise<void>
  onImportFile?: (filePath: string) => void
  onImportMultiMc?: () => void
}

export function CreateInstanceDialog({ open, onOpenChange, onCreate, onImportFile, onImportMultiMc }: Props) {
  const t = useT()
  const nameId = useId()
  const verId  = useId()
  const grpId  = useId()

  const [name, setName]               = useState('My Instance')
  const [mcVersion, setMcVersion]     = useState('1.21.1')
  const [showSnapshots, setSnap]      = useState(false)
  const [modLoader, setModLoader]     = useState<ModLoader | ''>('')
  const [memGB, setMemGB]             = useState(2)
  const [groupId, setGroupId]         = useState('')
  const [loading, setLoading]         = useState(false)

  function reset() {
    setName('My Instance'); setMcVersion('1.21.1'); setSnap(false)
    setModLoader(''); setMemGB(2); setGroupId('')
  }

  function close() { if (!loading) { reset(); onOpenChange(false) } }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || loading) return
    setLoading(true)
    try {
      await onCreate({ name: name.trim(), minecraftVersion: mcVersion, modLoader: modLoader || undefined, memoryMb: memGB * 1024, groupId: groupId.trim() || undefined })
      onOpenChange(false); reset()
    } finally { setLoading(false) }
  }

  const fillPct = ((memGB - 1) / (16 - 1)) * 100
  const displayName = name.trim() || 'My Instance'
  const loaderLabel = LOADERS.find(l => l.value === modLoader)?.label ?? 'Vanilla'

  const IrisLogo = () => (
    <svg viewBox="-110 -110 220 220" xmlns="http://www.w3.org/2000/svg" style={{ width: 34, height: 34, flexShrink: 0, filter: 'drop-shadow(0 2px 6px var(--ni-p-glow, var(--accent-tint)))' }}>
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

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!loading) { if (!v) reset(); onOpenChange(v) } }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 149 }} />
        <Dialog.Content
          aria-label="New instance"
          className="ni-dialog"
          onEscapeKeyDown={close}
          onPointerDownOutside={close}
        >
          {/* ── Header ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 22px', borderBottom: '1px solid var(--border-r)', background: 'linear-gradient(var(--surface-2), var(--surface))', flexShrink: 0 }}>
            <IrisLogo />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1, color: 'var(--ink)' }}>New Instance</h2>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, letterSpacing: '.08em', color: 'var(--ink-3)', textTransform: 'uppercase' }}>
                Set it up · launch in seconds
              </span>
            </div>
            <button className="ni-close" onClick={close} aria-label="Close" type="button">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18"/>
              </svg>
            </button>
          </div>

          {/* ── Body ── */}
          <div className="ni-body" style={{ flex: 1, minHeight: 0 }}>

            {/* Left: live preview */}
            <aside className="ni-preview" style={{ padding: '22px 20px', background: 'var(--surface-2)', borderRight: '1px solid var(--border-r)', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
                Live Preview
              </div>

              {/* Preview card */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 10px 30px -18px rgba(0,0,0,.5)' }}>
                {/* Thumbnail: pixel skyline */}
                <div style={{ height: 128, position: 'relative', overflow: 'hidden', background: 'linear-gradient(var(--sky-1, #3a2a66), var(--sky-2, #5a3fa6))' }}>
                  {/* Stars */}
                  <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(1.5px 1.5px at 22% 30%, #fff8, transparent), radial-gradient(1.5px 1.5px at 64% 20%, #ffffffaa, transparent), radial-gradient(1.5px 1.5px at 80% 44%, #fff7, transparent), radial-gradient(1.5px 1.5px at 40% 16%, #fff6, transparent)' }} />
                  {/* Sun / accent glow */}
                  <div style={{ position: 'absolute', top: 16, right: 18, width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-hi, #8a52ff)', boxShadow: '0 0 22px 4px var(--accent-tint)' }} />
                  {/* Skyline silhouette */}
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 44, height: 40, opacity: .55, background: 'linear-gradient(#2c1f4d,#2c1f4d) 6% 100%/14px 26px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 22% 100%/20px 38px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 44% 100%/16px 22px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 62% 100%/24px 32px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 84% 100%/16px 30px no-repeat' }} />
                  {/* Ground */}
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 46, background: 'linear-gradient(#3aa05a,#3aa05a) 0 0/100% 9px no-repeat, linear-gradient(#7a5230,#5f3f24)', boxShadow: 'inset 0 1px 0 #4fbf6e' }} />
                </div>
                {/* Card body */}
                <div style={{ padding: '13px 14px 15px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: 'var(--ink-3)', letterSpacing: '.02em' }}>Minecraft {mcVersion}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ni-p-deep, var(--accent-hi))', background: 'var(--ni-p-tint, var(--accent-tint))', border: '1px solid var(--ni-p-tint-2, var(--accent-tint))', borderRadius: 6, padding: '3px 8px' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                      {loaderLabel}
                    </span>
                    <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 6, padding: '3px 8px', background: 'var(--bg)' }}>
                      {memGB} GB
                    </span>
                  </div>
                </div>
              </div>

              <p style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5, margin: 0 }}>
                This is how <strong style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{displayName}</strong> will appear in your library. Java is installed automatically.
              </p>
            </aside>

            {/* Right: form */}
            <form id="ni-form" onSubmit={handleCreate} style={{ padding: '22px 24px 4px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* Name */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <label htmlFor={nameId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Instance name</label>
                </div>
                <input id={nameId} className="ni-input" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="My Instance" autoFocus autoComplete="off" spellCheck={false} />
              </div>

              {/* Version */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <label htmlFor={verId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Minecraft version</label>
                  <label className="ni-check">
                    <input className="ni-check-input" type="checkbox" checked={showSnapshots} onChange={e => setSnap(e.target.checked)} />
                    <span className="ni-checkmark-box">
                      <svg className="ni-checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>
                    </span>
                    <span className="ni-check-label">Snapshots</span>
                  </label>
                </div>
                <div style={{ position: 'relative' }}>
                  <McVersionSelect
                    value={mcVersion}
                    onChange={setMcVersion}
                    selectClassName="ni-input"
                    showSnapshots={showSnapshots}
                    onShowSnapshotsChange={setSnap}
                    hideBuiltinCheckbox
                  />
                  <span style={{ position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--ink-3)' }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                </div>
              </div>

              {/* Mod loader */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Mod loader</label>
                <div className="ni-seg">
                  {LOADERS.map(l => (
                    <button
                      key={l.value}
                      type="button"
                      className="ni-seg-btn"
                      aria-pressed={modLoader === l.value ? 'true' : 'false'}
                      onClick={() => setModLoader(l.value)}
                    >
                      <span className="ni-glyph" />
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Memory */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Memory</label>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--ni-p-deep, var(--accent-hi))', fontWeight: 600 }}>{memGB} GB allocated</span>
                </div>
                <input
                  className="ni-slider"
                  type="range" min={1} max={16} step={1}
                  value={memGB}
                  style={{ '--fill': `${fillPct}%` } as React.CSSProperties}
                  onChange={e => setMemGB(Number(e.target.value))}
                />
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 3 }}>
                  {MEM_PRESETS.map(g => (
                    <button key={g} type="button" className="ni-preset" aria-pressed={memGB === g ? 'true' : 'false'} onClick={() => setMemGB(g)}>
                      {g}G
                    </button>
                  ))}
                </div>
              </div>

              {/* Group */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={grpId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  Group{' '}<span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--ink-4)', fontFamily: 'inherit' }}>(optional)</span>
                </label>
                <input id={grpId} className="ni-input" type="text" value={groupId} onChange={e => setGroupId(e.target.value)} placeholder="e.g. Modded, Vanilla, Survival…" autoComplete="off" />
              </div>

            </form>
          </div>

          {/* ── Footer ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 22px', borderTop: '1px solid var(--border-r)', background: 'var(--surface-2)', flexShrink: 0 }}>
            <button type="button" className="ni-btn ni-btn-ghost" onClick={close} disabled={loading}>{t.createInst.cancel}</button>
            <div style={{ flex: 1 }} />
            {onImportFile && (
              <button type="button" className="ni-btn ni-btn-soft" disabled={loading} onClick={async () => {
                const p = await window.api.modpack.openFileDialog()
                if (p) { onOpenChange(false); reset(); onImportFile(p) }
              }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 1z"/></svg>
                {t.createInst.importZip}
              </button>
            )}
            {onImportMultiMc && (
              <button type="button" className="ni-btn ni-btn-soft" disabled={loading} onClick={() => { onOpenChange(false); reset(); onImportMultiMc() }}>
                MultiMC / Prism
              </button>
            )}
            <button type="submit" form="ni-form" className="ni-btn ni-btn-primary" disabled={!name.trim() || loading}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              {loading ? t.createInst.creating : t.createInst.create}
            </button>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
