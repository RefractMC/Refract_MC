import { useState, useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type React from 'react'
import type { Instance, ModLoader, JavaInstallation } from '@refract/core'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
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

const MEMORY_QUICK = [1024, 2048, 4096, 8192, 16384]
const MEMORY_MIN_MB = 512
const MEMORY_MAX_MB = 32768
const MEMORY_STEP   = 512

function mbLabel(mb: number) {
  return mb >= 1024 ? `${mb / 1024}G` : `${mb}M`
}

function mbToGb(mb: number) {
  return (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)
}

interface Props {
  instance: Instance | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (id: string, patch: Partial<Instance>) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onRepair?: (id: string) => void
  onDuplicate?: (id: string) => Promise<void>
}

export function EditInstanceDialog({ instance, open, onOpenChange, onSave, onDelete, onRepair, onDuplicate }: Props) {
  const t = useT()
  const [name, setName]           = useState('')
  const [mcVersion, setMcVersion] = useState('1.21.1')
  const [modLoader, setModLoader] = useState<ModLoader | ''>('')
  const [memoryMb, setMemoryMb]   = useState(2048)
  const [coverImage, setCoverImage] = useState('')
  const [pinned, setPinned]       = useState(false)
  const [groupId, setGroupId]     = useState('')
  const [javaPath, setJavaPath]   = useState('')
  const [javaArgs, setJavaArgs]   = useState('')
  const [javas, setJavas]         = useState<JavaInstallation[]>([])
  const [loading, setLoading]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (instance && open) {
      setName(instance.name)
      setMcVersion(instance.minecraftVersion)
      setModLoader(instance.modLoader ?? '')
      setMemoryMb(instance.memoryMb)
      setCoverImage(instance.iconPath ?? '')
      setPinned(instance.pinned ?? false)
      setGroupId(instance.groupId ?? '')
      setJavaPath(instance.javaPath ?? '')
      setJavaArgs(instance.javaArgs ?? '')
      setConfirmDelete(false)
      api.mc.java().then(setJavas).catch(() => setJavas([]))
    }
  }, [instance, open])

  function setMemory(mb: number) {
    setMemoryMb(Math.max(MEMORY_MIN_MB, Math.min(MEMORY_MAX_MB, mb)))
  }

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
      await onSave(instance.id, { name: name.trim(), minecraftVersion: mcVersion, modLoader: modLoader || undefined, memoryMb, iconPath: coverImage || undefined, pinned, groupId: groupId.trim() || undefined, javaPath: javaPath || undefined, javaArgs: javaArgs.trim() || undefined })
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

  const fillPct = ((memoryMb - MEMORY_MIN_MB) / (MEMORY_MAX_MB - MEMORY_MIN_MB)) * 100

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.72)', zIndex:40 }} />
        <Dialog.Content style={{
          position:'fixed', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
          background:'var(--surface)', border:'1px solid var(--border-r)',
          borderRadius:4, width:560, zIndex:50, outline:'none', overflow:'hidden',
        }}>

          {/* Title bar */}
          <div style={{ background:'var(--surface-2)', borderBottom:'1px solid var(--line)', padding:'0 16px', height:38, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontFamily:"'VT323',monospace", fontSize:20, letterSpacing:'.14em', color:'var(--ink)', lineHeight:1 }}>{t.editInst.title}</span>
            <Dialog.Close disabled={loading} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--ink-4)', fontSize:18, lineHeight:1, padding:'4px 6px', opacity:loading ? 0.5 : 1 }}>✕</Dialog.Close>
          </div>

          {/* Body */}
          <div style={{ display:'flex' }}>

            {/* Preview column */}
            <div style={{ width:160, flexShrink:0, borderRight:'1px solid var(--line)', display:'flex', flexDirection:'column' }}>
              <ImagePickerArea image={coverImage} fallback={<PixelScene name={loaderToScene(modLoader || null)} style={{ width:'100%', height:140 }} />} onClick={() => fileInputRef.current?.click()} />
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleImagePick} />
              <div style={{ padding:'10px 12px', display:'flex', flexDirection:'column', gap:5, flex:1 }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--ink)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {name || <span style={{ color:'var(--ink-4)' }}>Instance</span>}
                </div>
                <div style={{ fontFamily:"'VT323',monospace", fontSize:13, color:'var(--ink-4)', letterSpacing:'.06em' }}>MC {mcVersion}</div>
                <div style={{
                  marginTop:2, alignSelf:'flex-start',
                  background: modLoader ? 'var(--accent-tint)' : 'var(--surface-3)',
                  border:`1px solid ${modLoader ? 'var(--accent)' : 'var(--border-r)'}`,
                  borderRadius:3, padding:'1px 7px',
                  fontFamily:"'VT323',monospace", fontSize:12, letterSpacing:'.08em',
                  color: modLoader ? 'var(--accent)' : 'var(--ink-4)',
                }}>
                  {modLoader ? modLoader.toUpperCase() : t.editInst.vanilla}
                </div>
                <div style={{ fontFamily:"'VT323',monospace", fontSize:12, color:'var(--ink-4)', letterSpacing:'.04em' }}>
                  {mbLabel(memoryMb)} RAM
                </div>
              </div>
            </div>

            {/* Form column */}
            <form onSubmit={handleSubmit} style={{ flex:1, padding:'16px 18px', display:'flex', flexDirection:'column', gap:14 }}>

              <Field label={t.editInst.name}>
                <input
                  type="text" value={name} onChange={e => setName(e.target.value)}
                  autoFocus style={inputSt}
                />
              </Field>

              <Field label={t.editInst.mcVersion}>
                <McVersionSelect value={mcVersion} onChange={setMcVersion} selectStyle={selectSt} />
              </Field>

              <Field label={t.editInst.modLoader}>
                <div style={{ display:'flex', gap:4 }}>
                  {MOD_LOADERS.map(l => (
                    <button key={l.value} type="button" onClick={() => setModLoader(l.value)} style={{
                      flex:1, height:28, fontSize:11, fontWeight:500,
                      color: modLoader === l.value ? 'var(--ink)' : 'var(--ink-3)',
                      background: modLoader === l.value ? 'var(--accent-tint)' : 'var(--surface-3)',
                      border:`1px solid ${modLoader === l.value ? 'var(--accent)' : 'var(--border-r)'}`,
                      borderRadius:3, cursor:'pointer',
                    }}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t.editInst.memory(mbToGb(memoryMb))}>
                <input
                  type="range" min={MEMORY_MIN_MB} max={MEMORY_MAX_MB} step={MEMORY_STEP}
                  value={memoryMb} onChange={e => setMemory(Number(e.target.value))}
                  style={{ width:'100%', height:4, appearance:'none', outline:'none', cursor:'pointer', borderRadius:2,
                    background:`linear-gradient(to right, var(--accent) ${fillPct}%, var(--surface-3) 0%)` }}
                />
                <div style={{ display:'flex', gap:4, marginTop:4 }}>
                  {MEMORY_QUICK.map(mb => (
                    <button key={mb} type="button" onClick={() => setMemory(mb)} style={{
                      flex:1, height:26, fontSize:11, fontWeight:500,
                      color: memoryMb === mb ? 'var(--ink)' : 'var(--ink-4)',
                      background: memoryMb === mb ? 'var(--accent-tint)' : 'var(--surface-3)',
                      border:`1px solid ${memoryMb === mb ? 'var(--accent)' : 'var(--border-r)'}`,
                      borderRadius:3, cursor:'pointer',
                    }}>
                      {mbLabel(mb)}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t.editInst.group}>
                <input
                  type="text"
                  value={groupId}
                  onChange={e => setGroupId(e.target.value)}
                  placeholder={t.editInst.groupPlaceholder}
                  style={inputSt}
                />
              </Field>

              <Field label={t.editInst.javaOverride}>
                <select
                  value={javaPath}
                  onChange={e => setJavaPath(e.target.value)}
                  style={selectSt}
                >
                  <option value="">{t.editInst.javaAuto}</option>
                  {javas.map(j => (
                    <option key={j.path} value={j.path}>
                      {t.editInst.javaVersion(j.version, j.vendor)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t.editInst.jvmArgs}>
                <input
                  type="text"
                  value={javaArgs}
                  onChange={e => setJavaArgs(e.target.value)}
                  placeholder={t.editInst.jvmArgsPlaceholder}
                  style={inputSt}
                />
                <div style={{ display:'flex', gap:4, marginTop:4, flexWrap:'wrap' }}>
                  <span style={{ fontSize:10, color:'var(--ink-4)', alignSelf:'center', flexShrink:0, letterSpacing:'.06em' }}>PRESETS:</span>
                  {[
                    { label:"Aikar's", args:'-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -XX:+DisableExplicitGC -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1' },
                    { label:'Low-end', args:'-XX:+UseSerialGC -XX:TieredStopAtLevel=1' },
                  ].map(p => (
                    <button key={p.label} type="button" onClick={() => setJavaArgs(p.args)} style={{ fontSize:10, padding:'2px 8px', background:'var(--surface-3)', color:'var(--ink-3)', border:'1px solid var(--border-r)', borderRadius:3, cursor:'pointer', fontWeight:600 }}>
                      {p.label}
                    </button>
                  ))}
                  {javaArgs && (
                    <button type="button" onClick={() => setJavaArgs('')} style={{ fontSize:10, padding:'2px 8px', background:'none', color:'var(--ink-4)', border:'1px solid var(--border-r)', borderRadius:3, cursor:'pointer' }}>
                      Clear
                    </button>
                  )}
                </div>
              </Field>

              {/* Pin toggle */}
              <label style={{ display:'flex', alignItems:'center', gap:7, cursor:'pointer', userSelect:'none', marginTop:2 }}>
                <input
                  type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)}
                  style={{ cursor:'pointer', accentColor:'var(--accent)' }}
                />
                <span style={{ fontFamily:"'VT323',monospace", fontSize:13, letterSpacing:'.08em', color: pinned ? 'var(--accent)' : 'var(--ink-4)' }}>
                  {t.editInst.pin}
                </span>
              </label>

              <div style={{ flex:1 }} />

              <div style={{ display:'flex', gap:8, paddingTop:12, borderTop:'1px solid var(--line)' }}>
                {onDelete && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={loading}
                    style={{
                      height:38, padding:'0 12px', borderRadius:3, border:'none', cursor: loading ? 'not-allowed' : 'pointer',
                      background: confirmDelete ? 'rgba(217,59,59,.25)' : 'transparent',
                      color: 'var(--redstone)',
                      outline: `1px solid ${confirmDelete ? 'var(--redstone)' : 'rgba(217,59,59,.4)'}`,
                      fontSize:12, fontWeight:700, flexShrink:0, transition:'background .15s',
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
                    style={{
                      height:38, padding:'0 12px', borderRadius:3, border:'1px solid var(--border-r)',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      background:'var(--surface-2)', color:'var(--ink-3)',
                      fontSize:12, fontWeight:600, flexShrink:0,
                    }}
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
                    style={{
                      height:38, padding:'0 12px', borderRadius:3, border:'1px solid var(--border-r)',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      background:'var(--surface-2)', color:'var(--ink-3)',
                      fontSize:12, fontWeight:600, flexShrink:0,
                    }}
                  >
                    {t.editInst.duplicate}
                  </button>
                )}
                <Dialog.Close asChild>
                  <button type="button" disabled={loading} style={cancelSt}>{t.editInst.cancel}</button>
                </Dialog.Close>
                <button type="submit" disabled={!name.trim() || loading} style={{
                  flex:1,
                  fontFamily:"'VT323',monospace", fontSize:18, letterSpacing:'.12em', color:'#fff',
                  height:38, border:'none', borderRadius:3,
                  background: (!name.trim() || loading) ? 'var(--surface-3)' : 'var(--accent)',
                  cursor: (!name.trim() || loading) ? 'not-allowed' : 'pointer',
                  boxShadow: (!name.trim() || loading) ? 'none' : 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)',
                  opacity: (!name.trim() || loading) ? 0.55 : 1,
                }}>
                  {loading ? t.editInst.saving : t.editInst.save}
                </button>
              </div>

            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ImagePickerArea({ image, fallback, onClick }: { image: string; fallback: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      style={{ width:'100%', height:140, position:'relative', cursor:'pointer', overflow:'hidden', flexShrink:0 }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {image
        ? <img src={image} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : fallback
      }
      <div style={{
        position:'absolute', inset:0,
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4,
        background:'rgba(0,0,0,.52)',
        opacity: hover ? 1 : 0,
        transition:'opacity .14s',
      }}>
        <div style={{ fontFamily:"'VT323',monospace", fontSize:14, letterSpacing:'.1em', color:'#fff' }}>
          {image ? 'CHANGE' : 'SET IMAGE'}
        </div>
        <div style={{ fontSize:10, color:'rgba(255,255,255,.6)' }}>click to browse</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
      <div style={{ fontFamily:"'VT323',monospace", fontSize:12, letterSpacing:'.14em', color:'var(--ink-4)' }}>{label}</div>
      {children}
    </div>
  )
}

const inputSt: React.CSSProperties = {
  width:'100%', height:34,
  background:'var(--bg)', border:'1px solid var(--border-r)',
  color:'var(--ink)', padding:'0 10px',
  outline:'none', fontSize:13, borderRadius:3,
}

const selectSt: React.CSSProperties = {
  width:'100%', height:34,
  background:'var(--bg)', border:'1px solid var(--border-r)',
  color:'var(--ink)', padding:'0 10px',
  outline:'none', fontSize:13, borderRadius:3,
  appearance:'none', cursor:'pointer',
}

const cancelSt: React.CSSProperties = {
  flex:1, height:38,
  background:'var(--surface-2)', color:'var(--ink-3)',
  border:'1px solid var(--border-r)', borderRadius:3,
  cursor:'pointer', fontSize:13, fontWeight:500,
}
