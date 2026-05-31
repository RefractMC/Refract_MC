import { useState, useEffect, useRef, useId } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type React from 'react'
import type { Instance, ModLoader, JavaInstallation } from '@refract/core'
import { compressImage } from '@/lib/image'
import { McVersionSelect } from './McVersionSelect'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

const MOD_LOADERS: Array<{ value: ModLoader | ''; label: string }> = [
  { value: '',         label: 'Vanilla'  },
  { value: 'fabric',   label: 'Fabric'   },
  { value: 'forge',    label: 'Forge'    },
  { value: 'quilt',    label: 'Quilt'    },
  { value: 'neoforge', label: 'NeoForge' },
]

const ALL_PRESETS = [1, 2, 4, 8, 16, 32, 64]

interface Props {
  instance: Instance | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (id: string, patch: Partial<Instance>) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onRepair?: (id: string) => void
  onDuplicate?: (id: string) => Promise<void>
}

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

export function EditInstanceDialog({ instance, open, onOpenChange, onSave, onDelete, onRepair, onDuplicate }: Props) {
  const t = useT()
  const nameId   = useId()
  const verId    = useId()
  const grpId    = useId()
  const javaId   = useId()
  const argsId   = useId()
  const pinId    = useId()

  const [name, setName]               = useState('')
  const [mcVersion, setMcVersion]     = useState('1.21.1')
  const [showSnapshots, setSnap]      = useState(false)
  const [modLoader, setModLoader]     = useState<ModLoader | ''>('')
  const [memGB, setMemGB]             = useState(2)
  const [coverImage, setCoverImage]   = useState('')
  const [pinned, setPinned]           = useState(false)
  const [groupId, setGroupId]         = useState('')
  const [javaPath, setJavaPath]       = useState('')
  const [javaArgs, setJavaArgs]       = useState('')
  const [javas, setJavas]             = useState<JavaInstallation[]>([])
  const [loading, setLoading]         = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [maxRamGb, setMaxRamGb]       = useState(16)
  const [previewHover, setPreviewHover] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.config.get()
      .then(cfg => { if (cfg.systemRamGb && cfg.systemRamGb > 1) setMaxRamGb(cfg.systemRamGb) })
      .catch(() => {})
  }, [])

  const memPresets = ALL_PRESETS.filter(g => g <= maxRamGb)
  const fillPct = ((memGB - 1) / Math.max(maxRamGb - 1, 1)) * 100

  useEffect(() => {
    if (instance && open) {
      setName(instance.name)
      setMcVersion(instance.minecraftVersion)
      setSnap(false)
      setModLoader(instance.modLoader ?? '')
      setMemGB(Math.max(1, Math.round(instance.memoryMb / 1024)))
      setCoverImage(instance.iconPath ?? '')
      setPinned(instance.pinned ?? false)
      setGroupId(instance.groupId ?? '')
      setJavaPath(instance.javaPath ?? '')
      setJavaArgs(instance.javaArgs ?? '')
      setConfirmDelete(false)
      api.mc.java().then(setJavas).catch(() => setJavas([]))
    }
  }, [instance, open])

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try { setCoverImage(await compressImage(file)) } catch { /* ignore */ }
    e.target.value = ''
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!instance || !name.trim()) return
    setLoading(true)
    try {
      await onSave(instance.id, {
        name: name.trim(),
        minecraftVersion: mcVersion,
        modLoader: modLoader || undefined,
        memoryMb: memGB * 1024,
        iconPath: coverImage || undefined,
        pinned,
        groupId: groupId.trim() || undefined,
        javaPath: javaPath || undefined,
        javaArgs: javaArgs.trim() || undefined,
      })
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (!instance || !onDelete) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setLoading(true)
    try {
      await onDelete(instance.id)
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  const loaderLabel = MOD_LOADERS.find(l => l.value === modLoader)?.label ?? 'Vanilla'
  const displayName = name.trim() || 'Instance'

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 149 }} />
        <Dialog.Content
          aria-label="Edit instance"
          className="ni-dialog"
          onEscapeKeyDown={() => { if (!loading) onOpenChange(false) }}
          onPointerDownOutside={() => { if (!loading) onOpenChange(false) }}
        >
          {/* ── Header ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 22px', borderBottom: '1px solid var(--border-r)', background: 'linear-gradient(var(--surface-2), var(--surface))', flexShrink: 0 }}>
            <IrisLogo />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1, color: 'var(--ink)' }}>{t.editInst.title}</h2>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, letterSpacing: '.08em', color: 'var(--ink-3)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </span>
            </div>
            <button className="ni-close" onClick={() => { if (!loading) onOpenChange(false) }} aria-label="Close" type="button">
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

              {/* Preview card — clickable to pick image */}
              <div
                style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 10px 30px -18px rgba(0,0,0,.5)', cursor: 'pointer' }}
                onClick={() => fileInputRef.current?.click()}
                onMouseEnter={() => setPreviewHover(true)}
                onMouseLeave={() => setPreviewHover(false)}
              >
                {/* Thumbnail */}
                <div style={{ height: 128, position: 'relative', overflow: 'hidden', background: 'linear-gradient(var(--sky-1, #3a2a66), var(--sky-2, #5a3fa6))' }}>
                  {coverImage
                    ? <img src={coverImage} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                    : instance?.iconPath
                    ? <img src={instance.iconPath} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                    : (
                      <>
                        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(1.5px 1.5px at 22% 30%, #fff8, transparent), radial-gradient(1.5px 1.5px at 64% 20%, #ffffffaa, transparent), radial-gradient(1.5px 1.5px at 80% 44%, #fff7, transparent), radial-gradient(1.5px 1.5px at 40% 16%, #fff6, transparent)' }} />
                        <div style={{ position: 'absolute', top: 16, right: 18, width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-hi, #8a52ff)', boxShadow: '0 0 22px 4px var(--accent-tint)' }} />
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 44, height: 40, opacity: .55, background: 'linear-gradient(#2c1f4d,#2c1f4d) 6% 100%/14px 26px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 22% 100%/20px 38px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 44% 100%/16px 22px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 62% 100%/24px 32px no-repeat, linear-gradient(#2c1f4d,#2c1f4d) 84% 100%/16px 30px no-repeat' }} />
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 46, background: 'linear-gradient(#3aa05a,#3aa05a) 0 0/100% 9px no-repeat, linear-gradient(#7a5230,#5f3f24)', boxShadow: 'inset 0 1px 0 #4fbf6e' }} />
                      </>
                    )
                  }
                  {/* Hover overlay */}
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                    background: 'rgba(0,0,0,.52)',
                    opacity: previewHover ? 1 : 0,
                    transition: 'opacity .14s',
                  }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '.1em', color: '#fff', textTransform: 'uppercase' }}>
                      {coverImage || instance?.iconPath ? 'Change' : 'Set Image'}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,.6)' }}>click to browse</div>
                  </div>
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

              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImagePick} />
            </aside>

            {/* Right: form */}
            <form id="ei-form" onSubmit={handleSubmit} style={{ padding: '22px 24px 4px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* Name */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={nameId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {t.editInst.name}
                </label>
                <input
                  id={nameId}
                  className="ni-input"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {/* Minecraft version */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <label htmlFor={verId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                    {t.editInst.mcVersion}
                  </label>
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
                <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {t.editInst.modLoader}
                </label>
                <div className="ni-seg">
                  {MOD_LOADERS.map(l => (
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
                  <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                    {t.editInst.memory(String(memGB))}
                  </label>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--ni-p-deep, var(--accent-hi))', fontWeight: 600 }}>{memGB} GB allocated</span>
                </div>
                <input
                  className="ni-slider"
                  type="range" min={1} max={maxRamGb} step={1}
                  value={memGB}
                  style={{ '--fill': `${fillPct}%` } as React.CSSProperties}
                  onChange={e => setMemGB(Number(e.target.value))}
                />
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 3 }}>
                  {memPresets.map(g => (
                    <button key={g} type="button" className="ni-preset" aria-pressed={memGB === g ? 'true' : 'false'} onClick={() => setMemGB(g)}>
                      {g}G
                    </button>
                  ))}
                </div>
              </div>

              {/* Group */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={grpId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {t.editInst.group}
                </label>
                <input
                  id={grpId}
                  className="ni-input"
                  type="text"
                  value={groupId}
                  onChange={e => setGroupId(e.target.value)}
                  placeholder={t.editInst.groupPlaceholder}
                  autoComplete="off"
                />
              </div>

              {/* Java override */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={javaId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {t.editInst.javaOverride}
                </label>
                <div style={{ position: 'relative' }}>
                  <select
                    id={javaId}
                    className="ni-input"
                    value={javaPath}
                    onChange={e => setJavaPath(e.target.value)}
                  >
                    <option value="">{t.editInst.javaAuto}</option>
                    {javas.map(j => (
                      <option key={j.path} value={j.path}>
                        {t.editInst.javaVersion(j.version, j.vendor)}
                      </option>
                    ))}
                  </select>
                  <span style={{ position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--ink-3)' }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                </div>
              </div>

              {/* JVM args */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={argsId} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {t.editInst.jvmArgs}
                </label>
                <input
                  id={argsId}
                  className="ni-input"
                  type="text"
                  value={javaArgs}
                  onChange={e => setJavaArgs(e.target.value)}
                  placeholder={t.editInst.jvmArgsPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: 'var(--ink-4)', alignSelf: 'center', flexShrink: 0, letterSpacing: '.06em', fontFamily: "'JetBrains Mono', monospace" }}>PRESETS:</span>
                  {[
                    { label: "Aikar's", args: '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -XX:+DisableExplicitGC -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1' },
                    { label: 'Low-end', args: '-XX:+UseSerialGC -XX:TieredStopAtLevel=1' },
                  ].map(p => (
                    <button key={p.label} type="button" onClick={() => setJavaArgs(p.args)} style={{ fontSize: 10, padding: '2px 8px', background: 'var(--surface-3)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                      {p.label}
                    </button>
                  ))}
                  {javaArgs && (
                    <button type="button" onClick={() => setJavaArgs('')} style={{ fontSize: 10, padding: '2px 8px', background: 'none', color: 'var(--ink-4)', border: '1px solid var(--border-r)', borderRadius: 6, cursor: 'pointer' }}>
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Pin toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={pinId} className="ni-check" style={{ alignSelf: 'flex-start' }}>
                  <input id={pinId} className="ni-check-input" type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
                  <span className="ni-checkmark-box">
                    <svg className="ni-checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-11"/></svg>
                  </span>
                  <span className="ni-check-label">{t.editInst.pin}</span>
                </label>
              </div>

            </form>
          </div>

          {/* ── Footer ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 22px', borderTop: '1px solid var(--border-r)', background: 'var(--surface-2)', flexShrink: 0 }}>
            {/* Danger actions */}
            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={loading}
                style={{
                  height: 42, padding: '0 14px', borderRadius: 10,
                  background: confirmDelete ? 'rgba(217,59,59,.25)' : 'rgba(217,59,59,.15)',
                  color: 'var(--lava, #d93b3b)',
                  border: confirmDelete ? '1px solid rgba(217,59,59,.7)' : '1px solid rgba(217,59,59,.5)',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontSize: 13, fontWeight: 700, flexShrink: 0,
                  transition: 'background .15s, border-color .15s',
                  fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
                }}
              >
                {confirmDelete ? t.editInst.confirmDelete : t.editInst.delete}
              </button>
            )}
            {onRepair && instance?.isInstalled && (
              <button
                type="button"
                disabled={loading}
                onClick={() => { if (instance) { onOpenChange(false); onRepair(instance.id) } }}
                className="ni-btn ni-btn-soft"
              >
                {t.editInst.repair}
              </button>
            )}
            {onDuplicate && (
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  if (!instance) return
                  setLoading(true)
                  try { await onDuplicate(instance.id); onOpenChange(false) }
                  finally { setLoading(false) }
                }}
                className="ni-btn ni-btn-soft"
              >
                {t.editInst.duplicate}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" className="ni-btn ni-btn-ghost" disabled={loading} onClick={() => { if (!loading) onOpenChange(false) }}>
              {t.editInst.cancel}
            </button>
            <button type="submit" form="ei-form" className="ni-btn ni-btn-primary" disabled={!name.trim() || loading}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              {loading ? t.editInst.saving : t.editInst.save}
            </button>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
