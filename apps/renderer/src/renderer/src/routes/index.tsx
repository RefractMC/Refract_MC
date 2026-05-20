import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import type { Instance, MinecraftVersion } from '@refract/core'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
import { ChevLeftIcon, ChevRightIcon } from '@/components/ui/BlockIcons'
import { CreateInstanceDialog } from '@/components/instances/CreateInstanceDialog'
import { EditInstanceDialog } from '@/components/instances/EditInstanceDialog'
import { InstallProgress } from '@/components/minecraft/InstallProgress'
import { useInstances, useCreateInstance, useUpdateInstance } from '@/hooks/use-instances'
import { api } from '@/lib/api'

export const Route = createFileRoute('/')({
  component: Library,
})

type ActiveAccount = Awaited<ReturnType<typeof api.auth.active>>

const WHATS_NEW = [
  { version: '0.4.0', note: 'Activity log, live panels, full Microsoft OAuth flow' },
  { version: '0.3.1', note: 'Minecraft pixel-style instance dialogs, PixelScene previews' },
  { version: '0.3.0', note: 'Theme engine with Minecraft palette and Zustand store' },
  { version: '0.2.0', note: 'App shell, sidebar, TitleBar, offline and Yggdrasil accounts' },
  { version: '0.1.0', note: 'Core IPC, config service, and instance management' },
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

function HeroCard({ instance, onLaunch, onEdit, canLaunch, isRunning }: { instance: Instance; onLaunch: () => void; onEdit: () => void; canLaunch: boolean; isRunning: boolean }) {
  const label = isRunning ? 'STOP' : instance.isInstalled ? 'PLAY' : 'INSTALL'
  return (
    <div style={{
      flex: '0 0 340px',
      background: 'var(--surface)',
      border: '1px solid var(--border-r)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ height: 160, position: 'relative', overflow: 'hidden' }}>
        <PixelScene name={loaderToScene(instance.modLoader)} style={{ width: '100%', height: '100%' }} />
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
            Microsoft account required to play online.
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 8, paddingTop: 10 }}>
          <PlayButton onClick={onLaunch} disabled={false} label={label} />
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

function PreviewCard({ instance, onLaunch, onEdit, canLaunch, isRunning }: { instance: Instance; onLaunch: () => void; onEdit: () => void; canLaunch: boolean; isRunning: boolean }) {
  const label = isRunning ? 'STOP' : instance.isInstalled ? 'PLAY' : 'INSTALL'
  return (
    <div style={{
      flex: '0 0 180px',
      background: 'var(--surface)',
      border: '1px solid var(--border-r)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      cursor: 'pointer',
      opacity: 0.85,
    }}
    onClick={onEdit}
    >
      <div style={{ height: 90, position: 'relative', overflow: 'hidden' }}>
        <PixelScene name={loaderToScene(instance.modLoader)} style={{ width: '100%', height: '100%' }} />
      </div>
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{instance.name}</div>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 12, color: 'var(--ink-4)', letterSpacing: '.04em', marginTop: 2 }}>MC {instance.minecraftVersion}</div>
        <button
          onClick={(e) => { e.stopPropagation(); onLaunch() }}
          style={{
            marginTop: 8, width: '100%',
            fontFamily: "'VT323',monospace", fontSize: 15, letterSpacing: '.1em',
            color: '#fff', height: 28,
            background: isRunning ? 'var(--lava)' : 'var(--accent)',
            border: 'none', cursor: 'pointer',
            boxShadow: isRunning
              ? 'inset 0 -3px 0 rgba(0,0,0,.3)'
              : 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)',
          }}
        >
          {label}
        </button>
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

  const { data: instances = [], isLoading } = useInstances()
  const createInstance = useCreateInstance()
  const updateInstance = useUpdateInstance()

  const clock = useClock()
  const timeStr = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const canLaunchMinecraft = activeAccount?.canPlayMinecraft === true

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
      const message = activeAccount
        ? `${activeAccount.username} — sign in with a licensed Microsoft account to play Minecraft.`
        : 'Sign in with a licensed Microsoft account to play Minecraft.'
      setLaunchToast(message)
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
    const unsub = api.mc.onExit(({ instanceId }) => {
      setRunningIds(prev => { const n = new Set(prev); n.delete(instanceId); return n })
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [])

  const visibleInstances = instances.slice(carouselPage * 3, carouselPage * 3 + 3)
  const heroInstance = visibleInstances[0] ?? null
  const previewInstances = visibleInstances.slice(1, 3)
  const totalPages = Math.max(1, Math.ceil(instances.length / 3))

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
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {heroInstance && (
              <HeroCard
                instance={heroInstance}
                onLaunch={() => handleLaunch(heroInstance)}
                onEdit={() => setEditTarget(heroInstance)}
                canLaunch={canLaunchMinecraft}
                isRunning={runningIds.has(heroInstance.id)}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {previewInstances.map(inst => (
                <PreviewCard
                  key={inst.id}
                  instance={inst}
                  onLaunch={() => handleLaunch(inst)}
                  onEdit={() => setEditTarget(inst)}
                  canLaunch={canLaunchMinecraft}
                  isRunning={runningIds.has(inst.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom panels */}
      {instances.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* What's New */}
          <Panel title="What's New">
            {WHATS_NEW.map(item => (
              <div key={item.version} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--accent)', letterSpacing: '.06em', flexShrink: 0 }}>v{item.version}</span>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{item.note}</span>
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
      />

      <EditInstanceDialog
        instance={editTarget}
        open={editTarget !== null}
        onOpenChange={(v) => { if (!v) setEditTarget(null) }}
        onSave={async (id, patch) => {
          const inst = await updateInstance.mutateAsync({ id, patch })
          void recordActivity(`Edited "${inst.name}"`)
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
