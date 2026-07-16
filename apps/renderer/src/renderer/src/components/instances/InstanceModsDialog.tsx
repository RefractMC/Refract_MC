import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, onExportProgress, pickModFiles, supportsFilePicker, type QuickPlayTarget } from '@/lib/api'
import { compressImage } from '@/lib/image'
import { getFilePath } from '@/lib/file-path'
import type { Instance } from '@refract/core'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { RowsSkeleton } from '@/components/ui/Skeleton'

type ContentType = 'mod' | 'resourcepack' | 'shader' | 'datapack'
type ContentEntry = {
  filename: string
  displayName: string
  type: ContentType
  enabled: boolean
  sizeKb: number
  iconDataUrl?: string
}
type WorldEntry = { name: string; lastModified: number; sizeKb: number }
type ScreenshotEntry = { filename: string; sizeKb: number; timestamp: number; dataUrl: string | null }
type ModUpdateEntry = {
  filename: string; projectId: string; latestVersionId: string
  latestVersionName: string; latestFilename: string; downloadUrl: string; hasUpdate: boolean
  contentType: string
}

type TabFilter = 'all' | ContentType | 'worlds' | 'screenshots' | 'updates' | 'servers'
type ServerEntry = { name: string; ip: string; icon?: string }
type ModProfile = { id: string; name: string; enabledFiles: string[] }
type PingResult = { online: number; max: number; latencyMs: number } | null | 'loading'

// Tab labels and empty messages are now loaded from i18n — see useInstanceDetailT() below

const TYPE_COLOR: Record<ContentType, string> = {
  mod:          'var(--accent)',
  resourcepack: '#6aab9c',
  shader:       '#c9a227',
  datapack:     '#9c6aab',
}


interface Props {
  instance: Instance | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onUpdateApplied?: (instanceId: string) => void
  onInstanceUpdated?: () => void
  onLaunch?: (quickPlay?: QuickPlayTarget) => void
  isRunning?: boolean
  onEdit?: () => void
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  const days = Math.floor(diff / 86400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

export function InstanceModsDialog({ instance, open, onOpenChange, onUpdateApplied, onInstanceUpdated, onLaunch, isRunning, onEdit }: Props) {
  const t = useT()
  const td = t.instanceDetail

  const CONTENT_TABS: Array<{ id: TabFilter; label: string }> = [
    { id: 'all',          label: td.tabAll          },
    { id: 'mod',          label: td.tabMods         },
    { id: 'resourcepack', label: td.tabResourcepack },
    { id: 'shader',       label: td.tabShader       },
    { id: 'datapack',     label: td.tabDatapack     },
    { id: 'worlds',       label: td.tabWorlds       },
    { id: 'screenshots',  label: td.tabScreenshots  },
    { id: 'servers',      label: td.tabServers      },
    { id: 'updates',      label: td.tabUpdates      },
  ]

  const EMPTY_MSG: Record<TabFilter, string> = {
    all:          td.emptyAll,
    mod:          td.emptyMods,
    resourcepack: td.emptyResourcepack,
    shader:       td.emptyShader,
    datapack:     td.emptyDatapack,
    worlds:       td.emptyWorlds,
    screenshots:  td.emptyScreenshots,
    servers:      td.emptyServers,
    updates:      td.emptyUpdates,
  }

  const [items, setItems]                = useState<ContentEntry[]>([])
  const [worlds, setWorlds]              = useState<WorldEntry[]>([])
  const [screenshots, setScreenshots]    = useState<ScreenshotEntry[]>([])
  const [modUpdates, setModUpdates]      = useState<ModUpdateEntry[]>([])
  const [servers, setServers]            = useState<ServerEntry[]>([])
  const [iconHover, setIconHover]        = useState(false)
  const [addingMod, setAddingMod]        = useState(false)
  const iconInputRef                     = useRef<HTMLInputElement>(null)
  const modInputRef                      = useRef<HTMLInputElement>(null)
  const [tab, setTab]                    = useState<TabFilter>('all')
  const [loading, setLoading]            = useState(false)
  const [busy, setBusy]                  = useState<Set<string>>(new Set())
  const [error, setError]                = useState<string | null>(null)
  const [exporting, setExporting]        = useState(false)
  const [importingWorld, setImportingWorld] = useState(false)
  const [exportMsg, setExportMsg]        = useState<string | null>(null)
  const [exportPct, setExportPct]        = useState<number | null>(null)
  const [updatingAll, setUpdatingAll]    = useState(false)
  const [profiles, setProfiles]          = useState<ModProfile[]>([])
  const [savingProfile, setSavingProfile]= useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [selectedMods, setSelectedMods]  = useState<Set<string>>(new Set())
  const [lightbox, setLightbox]          = useState<ScreenshotEntry | null>(null)
  const [modSearch, setModSearch]        = useState('')
  const [verifying, setVerifying]        = useState(false)
  const [verifyMsg, setVerifyMsg]        = useState<string | null>(null)
  const [verifyIssues, setVerifyIssues]  = useState(0)

  const load = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setError(null)
    try {
      const list = await api.mods.list(instance.id)
      setItems(list as ContentEntry[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [instance])

  const loadWorlds = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setError(null)
    try { setWorlds(await api.mc.worlds(instance.id)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [instance])

  const loadScreenshots = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setError(null)
    try { setScreenshots(await api.mc.screenshots(instance.id)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [instance])

  const loadUpdates = useCallback(async (force = false) => {
    if (!instance) return
    setLoading(true)
    setError(null)
    try { setModUpdates(await api.modrinth.checkModUpdates(instance.id, force)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [instance])

  const loadServers = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setError(null)
    try { setServers(await api.mc.servers(instance.id) as ServerEntry[]) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [instance])

  const loadProfiles = useCallback(async () => {
    if (!instance) return
    try { setProfiles(await api.mods.profilesList(instance.id) as ModProfile[]) }
    catch { /* ignore */ }
  }, [instance])

  // Audit recorded installs against the files on disk (hash + existence); with
  // repair=true, missing/corrupt files are re-downloaded from the recorded URL.
  const handleVerify = useCallback(async (repair: boolean) => {
    if (!instance || verifying) return
    setVerifying(true)
    try {
      const results = await api.mods.verify(instance.id, repair)
      const bad = results.filter(r => r.status === 'missing' || r.status === 'corrupt')
      setVerifyIssues(bad.length)
      if (repair) {
        const repaired = results.filter(r => r.repaired).length
        setVerifyMsg(td.verifyRepaired(repaired, repaired + bad.length))
        await load()
      } else {
        setVerifyMsg(bad.length === 0 ? td.verifyAllOk(results.length) : td.verifyIssues(bad.length))
      }
    } catch (e) {
      setVerifyMsg(e instanceof Error ? e.message : String(e))
      setVerifyIssues(0)
    } finally {
      setVerifying(false)
    }
  }, [instance, verifying, load, td])

  // Track which tabs have already been loaded this session — avoids re-fetching on tab revisit
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setItems([]); setWorlds([]); setScreenshots([]); setModUpdates([]); setServers([]); setProfiles([])
    setTab('all'); setError(null); setSelectedMods(new Set()); setLoadedTabs(new Set())
    load()
  }, [open, load])

  useEffect(() => { setSelectedMods(new Set()); setModSearch?.('') }, [tab])

  useEffect(() => {
    if (!open) return
    const loaded = (key: string) => loadedTabs.has(key)
    const mark   = (key: string) => setLoadedTabs(prev => new Set([...prev, key]))
    if (tab === 'worlds'      && !loaded('worlds'))      { loadWorlds();      mark('worlds') }
    else if (tab === 'screenshots' && !loaded('screenshots')) { loadScreenshots(); mark('screenshots') }
    else if (tab === 'updates'     && !loaded('updates'))     { loadUpdates();     mark('updates') }
    else if (tab === 'servers'     && !loaded('servers'))     { loadServers();     mark('servers') }
    else if ((tab === 'mod' || tab === 'all') && !loaded('profiles')) { loadProfiles(); mark('profiles') }
  }, [tab, open, loadedTabs, loadWorlds, loadScreenshots, loadUpdates, loadServers, loadProfiles])

  if (!open || !instance) return null

  const isContentTab = (tab !== 'worlds' && tab !== 'screenshots' && tab !== 'updates' && tab !== 'servers')
  const baseVisible = isContentTab ? (tab === 'all' ? items : items.filter(it => it.type === tab)) : []
  const visible = modSearch
    ? baseVisible.filter(e => e.displayName.toLowerCase().includes(modSearch.toLowerCase()))
    : baseVisible
  const updatesAvailable = modUpdates.filter(u => u.hasUpdate)

  const counts: Partial<Record<TabFilter, number>> = {
    all:          items.length,
    mod:          items.filter(i => i.type === 'mod').length,
    resourcepack: items.filter(i => i.type === 'resourcepack').length,
    shader:       items.filter(i => i.type === 'shader').length,
    datapack:     items.filter(i => i.type === 'datapack').length,
    worlds:       worlds.length,
    screenshots:  screenshots.length,
    servers:      servers.length,
    updates:      updatesAvailable.length,
  }

  async function handleToggle(entry: ContentEntry) {
    if (!instance) return
    setBusy(prev => new Set([...prev, entry.filename]))
    try {
      await api.mods.toggle(instance.id, entry.filename, entry.type)
      await load()
    } catch { /* ignore */ } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(entry.filename); return n })
    }
  }

  async function handleDelete(entry: ContentEntry) {
    if (!instance) return
    setBusy(prev => new Set([...prev, entry.filename]))
    try {
      await api.mods.delete(instance.id, entry.filename, entry.type)
      setItems(prev => prev.filter(m => m.filename !== entry.filename))
    } catch { /* ignore */ } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(entry.filename); return n })
    }
  }

  async function handleDeleteWorld(worldName: string) {
    if (!instance) return
    setBusy(prev => new Set([...prev, worldName]))
    try {
      await api.mc.deleteWorld(instance.id, worldName)
      setWorlds(prev => prev.filter(w => w.name !== worldName))
    } catch { /* ignore */ } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(worldName); return n })
    }
  }

  async function handleIconPick(e: ChangeEvent<HTMLInputElement>) {
    if (!instance) return
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const dataUrl = await compressImage(file, 400)
      await api.instance.update(instance.id, { iconPath: dataUrl })
      onInstanceUpdated?.()
    } catch { /* ignore */ }
    e.target.value = ''
  }

  async function handleAddModFile(e: ChangeEvent<HTMLInputElement>) {
    if (!instance) return
    const file = e.target.files?.[0]
    const path = file && getFilePath(file)
    if (!path) return
    setAddingMod(true)
    try {
      await api.mods.installLocal(instance.id, path)
      await load()
    } catch { /* ignore */ } finally {
      setAddingMod(false)
    }
    e.target.value = ''
  }

  // Tauri has no real path from <input type=file>; use the native picker instead.
  async function handleAddModBrowse() {
    if (!instance) return
    const paths = await pickModFiles()
    if (!paths.length) return
    setAddingMod(true)
    try {
      for (const p of paths) await api.mods.installLocal(instance.id, p)
      await load()
    } catch { /* ignore */ } finally {
      setAddingMod(false)
    }
  }

  async function handleApplyProfile(profileId: string) {
    if (!instance) return
    try { await api.mods.profilesApply(instance.id, profileId); await load() }
    catch { /* ignore */ }
  }

  async function handleSaveProfile() {
    if (!instance || !newProfileName.trim()) return
    try {
      const enabledFiles = items.filter(i => i.type === 'mod' && i.enabled).map(i => i.filename.replace(/\.disabled$/, ''))
      const p = await api.mods.profilesSave(instance.id, newProfileName.trim(), enabledFiles) as ModProfile
      setProfiles(prev => [...prev, p])
      setNewProfileName('')
      setSavingProfile(false)
    } catch { /* ignore */ }
  }

  async function handleDeleteProfile(profileId: string) {
    if (!instance) return
    try { await api.mods.profilesDelete(instance.id, profileId); setProfiles(prev => prev.filter(p => p.id !== profileId)) }
    catch { /* ignore */ }
  }

  async function handleBulkToggle(enable: boolean) {
    if (!instance || selectedMods.size === 0) return
    const targets = visible.filter(e => selectedMods.has(e.filename) && e.enabled !== enable && !e.filename.includes('/'))
    setBusy(prev => new Set([...prev, ...targets.map(e => e.filename)]))
    try {
      for (const entry of targets) await api.mods.toggle(instance.id, entry.filename, entry.type)
      await load()
      setSelectedMods(new Set())
    } catch { /* ignore */ }
    finally { setBusy(prev => { const n = new Set(prev); targets.forEach(e => n.delete(e.filename)); return n }) }
  }

  async function handleBulkDelete() {
    if (!instance || selectedMods.size === 0) return
    const targets = visible.filter(e => selectedMods.has(e.filename))
    setBusy(prev => new Set([...prev, ...targets.map(e => e.filename)]))
    try {
      for (const entry of targets) await api.mods.delete(instance.id, entry.filename, entry.type)
      setItems(prev => prev.filter(m => !selectedMods.has(m.filename)))
      setSelectedMods(new Set())
    } catch { /* ignore */ }
    finally { setBusy(prev => { const n = new Set(prev); targets.forEach(e => n.delete(e.filename)); return n }) }
  }

  async function handleImportWorld() {
    if (!instance || importingWorld) return
    setImportingWorld(true)
    try {
      const name = await api.mc.importWorld(instance.id)
      if (name) await loadWorlds()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImportingWorld(false)
    }
  }

  async function handleExport(format: 'zip' | 'mrpack' = 'zip') {
    if (!instance || exporting) return
    setExporting(true)
    setExportMsg(null)
    setExportPct(0)
    const off = onExportProgress((p) => {
      if (p.id === instance.id) setExportPct(Math.round(p.percent))
    })
    try {
      const path = format === 'mrpack'
        ? await api.instance.exportMrpack(instance.id, instance.name)
        : await api.instance.export(instance.id)
      if (path) setExportMsg(`Exported to ${path}`)
    } catch (e) {
      setExportMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      off()
      setExporting(false)
      setExportPct(null)
      setTimeout(() => setExportMsg(null), 5000)
    }
  }

  const dialog = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,.72)',
        backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onOpenChange(false) }}
    >
      <div
        className="detail-dialog"
        onClick={e => e.stopPropagation()}
      >
        {/* Hidden file inputs */}
        <input ref={iconInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleIconPick} />
        <input ref={modInputRef} type="file" accept=".jar,.zip" style={{ display: 'none' }} onChange={handleAddModFile} />

        {/* Header */}
        <div className="detail-header">
          {/* Instance icon — click to change */}
          <div
            title="Click to change image"
            onClick={() => iconInputRef.current?.click()}
            onMouseEnter={() => setIconHover(true)}
            onMouseLeave={() => setIconHover(false)}
            className="detail-icon"
            style={{
              cursor: 'pointer', position: 'relative',
              borderColor: iconHover ? 'var(--accent)' : undefined,
              transition: 'border-color 120ms',
            }}
          >
            {instance.iconPath
              ? <img src={instance.iconPath} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: 'var(--accent)' }}>⬡</div>
            }
            {iconHover && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 18, color: '#fff' }}>🖼</span>
              </div>
            )}
          </div>

          {/* Instance info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="detail-title" style={{ fontSize: 24, fontWeight: 850, color: 'var(--ink)', lineHeight: 1.05, letterSpacing: '-.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {instance.name}
            </div>
            <div className="detail-meta" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', background: 'color-mix(in srgb, var(--bg) 76%, transparent)' }}>MC {instance.minecraftVersion}</span>
              <span style={{ color: 'var(--border-r)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-hi)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', background: 'var(--accent-tint)' }}>{instance.modLoader?.toUpperCase() ?? 'VANILLA'}</span>
              <span style={{ color: 'var(--border-r)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', background: 'color-mix(in srgb, var(--bg) 76%, transparent)' }}>{items.length} mod{items.length !== 1 ? 's' : ''}</span>
            </div>
            {instance.playtimeLog && Object.keys(instance.playtimeLog).length > 0 && (
              <PlaytimeChart log={instance.playtimeLog} />
            )}
          </div>

          {/* Actions */}
          <div className="detail-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {onLaunch && (
              <Button
                variant={isRunning ? 'danger' : 'primary'}
                onClick={() => { onLaunch(); onOpenChange(false) }}
                style={{
                  height: 36, padding: '0 18px',
                  fontSize: 13, letterSpacing: '.04em', fontWeight: 700,
                }}
              >
                {isRunning ? td.stopBtn : td.playBtn}
              </Button>
            )}
            {onEdit && (
              <Button
                variant="secondary"
                onClick={() => { onEdit(); onOpenChange(false) }}
                style={{ height: 36, padding: '0 12px', fontSize: 12 }}
              >
                Edit
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('zip')}
              disabled={exporting}
              title="Export instance as ZIP"
              style={{ fontSize: 11 }}
            >
              {exporting ? td.exporting : td.exportZip}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport('mrpack')}
              disabled={exporting}
              title="Share as a Modrinth modpack (.mrpack) — importable in any launcher"
              style={{ fontSize: 11 }}
            >
              {exporting ? td.exporting : td.exportMrpack}
            </Button>
            {tab === 'updates' && updatesAvailable.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  if (!instance || updatingAll) return
                  setUpdatingAll(true)
                  try {
                    await api.modrinth.applyModUpdates(
                      instance.id,
                      updatesAvailable.map(u => ({ filename: u.filename, downloadUrl: u.downloadUrl, newFilename: u.latestFilename, contentType: u.contentType }))
                    )
                    await loadUpdates(true)
                    onUpdateApplied?.(instance.id)
                  } catch { /* ignore */ } finally {
                    setUpdatingAll(false)
                  }
                }}
                disabled={updatingAll}
                style={{ fontSize: 11 }}
              >
                {updatingAll ? td.updating : td.updateAll(updatesAvailable.length)}
              </Button>
            )}
            {isContentTab && (tab === 'mod' || tab === 'all') && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleVerify(false)}
                disabled={verifying}
                title="Check every tracked file against its recorded hash"
                style={{ fontSize: 11 }}
              >
                {verifying ? td.verifying : td.verifyFiles}
              </Button>
            )}
            {isContentTab && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => (supportsFilePicker ? handleAddModBrowse() : modInputRef.current?.click())}
                disabled={addingMod}
                style={{ fontSize: 11 }}
              >
                {addingMod ? td.adding : td.addFile}
              </Button>
            )}
            {tab === 'worlds' && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleImportWorld}
                disabled={importingWorld}
                title="Import a world from a zip backup"
                style={{ fontSize: 11 }}
              >
                {importingWorld ? td.importingWorld : td.importWorld}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={tab === 'worlds' ? loadWorlds : tab === 'screenshots' ? loadScreenshots : tab === 'updates' ? () => loadUpdates(true) : tab === 'servers' ? loadServers : load}
              style={{ fontSize: 11 }}
            >
              {td.refresh}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              style={{ color: 'var(--ink-4)', fontSize: 18, lineHeight: 1 }}
            >
              ✕
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="detail-tabs">
          {CONTENT_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="detail-tab"
              data-active={tab === t.id}
            >
              {t.label}
              {(counts[t.id] ?? 0) > 0 && (
                <span style={{
                  fontSize: 10, lineHeight: 1,
                  background: tab === t.id ? 'var(--accent)' : 'var(--surface-3)',
                  color: tab === t.id ? '#fff' : 'var(--ink-4)',
                  borderRadius: 'var(--radius-md)', padding: '1px 5px',
                }}>
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Verify result strip */}
        {verifyMsg && (tab === 'mod' || tab === 'all') && (
          <div className="detail-strip" style={{ minHeight: 34, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 8, height: 8, flexShrink: 0, background: verifyIssues > 0 ? 'var(--lava)' : 'var(--grass)' }} />
            <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{verifyMsg}</span>
            {verifyIssues > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleVerify(true)}
                disabled={verifying}
                style={{ fontSize: 11, marginLeft: 'auto' }}
              >
                {verifying ? td.verifying : td.repairFiles}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { setVerifyMsg(null); setVerifyIssues(0) }}
              style={{ color: 'var(--ink-4)', fontSize: 13, marginLeft: verifyIssues > 0 ? 0 : 'auto' }}
            >
              ✕
            </Button>
          </div>
        )}

        {/* Mod profiles strip */}
        {isContentTab && (tab === 'mod' || tab === 'all') && (
          <div className="detail-strip" style={{ minHeight: 38 }}>
            <span style={{ fontSize: 10, color: 'var(--ink-4)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', flexShrink: 0, marginRight: 2 }}>
              {td.profiles}
            </span>
            {profiles.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center' }}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyProfile(p.id)}
                  title={`Apply "${p.name}" — ${p.enabledFiles.length} mods enabled`}
                  className="glow-hover"
                  style={{
                    fontSize: 11, padding: '2px 8px',
                    background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                    borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)', color: 'var(--ink-2)',
                    borderRight: 'none',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--accent)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-r)'; (e.currentTarget as HTMLElement).style.color = 'var(--ink-2)' }}
                >
                  {p.name}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDeleteProfile(p.id)}
                  title="Delete profile"
                  style={{
                    fontSize: 10, padding: '2px 5px',
                    background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--ink-4)',
                    lineHeight: 1,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--lava)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--lava)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--ink-4)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-r)' }}
                >
                  ✕
                </Button>
              </div>
            ))}
            {savingProfile ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={newProfileName}
                  onChange={e => setNewProfileName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSaveProfile()
                    if (e.key === 'Escape') { setSavingProfile(false); setNewProfileName('') }
                  }}
                  placeholder="Profile name…"
                  style={{
                    height: 22, padding: '0 7px', fontSize: 11, width: 120,
                    background: 'var(--bg)', border: '1px solid var(--accent)',
                    borderRadius: 'var(--radius-sm)', color: 'var(--ink)', outline: 'none',
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveProfile}
                  style={{ fontSize: 11, padding: '1px 8px' }}
                >
                  {td.saving}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setSavingProfile(false); setNewProfileName('') }}
                  style={{ fontSize: 11, padding: '1px 8px' }}
                >
                  {td.cancel}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSavingProfile(true)}
                style={{
                  fontSize: 11, padding: '2px 8px',
                  background: 'none', border: '1px dashed var(--border-r)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--ink-4)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--accent)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-r)'; (e.currentTarget as HTMLElement).style.color = 'var(--ink-4)' }}
              >
                {td.saveProfile}
              </Button>
            )}
          </div>
        )}

        {/* Bulk action bar */}
        {isContentTab && selectedMods.size > 0 && (
          <div className="detail-strip" style={{ background:'var(--accent-tint)', borderBottom:'1px solid var(--accent)' }}>
            <span style={{ fontSize:11, color:'var(--accent)', fontWeight:700, minWidth:70 }}>{td.selected(selectedMods.size)}</span>
            <Button variant="outline" size="sm" onClick={() => handleBulkToggle(true)}  style={{ fontSize:11, padding:'2px 10px', background:'var(--surface-2)', color:'var(--grass)', border:'1px solid var(--grass)', fontWeight:600 }}>{td.enable}</Button>
            <Button variant="danger"  size="sm" onClick={() => handleBulkToggle(false)} style={{ fontSize:11, padding:'2px 10px', background:'var(--surface-2)', color:'var(--gold)',  border:'1px solid var(--gold)',  fontWeight:600 }}>{td.disable}</Button>
            <Button variant="danger"  size="sm" onClick={handleBulkDelete}              style={{ fontSize:11, padding:'2px 10px', background:'var(--surface-2)', color:'var(--lava)',  border:'1px solid var(--lava)',  fontWeight:600 }}>{td.delete}</Button>
            <div style={{ flex:1 }} />
            <Button variant="ghost" size="sm" onClick={() => setSelectedMods(new Set(visible.filter(e => !e.filename.includes('/')).map(e => e.filename)))} style={{ fontSize:10, color:'var(--ink-3)' }}>{td.selectAll}</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedMods(new Set())} style={{ fontSize:10, color:'var(--ink-4)' }}>{td.clear}</Button>
          </div>
        )}

        {/* Export progress */}
        {exportPct !== null && (
          <div style={{ padding: '8px 16px', background: 'var(--bg)', borderBottom: '1px solid var(--line)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div style={{ width: `${exportPct}%`, height: '100%', background: 'var(--accent)', transition: 'width .15s linear' }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', minWidth: 64, textAlign: 'right' }}>
              {td.exporting} {exportPct}%
            </span>
          </div>
        )}

        {/* Export message */}
        {exportMsg && (
          <div style={{ padding: '6px 16px', fontSize: 11, color: exportMsg.startsWith('Export failed') ? 'var(--lava)' : 'var(--grass)', background: 'var(--bg)', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
            {exportMsg}
          </div>
        )}

        {/* Body */}
        {/* Mod search */}
        {isContentTab && items.length > 6 && (
          <div className="detail-strip" style={{ padding: '8px 12px' }}>
            <input
              className="detail-search"
              value={modSearch}
              onChange={e => setModSearch(e.target.value)}
              placeholder="Search mods…"
            />
          </div>
        )}

        <div className="detail-body" style={{ flex: 1, overflowY: 'auto', padding: tab === 'screenshots' ? 14 : '8px 0' }}>
          {loading ? (
            <RowsSkeleton rows={7} />
          ) : error ? (
            <div style={{ padding: '20px 16px', color: 'var(--lava)', fontSize: 12 }}>{error}</div>
          ) : tab === 'worlds' ? (
            worlds.length === 0 ? (
              <EmptyMsg msg={EMPTY_MSG.worlds} sub={td.emptyWorldsSub} />
            ) : worlds.map(w => (
              <WorldRow
                key={w.name}
                world={w}
                isBusy={busy.has(w.name)}
                onDelete={() => handleDeleteWorld(w.name)}
                onBackup={async () => {
                  if (!instance) return
                  try { await api.mc.backupWorld(instance.id, w.name) } catch { /* ignore */ }
                }}
                onPlay={onLaunch && !isRunning ? () => { onLaunch({ kind: 'world', name: w.name }); onOpenChange(false) } : undefined}
                onShortcut={() => api.mc.createShortcut(instance.id, `${instance.name} — ${w.name}`, { kind: 'world', name: w.name })}
              />
            ))
          ) : tab === 'screenshots' ? (
            screenshots.length === 0 ? (
              <EmptyMsg msg={EMPTY_MSG.screenshots} sub={td.emptyScreensSub} />
            ) : (
              <div className="detail-screenshot-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {screenshots.map(s => (
                  <ScreenshotThumb
                    key={s.filename}
                    shot={s}
                    onClick={() => setLightbox(s)}
                  />
                ))}
              </div>
            )
          ) : tab === 'servers' ? (
            servers.length === 0 ? (
              <EmptyMsg msg={EMPTY_MSG.servers} sub={td.emptyServersSub} />
            ) : servers.map(s => (
              <ServerRow
                key={s.ip}
                server={s}
                onJoin={onLaunch && !isRunning ? () => { onLaunch({ kind: 'server', address: s.ip }); onOpenChange(false) } : undefined}
                onShortcut={() => api.mc.createShortcut(instance.id, `${instance.name} — ${s.name || s.ip}`, { kind: 'server', address: s.ip })}
              />
            ))
          ) : tab === 'updates' ? (
            modUpdates.length === 0 ? (
              <EmptyMsg msg={EMPTY_MSG.updates} sub={td.emptyUpdatesSub} />
            ) : (
              <>
                {modUpdates.map(u => (
                  <UpdateRow key={u.filename} entry={u} />
                ))}
              </>
            )
          ) : visible.length === 0 ? (
            <EmptyMsg msg={EMPTY_MSG[tab]} sub={td.emptyContentSub} />
          ) : visible.map(entry => (
            <ContentRow
              key={entry.filename}
              entry={entry}
              isBusy={busy.has(entry.filename)}
              selected={selectedMods.has(entry.filename)}
              onSelect={() => setSelectedMods(prev => { const n = new Set(prev); n.has(entry.filename) ? n.delete(entry.filename) : n.add(entry.filename); return n })}
              onToggle={() => handleToggle(entry)}
              onDelete={() => handleDelete(entry)}
            />
          ))}
        </div>

        {/* Screenshot lightbox rendered via portal to escape overflow:hidden and stacking context */}
        {lightbox && createPortal(
          <ScreenshotLightbox
            shot={lightbox}
            instanceId={instance.id}
            onClose={() => setLightbox(null)}
            onOpenExternal={() => { api.mc.openScreenshot(instance.id, lightbox.filename).catch(() => {}); setLightbox(null) }}
          />,
          document.body
        )}
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}

function ScreenshotLightbox({ shot, instanceId, onClose, onOpenExternal }: {
  shot: ScreenshotEntry
  instanceId: string
  onClose: () => void
  onOpenExternal: () => void
}) {
  const t = useT()
  const [fullSrc, setFullSrc] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    api.mc.screenshotFull(instanceId, shot.filename).then(s => setFullSrc(s)).catch(() => {})
    return () => window.removeEventListener('keydown', handler)
  }, [shot.filename, instanceId, onClose])

  return (
    <div
      onClick={e => { e.stopPropagation(); onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        background: 'rgba(0,0,0,.93)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14,
      }}
    >
      <img
        src={fullSrc ?? shot.dataUrl ?? undefined}
        alt={shot.filename}
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '90vw', maxHeight: '82vh',
          objectFit: 'contain', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-floating)',
          opacity: fullSrc ? 1 : 0.65,
          transition: 'opacity 200ms',
        }}
      />
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', gap: 10, alignItems: 'center' }}
      >
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'rgba(255,255,255,.4)' }}>{shot.filename} · {shot.sizeKb} KB</span>
        <Button variant="ghost" size="sm" onClick={onOpenExternal} style={{ fontSize: 11, color: 'rgba(255,255,255,.7)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.18)' }}>
          {t.instanceDetail.openViewer}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} style={{ fontSize: 11, color: 'rgba(255,255,255,.7)', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.18)' }}>
          ✕ Close
        </Button>
      </div>
    </div>
  )
}

function pingColor(ms: number): string {
  if (ms < 80) return 'var(--grass)'
  if (ms < 150) return '#8bc34a'
  if (ms < 250) return 'var(--gold)'
  return 'var(--lava)'
}

/// Creates a desktop shortcut for a Quick Play target, with a transient result state.
function ShortcutButton({ onCreate }: { onCreate: () => Promise<unknown> }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={state === 'busy'}
      title="Create a desktop shortcut that launches straight into this"
      onClick={async () => {
        if (state === 'busy') return
        setState('busy')
        try { await onCreate(); setState('done') } catch { setState('error') }
        setTimeout(() => setState('idle'), 2500)
      }}
      style={{ fontSize: 11, color: state === 'done' ? 'var(--grass)' : state === 'error' ? 'var(--lava)' : 'var(--ink-3)', background: 'none' }}
    >
      {state === 'done' ? t.instanceDetail.shortcutDone : state === 'error' ? t.instanceDetail.shortcutFailed : t.instanceDetail.shortcut}
    </Button>
  )
}

function ServerRow({ server, onJoin, onShortcut }: { server: ServerEntry; onJoin?: () => void; onShortcut?: () => Promise<unknown> }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [ping, setPing] = useState<PingResult>('loading')

  useEffect(() => {
    setPing('loading')
    api.mc.pingServer(server.ip).then(r => setPing(r)).catch(() => setPing(null))
  }, [server.ip])

  function copy() {
    navigator.clipboard.writeText(server.ip).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const isOnline = ping !== 'loading' && ping !== null
  const isOffline = ping === null

  return (
    <div className="detail-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
      <div style={{ width: 36, height: 36, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18, overflow: 'hidden' }}>
        {server.icon ? <img src={`data:image/png;base64,${server.icon}`} alt="" style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }} /> : '🖥'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name || 'Unknown Server'}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{server.ip}</span>
          {ping === 'loading' && <span style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>{t.instanceDetail.pinging}</span>}
          {ping !== 'loading' && ping !== null && (
            <>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: pingColor(ping.latencyMs), fontWeight: 600 }}>{ping.latencyMs}ms</span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--ink-3)' }}>{t.instanceDetail.players(ping.online, ping.max)}</span>
            </>
          )}
          {isOffline && <span style={{ color: 'var(--ink-4)' }}>{t.instanceDetail.offline}</span>}
        </div>
      </div>
      {/* Online indicator dot */}
      <div style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: ping === 'loading' ? 'var(--border-r)' : isOnline ? 'var(--grass)' : 'var(--lava)',
        transition: 'background 300ms',
      }} />
      <Button
        variant="secondary"
        size="sm"
        onClick={copy}
        style={{ fontSize: 11, color: copied ? 'var(--grass)' : 'var(--ink-3)' }}
      >
        {copied ? t.instanceDetail.copied : t.instanceDetail.copyIp}
      </Button>
      {onShortcut && <ShortcutButton onCreate={onShortcut} />}
      {onJoin && (
        <Button
          variant="primary"
          size="sm"
          onClick={onJoin}
          title="Launch the game straight into this server"
          style={{ fontSize: 11 }}
        >
          {t.instanceDetail.join}
        </Button>
      )}
    </div>
  )
}

function EmptyMsg({ msg, sub }: { msg: string; sub: string }) {
  return (
    <div className="detail-empty">
      <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-tint)', border: '1px solid color-mix(in srgb, var(--accent) 38%, transparent)', margin: '0 auto 14px', boxShadow: '0 0 22px color-mix(in srgb, var(--accent) 18%, transparent)' }} />
      <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--ink-2)', letterSpacing: '.04em', marginBottom: 6 }}>{msg}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{sub}</div>
    </div>
  )
}

function WorldRow({ world, isBusy, onDelete, onBackup, onPlay, onShortcut }: { world: WorldEntry; isBusy: boolean; onDelete: () => void; onBackup?: () => void; onPlay?: () => void; onShortcut?: () => Promise<unknown> }) {
  const t = useT()
  const td = t.instanceDetail
  const [confirm, setConfirm] = useState(false)
  const [backing, setBacking] = useState(false)
  return (
    <div className="detail-row" style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px',
      borderBottom: '1px solid var(--line)', opacity: isBusy ? 0.5 : 1,
    }}>
      <div style={{ width: 36, height: 36, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 18 }}>
        🌍
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{world.name}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2, display: 'flex', gap: 10 }}>
          <span>{formatDate(world.lastModified)}</span>
          {world.sizeKb > 0 && <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{formatSize(world.sizeKb)}</span>}
        </div>
      </div>
      <div style={{ display:'flex', gap:5 }}>
        {onShortcut && <ShortcutButton onCreate={onShortcut} />}
        {onPlay && (
          <Button
            variant="primary"
            size="sm"
            onClick={onPlay}
            disabled={isBusy}
            title="Launch the game straight into this world (MC 1.20+)"
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            {td.play}
          </Button>
        )}
        {onBackup && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => { setBacking(true); await onBackup(); setBacking(false) }}
            disabled={isBusy || backing}
            style={{ fontSize:11, color:'var(--diamond)', background:'none', border:'1px solid var(--diamond)', padding:'3px 9px', opacity: backing ? .6 : 1 }}
          >
            {backing ? td.backing : td.backup}
          </Button>
        )}
        {confirm ? (
          <div style={{ display: 'flex', gap: 5 }}>
            <Button variant="danger" size="sm" onClick={() => { setConfirm(false); onDelete() }} disabled={isBusy} style={{ fontSize: 11, padding: '3px 10px' }}>{td.delete}</Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(false)} style={{ fontSize: 11, padding: '3px 10px' }}>Cancel</Button>
          </div>
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirm(true)}
            disabled={isBusy}
            style={{ fontSize: 11, color: 'var(--ink-4)', background: 'none', border: '1px solid transparent', padding: '3px 8px' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--lava)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--lava)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--ink-4)' }}
          >
            {td.delete}
          </Button>
        )}
      </div>
    </div>
  )
}

function ScreenshotThumb({ shot, onClick }: { shot: ScreenshotEntry; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', borderRadius: 'var(--radius-sm)', overflow: 'hidden', cursor: 'pointer',
        border: `1px solid ${hover ? 'var(--accent)' : 'var(--border-r)'}`,
        background: 'var(--surface-2)', aspectRatio: '16 / 9',
        transition: 'border-color 120ms',
      }}
    >
      {shot.dataUrl ? (
        <img src={shot.dataUrl} alt={shot.filename} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>📷</div>
      )}
      {hover && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#fff', letterSpacing: '.10em' }}>OPEN</div>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 9, color: 'rgba(255,255,255,.6)', textAlign: 'center', lineHeight: 1.3, wordBreak: 'break-all' }}>{shot.sizeKb} KB</div>
        </div>
      )}
    </div>
  )
}

const UPDATE_TYPE_LABEL: Record<string, string> = {
  mod: 'Mod', resourcepack: 'Resource Pack', shader: 'Shader', datapack: 'Datapack',
}

function UpdateRow({ entry }: { entry: ModUpdateEntry }) {
  const displayName = entry.filename.replace(/\.(jar|zip)(\.disabled)?$/, '').replace(/-\d.*$/, '')
  const typeColor = (TYPE_COLOR as Record<string, string>)[entry.contentType] ?? 'var(--ink-4)'
  return (
    <div className="detail-row" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 14px',
      borderBottom: '1px solid var(--line)',
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: entry.hasUpdate ? 'var(--gold)' : 'var(--grass)',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 6 }}>
          {entry.contentType && entry.contentType !== 'mod' && (
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: typeColor, border: `1px solid ${typeColor}`, borderRadius: 'var(--radius-sm)', padding: '0 4px', flexShrink: 0 }}>
              {UPDATE_TYPE_LABEL[entry.contentType] ?? entry.contentType}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 1 }}>
          {entry.hasUpdate ? (
            <span>Update available — <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{entry.latestVersionName}</span></span>
          ) : (
            <span style={{ color: 'var(--grass)' }}>Up to date</span>
          )}
        </div>
      </div>
      {entry.hasUpdate && (
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.10em',
          padding: '2px 7px', borderRadius: 'var(--radius-sm)',
          background: 'color-mix(in srgb, var(--gold) 20%, transparent)',
          color: 'var(--gold)',
          border: '1px solid var(--gold)',
        }}>
          UPDATE
        </div>
      )}
    </div>
  )
}

function ContentRow({ entry, isBusy, selected, onSelect, onToggle, onDelete }: {
  entry: ContentEntry
  isBusy: boolean
  selected?: boolean
  onSelect?: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const color = TYPE_COLOR[entry.type]
  const isFolder = !entry.filename.includes('.')

  return (
    <div className="detail-row" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '7px 14px',
      borderBottom: '1px solid var(--line)',
      opacity: isBusy ? 0.5 : 1,
      transition: 'opacity 150ms',
      background: selected ? 'var(--accent-tint)' : undefined,
    }}>
      {/* Checkbox */}
      {onSelect && (
        <input type="checkbox" checked={!!selected} onChange={onSelect}
          style={{ cursor:'pointer', flexShrink:0, accentColor:'var(--accent)', width:14, height:14 }} />
      )}
      {/* Icon */}
      <div style={{
        width: 34, height: 34, flexShrink: 0, borderRadius: 'var(--radius-sm)', overflow: 'hidden',
        background: entry.enabled ? 'color-mix(in srgb, ' + color + ' 18%, var(--surface-2))' : 'var(--surface-2)',
        border: `1px solid ${entry.enabled ? color : 'var(--border-r)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        imageRendering: 'pixelated',
      }}>
        {entry.iconDataUrl ? (
          <img
            src={entry.iconDataUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
          />
        ) : (
          <TypeIcon type={entry.type} color={entry.enabled ? color : 'var(--ink-4)'} />
        )}
      </div>

      {/* Name + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 500,
          color: entry.enabled ? 'var(--ink)' : 'var(--ink-4)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {entry.displayName}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color, fontWeight: 600, textTransform: 'uppercase', fontSize: 9, letterSpacing: '.04em' }}>
            {entry.type === 'resourcepack' ? 'Resource Pack' : entry.type === 'datapack' ? 'Datapack' : entry.type === 'shader' ? 'Shader' : 'Mod'}
          </span>
          {entry.sizeKb > 0 && (
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{entry.sizeKb >= 1024 ? `${(entry.sizeKb / 1024).toFixed(1)} MB` : `${entry.sizeKb} KB`}</span>
          )}
          {!entry.enabled && <span style={{ color: 'var(--gold)' }}>disabled</span>}
        </div>
      </div>

      {/* Toggle (only for non-folder file entries) */}
      {!isFolder ? (
        <button
          onClick={onToggle}
          disabled={isBusy}
          title={entry.enabled ? 'Disable' : 'Enable'}
          style={{
            width: 36, height: 20, flexShrink: 0,
            background: entry.enabled ? color : 'var(--surface-3)',
            border: `1px solid ${entry.enabled ? color : 'var(--border-r)'}`,
            borderRadius: 'var(--radius-lg)',
            cursor: 'pointer',
            position: 'relative',
            transition: 'background 150ms',
          }}
        >
          <div style={{
            position: 'absolute',
            top: 2, left: entry.enabled ? 18 : 2,
            width: 14, height: 14,
            background: '#fff',
            borderRadius: '50%',
            transition: 'left 150ms',
            boxShadow: '0 1px 3px rgba(0,0,0,.3)',
          }} />
        </button>
      ) : (
        <div style={{ width: 36, flexShrink: 0 }} />
      )}

      {/* Delete */}
      {confirmDelete ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => { setConfirmDelete(false); onDelete() }}
            disabled={isBusy}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Delete
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirmDelete(false)}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="danger"
          size="icon"
          onClick={() => setConfirmDelete(true)}
          disabled={isBusy}
          title="Delete"
          style={{
            width: 24, height: 24, flexShrink: 0,
            background: 'none', border: '1px solid transparent',
            color: 'var(--ink-4)',
            fontSize: 14, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={e => {
            const btn = (e.target as HTMLElement).closest('button')!
            btn.style.borderColor = 'var(--lava)'
            btn.style.color = 'var(--lava)'
          }}
          onMouseLeave={e => {
            const btn = (e.target as HTMLElement).closest('button')!
            btn.style.borderColor = 'transparent'
            btn.style.color = 'var(--ink-4)'
          }}
        >
          ✕
        </Button>
      )}
    </div>
  )
}

function TypeIcon({ type, color }: { type: ContentType; color: string }) {
  if (type === 'mod') {
    return <div style={{ width: 14, height: 14, background: color, borderRadius: 'var(--radius-sm)' }} />
  }
  if (type === 'resourcepack') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="1" stroke={color} strokeWidth="1.5" fill="none" />
        <circle cx="5.5" cy="5.5" r="1.5" fill={color} />
        <path d="M2 11 L5 8 L8 10 L11 7 L14 11" stroke={color} strokeWidth="1.5" fill="none" />
      </svg>
    )
  }
  if (type === 'shader') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="3" fill={color} />
        <line x1="8" y1="1" x2="8" y2="3" stroke={color} strokeWidth="1.5" />
        <line x1="8" y1="13" x2="8" y2="15" stroke={color} strokeWidth="1.5" />
        <line x1="1" y1="8" x2="3" y2="8" stroke={color} strokeWidth="1.5" />
        <line x1="13" y1="8" x2="15" y2="8" stroke={color} strokeWidth="1.5" />
        <line x1="3.05" y1="3.05" x2="4.46" y2="4.46" stroke={color} strokeWidth="1.5" />
        <line x1="11.54" y1="11.54" x2="12.95" y2="12.95" stroke={color} strokeWidth="1.5" />
        <line x1="12.95" y1="3.05" x2="11.54" y2="4.46" stroke={color} strokeWidth="1.5" />
        <line x1="4.46" y1="11.54" x2="3.05" y2="12.95" stroke={color} strokeWidth="1.5" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2" width="10" height="12" rx="1" stroke={color} strokeWidth="1.5" fill="none" />
      <line x1="6" y1="5" x2="10" y2="5" stroke={color} strokeWidth="1.2" />
      <line x1="6" y1="8" x2="10" y2="8" stroke={color} strokeWidth="1.2" />
      <line x1="6" y1="11" x2="9" y2="11" stroke={color} strokeWidth="1.2" />
    </svg>
  )
}

function PlaytimeChart({ log }: { log: Record<string, number> }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    const key = d.toISOString().split('T')[0]
    const mins = Math.round((log[key] ?? 0) / 60)
    const label = i === 6 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' })
    return { key, mins, label, isToday: i === 6 }
  })
  const max = Math.max(...days.map(d => d.mins), 1)
  const totalMins = days.reduce((s, d) => s + d.mins, 0)
  if (totalMins === 0) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 3, alignItems: 'flex-end', height: 36 }} title={`${totalMins}m this week`}>
      {days.map(d => (
        <div key={d.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <div
            title={d.mins > 0 ? `${d.mins}m on ${d.label}` : d.label}
            style={{
              width: '100%', minHeight: 2,
              height: `${Math.max(2, (d.mins / max) * 24)}px`,
              background: d.isToday ? 'var(--accent)' : d.mins > 0 ? 'var(--surface-3)' : 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
          <div style={{ fontSize: 8, color: 'var(--ink-4)' }}>{d.label.slice(0, 2).toUpperCase()}</div>
        </div>
      ))}
    </div>
  )
}
