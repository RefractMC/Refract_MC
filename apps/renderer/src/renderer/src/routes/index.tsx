import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type { Instance, MinecraftVersion } from '@refract/core'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
import { ChevLeftIcon, ChevRightIcon } from '@/components/ui/BlockIcons'
import { CreateInstanceDialog } from '@/components/instances/CreateInstanceDialog'
import { EditInstanceDialog } from '@/components/instances/EditInstanceDialog'
import { InstanceModsDialog } from '@/components/instances/InstanceModsDialog'
import { InstallProgress } from '@/components/minecraft/InstallProgress'
import { useInstances, useCreateInstance, useUpdateInstance, useDeleteInstance } from '@/hooks/use-instances'
import { api } from '@/lib/api'

export const Route = createFileRoute('/')({
  component: Library,
})

type ActiveAccount = Awaited<ReturnType<typeof api.auth.active>>

const CHANGELOG_URL = 'https://raw.githubusercontent.com/ShevRuslan1/Refract_MC/main/CHANGELOG.md'

interface ChangelogEntry { version: string; notes: string[] }

function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const vMatch = line.match(/^##\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/)
    if (vMatch) {
      if (current) entries.push(current)
      current = { version: vMatch[1], notes: [] }
    } else if (current && line.startsWith('- ')) {
      current.notes.push(line.slice(2).trim())
    }
  }
  if (current) entries.push(current)
  return entries
}

const FALLBACK_WHATS_NEW: ChangelogEntry[] = [
  { version: '0.5.1', notes: ['All instance cards now uniform with PLAY, MODS, CONSOLE, Edit', 'Java detector scans Minecraft launcher bundled runtimes', 'Forge/NeoForge install and launch support'] },
  { version: '0.4.0', notes: ['Activity log, live panels, full Microsoft OAuth flow'] },
  { version: '0.3.0', notes: ['Avatar/cover image picker, PixelScene previews'] },
  { version: '0.1.0', notes: ['Core IPC, config service, and instance management'] },
]

type ActivityEntry = { id: string; label: string; ts: number }

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60)  return 'Just now'
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h} hr ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7)   return `${d} days ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function greeting() {
  const h = new Date().getHours()
  if (h < 5)  return 'Still up,'
  if (h < 12) return 'Good morning,'
  if (h < 18) return 'Good afternoon,'
  if (h < 22) return 'Good evening,'
  return 'Welcome back,'
}

function useClock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return t
}

function PlayButton({ onClick, disabled = false, label = 'PLAY' }: { onClick?: () => void; disabled?: boolean; label?: string }) {
  const [down, setDown] = useState(false)
  return (
    <button
      onMouseDown={() => { if (!disabled) setDown(true) }}
      onMouseUp={() => { setDown(false); if (!disabled) onClick?.() }}
      onMouseLeave={() => setDown(false)}
      disabled={disabled}
      style={{
        fontFamily: "'VT323',monospace",
        fontSize: 20,
        letterSpacing: '.12em',
        color: disabled ? 'var(--ink-4)' : '#fff',
        padding: '0 28px',
        height: 40,
        background: disabled ? 'var(--surface-3)' : 'var(--accent)',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        userSelect: 'none',
        outline: 'none',
        position: 'relative',
        top: down ? 2 : 0,
        opacity: disabled ? .72 : 1,
        boxShadow: disabled
          ? 'inset 0 -3px 0 rgba(0,0,0,.28), inset 0 3px 0 rgba(255,255,255,.05)'
          : down
          ? 'inset 0 2px 0 var(--accent-lo), inset 0 -2px 0 var(--accent-hi)'
          : 'inset 0 -4px 0 var(--accent-lo), inset 0 4px 0 var(--accent-hi), 0 4px 0 rgba(0,0,0,.5)',
        transition: 'box-shadow 60ms, top 60ms',
      }}
    >
      {label}
    </button>
  )
}

function InstanceCard({ instance, onLaunch, onEdit, onConsole, onMods, canLaunch, isRunning, hasLogs }: { instance: Instance; onLaunch: () => void; onEdit: () => void; onConsole: () => void; onMods: () => void; canLaunch: boolean; isRunning: boolean; hasLogs: boolean }) {
  const label = isRunning ? 'STOP' : instance.isInstalled ? 'PLAY' : 'INSTALL'
  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 0,
      background: 'var(--surface)',
      border: '1px solid var(--border-r)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ height: 160, position: 'relative', overflow: 'hidden' }}>
        {instance.iconPath
          ? <img src={instance.iconPath} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          : <PixelScene name={loaderToScene(instance.modLoader)} style={{ width: '100%', height: '100%' }} />
        }
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
          height: 60,
        }} />
        <div style={{
          position: 'absolute', top: 8, right: 8,
          background: 'rgba(0,0,0,.55)',
          border: '1px solid rgba(255,255,255,.08)',
          borderRadius: 3,
          padding: '2px 7px',
          fontFamily: "'VT323',monospace",
          fontSize: 13,
          color: 'var(--ink-3)',
          letterSpacing: '.06em',
        }}>
          {instance.modLoader?.toUpperCase() ?? 'VANILLA'}
        </div>
      </div>

      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.2 }}>{instance.name}</div>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 14, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
          MC {instance.minecraftVersion}
        </div>
        {!instance.isInstalled && (
          <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.35 }}>
            Minecraft not downloaded yet — click INSTALL to set up.
          </div>
        )}
        {instance.isInstalled && !canLaunch && (
          <div style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.35 }}>
            Sign in or create a profile to play.
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 8, paddingTop: 10 }}>
          <PlayButton onClick={onLaunch} disabled={false} label={label} />
          {(isRunning || hasLogs) && (
            <button
              onClick={onConsole}
              style={{
                fontFamily: "'VT323',monospace",
                fontSize: 14, letterSpacing: '.08em',
                color: isRunning ? 'var(--grass)' : 'var(--ink-3)',
                background: isRunning ? 'rgba(74,196,100,.1)' : 'var(--surface-2)',
                border: `1px solid ${isRunning ? 'rgba(74,196,100,.3)' : 'var(--border-r)'}`,
                borderRadius: 3,
                padding: '0 10px',
                height: 40,
                cursor: 'pointer',
              }}
            >
              {isRunning ? 'CONSOLE' : 'LOG'}
            </button>
          )}
          <button
            onClick={onMods}
            style={{
              fontFamily: "'VT323',monospace", fontSize: 14, letterSpacing: '.06em',
              color: 'var(--ink-2)',
              background: 'var(--surface-2)', border: '1px solid var(--border-r)',
              borderRadius: 3, padding: '0 10px', height: 40, cursor: 'pointer',
            }}
          >
            MODS
          </button>
          <button
            onClick={onEdit}
            style={{
              fontSize: 12, fontWeight: 500,
              color: 'var(--ink-3)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-r)',
              borderRadius: 3,
              padding: '0 14px',
              height: 40,
              cursor: 'pointer',
            }}
          >
            Edit
          </button>
        </div>
      </div>
    </div>
  )
}


function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{
      padding: '60px 40px',
      background: 'var(--surface)',
      border: '1px solid var(--border-r)',
      borderRadius: 'var(--radius)',
      textAlign: 'center',
    }}>
      <div style={{
        width: 48, height: 48, margin: '0 auto 16px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-r)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ width: 20, height: 20, background: 'var(--accent)', opacity: .5 }} />
      </div>
      <p style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', margin: '0 0 6px' }}>No instances yet</p>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '0 0 20px', maxWidth: 320, marginInline: 'auto' }}>
        Create your first Minecraft instance to get started
      </p>
      <button
        onClick={onOpen}
        style={{
          fontFamily: "'VT323',monospace",
          fontSize: 18, letterSpacing: '.1em', color: '#fff',
          padding: '0 24px', height: 38,
          background: 'var(--accent)', border: 'none', cursor: 'pointer',
          boxShadow: 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)',
        }}
      >
        NEW INSTANCE
      </button>
    </div>
  )
}

function ConsoleModal({ instanceName, lines, onClose }: { instanceName: string; lines: string[]; onClose: () => void }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        width: '72vw', maxWidth: 900, height: '70vh',
        background: '#0d0d0d',
        border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          background: '#111',
          flexShrink: 0,
        }}>
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--grass)', letterSpacing: '.1em' }}>
            CONSOLE — {instanceName}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px' }}>
          {lines.length === 0
            ? <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ink-4)' }}>Waiting for output…</span>
            : lines.map((line, i) => (
              <div key={i} style={{
                fontFamily: 'monospace', fontSize: 11, color: line.includes('ERROR') || line.includes('Exception') ? '#ff6b6b' : line.includes('WARN') ? '#ffd93d' : '#b0c4b1',
                lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>{line}</div>
            ))
          }
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}

function Library() {
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Instance | null>(null)
  const [launchToast, setLaunchToast] = useState<string | null>(null)
  const [carouselTab, setCarouselTab] = useState<'recent' | 'pinned' | 'all'>('recent')
  const [carouselPage, setCarouselPage] = useState(0)
  const [activeAccount, setActiveAccount] = useState<ActiveAccount>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [, setTick] = useState(0)
  const [installing, setInstalling] = useState<{ instanceId: string; name: string } | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [mcVersions, setMcVersions] = useState<MinecraftVersion[]>([])
  const [consoleLogs, setConsoleLogs] = useState<Map<string, string[]>>(new Map())
  const [consoleOpen, setConsoleOpen] = useState<string | null>(null)
  const [modsTarget, setModsTarget] = useState<Instance | null>(null)
  const [whatsNew, setWhatsNew] = useState<ChangelogEntry[]>(FALLBACK_WHATS_NEW)
  const [fileImport, setFileImport] = useState<{ importId: string; step: string; percent: number; name: string } | null>(null)

  const queryClient = useQueryClient()
  const { data: instances = [], isLoading } = useInstances()
  const createInstance = useCreateInstance()
  const updateInstance = useUpdateInstance()
  const deleteInstance = useDeleteInstance()

  const clock = useClock()
  const timeStr = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const canLaunchMinecraft = activeAccount != null

  useEffect(() => {
    api.auth.active()
      .then(setActiveAccount)
      .catch(() => setActiveAccount(null))
  }, [])

  useEffect(() => {
    api.activity.list()
      .then(setActivity)
      .catch(() => setActivity([]))
  }, [])

  // Fetch latest changelog from GitHub
  useEffect(() => {
    fetch(CHANGELOG_URL)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        const parsed = parseChangelog(text)
        if (parsed.length) setWhatsNew(parsed)
      })
      .catch(() => { /* keep fallback */ })
  }, [])

  // Re-render relative timestamps every minute
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  async function recordActivity(label: string): Promise<void> {
    try {
      const entry = await api.activity.add(label)
      setActivity(prev => [entry, ...prev].slice(0, 50))
    } catch { /* non-critical */ }
  }

  useEffect(() => {
    const unsubProg = api.modpack.onProgress(({ projectId, step, percent }) => {
      setFileImport(prev => prev?.importId === projectId ? { ...prev, step, percent } : prev)
    })
    const unsubDone = api.modpack.onDone(({ projectId, instanceId, error }) => {
      setFileImport(prev => {
        if (prev?.importId !== projectId) return prev
        return null
      })
      if (instanceId) {
        void queryClient.invalidateQueries({ queryKey: ['instances'] })
        void recordActivity('Imported modpack from file')
      }
      if (error) {
        setLaunchToast(`Import failed: ${error}`)
        setTimeout(() => setLaunchToast(null), 5000)
      }
    })
    return () => { unsubProg(); unsubDone() }
  }, [])

  async function handleImportFile(filePath: string): Promise<void> {
    const importId = `file-import-${Date.now()}`
    const name = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.(mrpack|zip)$/i, '') ?? 'Imported Pack'
    setFileImport({ importId, step: 'Starting…', percent: 0, name })
    try {
      await api.modpack.installFromFile(filePath, name, importId)
    } catch (e) {
      setFileImport(null)
      setLaunchToast(`Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      setTimeout(() => setLaunchToast(null), 5000)
    }
  }

  async function handleInstallMc(instance: Instance) {
    const versionList = mcVersions.length ? mcVersions : await api.mc.versions().catch(() => [])
    if (!mcVersions.length) setMcVersions(versionList)

    const ver = versionList.find(v => v.id === instance.minecraftVersion)
    if (!ver) {
      setLaunchToast(`Minecraft version ${instance.minecraftVersion} not found in manifest.`)
      setTimeout(() => setLaunchToast(null), 3500)
      return
    }
    setInstalling({ instanceId: instance.id, name: instance.name })
    try {
      await api.mc.install(instance.id, ver.id, ver.url, instance.modLoader, instance.modLoaderVersion)
    } catch (e) {
      setLaunchToast(`Install failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      setTimeout(() => setLaunchToast(null), 4000)
      setInstalling(null)
    }
  }

  async function handleLaunch(instance: Instance) {
    if (!canLaunchMinecraft) {
      setLaunchToast('Create a profile first — go to Accounts and add a guest or Microsoft profile.')
      setTimeout(() => setLaunchToast(null), 3600)
      return
    }
    if (!instance.isInstalled) {
      await handleInstallMc(instance)
      return
    }
    if (runningIds.has(instance.id)) {
      api.mc.stop(instance.id)
      setRunningIds(prev => { const n = new Set(prev); n.delete(instance.id); return n })
      return
    }
    try {
      await api.mc.launch(instance.id)
      setRunningIds(prev => new Set([...prev, instance.id]))
      void recordActivity(`Launched "${instance.name}"`)
    } catch (e) {
      setLaunchToast(`Launch failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      setTimeout(() => setLaunchToast(null), 4000)
    }
  }

  // Listen for MC exit events
  useEffect(() => {
    const unsub = api.mc.onExit(({ instanceId, code, error }) => {
      setRunningIds(prev => { const n = new Set(prev); n.delete(instanceId); return n })
      if (error) {
        setLaunchToast(`Minecraft crashed: ${error}`)
        setTimeout(() => setLaunchToast(null), 6000)
      } else if (typeof code === 'number' && code !== 0) {
        setLaunchToast(`Minecraft exited with code ${code}. Check the Console for details.`)
        setTimeout(() => setLaunchToast(null), 6000)
      }
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [])

  // Accumulate MC log lines per instance
  useEffect(() => {
    const unsub = api.mc.onLog(({ instanceId, line }) => {
      const lines = line.split(/\r?\n/).filter(l => l.length > 0)
      setConsoleLogs(prev => {
        const next = new Map(prev)
        const existing = next.get(instanceId) ?? []
        next.set(instanceId, [...existing, ...lines].slice(-2000))
        return next
      })
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [])

  const tabInstances = (() => {
    if (carouselTab === 'pinned') return instances.filter(i => i.pinned)
    if (carouselTab === 'recent') return [...instances].sort((a, b) => {
      const at = a.lastPlayed ?? a.createdAt
      const bt = b.lastPlayed ?? b.createdAt
      return bt.localeCompare(at)
    })
    return instances
  })()
  const visibleInstances = tabInstances.slice(carouselPage * 3, carouselPage * 3 + 3)
  const totalPages = Math.max(1, Math.ceil(tabInstances.length / 3))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Greeting + clock */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 2 }}>{greeting()}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', lineHeight: 1 }}>
            <span style={{ color: 'var(--accent)' }}>{activeAccount?.username ?? 'Guest'}</span>
          </div>
          <div style={{ fontSize: 11, color: canLaunchMinecraft ? 'var(--grass)' : 'var(--gold)', marginTop: 5 }}>
            {canLaunchMinecraft ? 'Minecraft play enabled' : 'Content access enabled'}
          </div>
        </div>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 22, color: 'var(--ink-4)', letterSpacing: '.08em', lineHeight: 1 }}>
          {timeStr}
        </div>
      </div>

      {/* Instance carousel */}
      <div>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Your Instances</span>
            {(['recent', 'pinned', 'all'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => { setCarouselTab(tab); setCarouselPage(0) }}
                style={{
                  marginLeft: 6,
                  fontSize: 11, fontWeight: 500,
                  color: carouselTab === tab ? 'var(--ink)' : 'var(--ink-4)',
                  background: carouselTab === tab ? 'var(--accent-tint)' : 'transparent',
                  border: `1px solid ${carouselTab === tab ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 3,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {instances.length > 0 && (
            <div style={{ display: 'flex', gap: 4 }}>
              <NavBtn disabled={carouselPage === 0} onClick={() => setCarouselPage(p => Math.max(0, p - 1))}>
                <ChevLeftIcon />
              </NavBtn>
              <NavBtn disabled={carouselPage >= totalPages - 1} onClick={() => setCarouselPage(p => Math.min(totalPages - 1, p + 1))}>
                <ChevRightIcon />
              </NavBtn>
              <button
                onClick={() => setCreateOpen(true)}
                style={{
                  marginLeft: 4,
                  fontSize: 11, fontWeight: 600,
                  color: 'var(--ink-2)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-r)',
                  borderRadius: 3,
                  padding: '3px 10px',
                  cursor: 'pointer',
                }}
              >
                + New
              </button>
            </div>
          )}
        </div>

        {/* Cards */}
        {isLoading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
            Loading…
          </div>
        ) : instances.length === 0 ? (
          <EmptyState onOpen={() => setCreateOpen(true)} />
        ) : tabInstances.length === 0 ? (
          <div style={{
            height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)',
          }}>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: 'var(--ink-4)', letterSpacing: '.08em' }}>
              {carouselTab === 'pinned' ? 'NO PINNED INSTANCES' : 'NOTHING HERE'}
            </div>
            {carouselTab === 'pinned' && (
              <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>Open Edit on any instance and enable the pin toggle.</div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
            {visibleInstances.map(inst => (
              <InstanceCard
                key={inst.id}
                instance={inst}
                onLaunch={() => handleLaunch(inst)}
                onEdit={() => setEditTarget(inst)}
                onConsole={() => setConsoleOpen(inst.id)}
                onMods={() => setModsTarget(inst)}
                canLaunch={canLaunchMinecraft}
                isRunning={runningIds.has(inst.id)}
                hasLogs={(consoleLogs.get(inst.id)?.length ?? 0) > 0}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom panels */}
      {instances.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* What's New */}
          <Panel title="What's New">
            {whatsNew.slice(0, 4).map(item => (
              <div key={item.version} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--accent)', letterSpacing: '.06em' }}>v{item.version}</span>
                <ul style={{ margin: '3px 0 0', paddingLeft: 14, listStyle: 'disc' }}>
                  {item.notes.slice(0, 3).map((n, i) => (
                    <li key={i} style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.5 }}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
          </Panel>

          {/* Activity */}
          <Panel title="Activity">
            {activity.length === 0 ? (
              <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>
                No recent activity
              </div>
            ) : activity.slice(0, 6).map(item => (
              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontSize: 12, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{item.label}</span>
                <span style={{ fontSize: 11, color: 'var(--ink-4)', flexShrink: 0 }}>{timeAgo(item.ts)}</span>
              </div>
            ))}
          </Panel>
        </div>
      )}

      {/* Launch toast */}
      {launchToast && (
        <div style={{
          position: 'fixed', bottom: 44, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          fontSize: 13, color: 'var(--ink)',
          zIndex: 50,
        }}>
          <div style={{ width: 8, height: 8, background: 'var(--accent)', flexShrink: 0 }} />
          {launchToast}
        </div>
      )}

      <CreateInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          const inst = await createInstance.mutateAsync(input)
          void recordActivity(`Created instance "${inst.name}"`)
        }}
        onImportFile={handleImportFile}
      />

      <EditInstanceDialog
        instance={editTarget}
        open={editTarget !== null}
        onOpenChange={(v) => { if (!v) setEditTarget(null) }}
        onSave={async (id, patch) => {
          const inst = await updateInstance.mutateAsync({ id, patch })
          void recordActivity(`Edited "${inst.name}"`)
        }}
        onDelete={async (id) => {
          const inst = instances.find(i => i.id === id)
          await deleteInstance.mutateAsync({ id, deleteFiles: false })
          setEditTarget(null)
          if (inst) void recordActivity(`Deleted "${inst.name}"`)
        }}
        onRepair={(id) => {
          const inst = instances.find(i => i.id === id)
          if (!inst) return
          setEditTarget(null)
          setInstalling({ instanceId: id, name: inst.name })
          api.mc.repair(id).catch((e: unknown) => {
            setInstalling(null)
            setLaunchToast(`Repair failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
            setTimeout(() => setLaunchToast(null), 4000)
          })
        }}
      />

      {installing && (
        <InstallProgress
          instanceId={installing.instanceId}
          instanceName={installing.name}
          onDone={() => {
            setInstalling(null)
            void recordActivity(`Installed MC for "${installing.name}"`)
          }}
          onError={(err) => {
            setInstalling(null)
            setLaunchToast(`Install failed: ${err}`)
            setTimeout(() => setLaunchToast(null), 4000)
          }}
        />
      )}

      {fileImport && (
        <div style={{ position:'fixed', inset:0, zIndex:100, background:'rgba(0,0,0,.7)', display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'var(--surface)', border:'1px solid var(--border-r)', borderRadius:'var(--radius)', padding:'28px 32px', width:360, display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ fontFamily:"'VT323',monospace", fontSize:20, color:'var(--accent)', letterSpacing:'.1em' }}>IMPORTING MODPACK</div>
            <div style={{ fontSize:13, color:'var(--ink-2)', fontWeight:600 }}>{fileImport.name}</div>
            <div>
              <div style={{ fontSize:12, color:'var(--ink-3)', marginBottom:8 }}>{fileImport.step}</div>
              <div style={{ height:8, background:'var(--surface-2)', border:'1px solid var(--border-r)' }}>
                <div style={{ height:'100%', width:`${fileImport.percent}%`, background:'var(--accent)', transition:'width 200ms linear', boxShadow:'inset 0 -2px 0 var(--accent-lo), inset 0 2px 0 var(--accent-hi)' }} />
              </div>
              <div style={{ fontFamily:"'VT323',monospace", fontSize:13, color:'var(--ink-4)', marginTop:4, textAlign:'right' }}>{Math.round(fileImport.percent)}%</div>
            </div>
            <div style={{ fontSize:11, color:'var(--ink-4)', textAlign:'center', lineHeight:1.4 }}>Downloading and installing modpack files…</div>
          </div>
        </div>
      )}

      <InstanceModsDialog
        instance={modsTarget}
        open={modsTarget !== null}
        onOpenChange={(v) => { if (!v) setModsTarget(null) }}
      />

      {consoleOpen && (() => {
        const inst = instances.find(i => i.id === consoleOpen)
        return (
          <ConsoleModal
            instanceName={inst?.name ?? consoleOpen}
            lines={consoleLogs.get(consoleOpen) ?? []}
            onClose={() => setConsoleOpen(null)}
          />
        )
      })()}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border-r)',
      borderRadius: 'var(--radius)',
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function NavBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 24, height: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface)',
        border: '1px solid var(--border-r)',
        borderRadius: 3,
        color: disabled ? 'var(--ink-4)' : 'var(--ink-2)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}
