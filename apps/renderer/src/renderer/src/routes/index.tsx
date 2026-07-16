import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type React from 'react'
import type { Instance, JavaInstallation, MinecraftVersion } from '@refract/core'
import { localDateKey } from '@refract/core'
import { useT, type T } from '@/i18n'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
import { ChevLeftIcon, ChevRightIcon } from '@/components/ui/BlockIcons'
import { CreateInstanceDialog } from '@/components/instances/CreateInstanceDialog'
import { EditInstanceDialog } from '@/components/instances/EditInstanceDialog'
import { InstanceModsDialog } from '@/components/instances/InstanceModsDialog'
import { ServersDialog } from '@/components/instances/ServersDialog'
import { InstallProgress } from '@/components/minecraft/InstallProgress'
import { Button } from '@/components/ui/Button'
import { CornerCat } from '@/components/ui/CornerCat'
import { useInstances, useCreateInstance, useUpdateInstance, useDeleteInstance } from '@/hooks/use-instances'
import { analyticsAvailable, api, type AppConfig, type QuickPlayTarget } from '@/lib/api'
import { logger } from '@/lib/logger'
import { getFilePath } from '@/lib/file-path'
import { registerNativeDropTarget } from '@/lib/native-drop'

export const Route = createFileRoute('/')({
  component: Library,
})

type ExternalInstance = import('../env').ExternalInstance

type FileImportState = {
  importId: string
  step: string
  percent: number
  name: string
  filePath: string
  status: 'importing' | 'done' | 'error'
  instanceId?: string
  error?: string
}

type CrashReportData = {
  text: string
  filename: string
  path: string
  modifiedAt: number
}

type LauncherLogEntry = {
  time: string
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  stack?: string
}

function formatLauncherLog(entry: LauncherLogEntry) {
  const stack = entry.stack ? `\n${entry.stack}` : ''
  return `[${entry.time || 'unknown'}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}${stack}`
}

function buildCrashDiagnosticBundle({
  instanceId,
  instance,
  code,
  error,
  report,
  lastLines,
  launcherLogs,
  javas,
}: {
  instanceId: string
  instance?: Instance
  code: number | null
  error?: string
  report: CrashReportData | null
  lastLines: string[]
  launcherLogs: LauncherLogEntry[]
  javas: JavaInstallation[]
}) {
  const configuredJava = instance?.javaPath?.trim() || 'Auto-select'
  const javaCandidates = javas.length
    ? javas.map(java => `- Java ${java.version} (${java.vendor}): ${java.path}`).join('\n')
    : 'No Java installations were detected by the launcher scan.'
  const loader = instance?.modLoader
    ? `${instance.modLoader}${instance.modLoaderVersion ? ` ${instance.modLoaderVersion}` : ''}`
    : 'vanilla'
  const modpack = instance?.modpackSource
    ? `${instance.modpackSource} project=${instance.modpackProjectId ?? 'unknown'} version=${instance.modpackVersionId ?? 'unknown'}`
    : 'none'
  const orderedLogs = [...launcherLogs].reverse()

  return [
    'Refract crash diagnostic bundle',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Launch result',
    `Instance ID: ${instanceId}`,
    `Instance name: ${instance?.name ?? 'unknown'}`,
    `Exit code: ${code ?? 'unknown'}`,
    `Error: ${error ?? 'none'}`,
    `Crash report file: ${report?.filename ?? 'none'}`,
    `Crash report path: ${report?.path ?? 'none'}`,
    '',
    'Minecraft / loader',
    `Minecraft version: ${instance?.minecraftVersion ?? 'unknown'}`,
    `Mod loader: ${loader}`,
    `Modpack: ${modpack}`,
    '',
    'Java',
    `Configured Java: ${configuredJava}`,
    'Detected Java installations:',
    javaCandidates,
    '',
    'Instance config',
    JSON.stringify(instance ?? { id: instanceId }, null, 2),
    '',
    'Last game output',
    lastLines.length > 0 ? lastLines.join('\n') : 'No recent game output was captured.',
    '',
    'Last launcher log lines',
    orderedLogs.length > 0 ? orderedLogs.map(formatLauncherLog).join('\n') : 'No launcher log lines were captured.',
    '',
    'Crash report',
    report?.text ?? 'No crash report file was found.',
  ].join('\n')
}

type ActiveAccount = Awaited<ReturnType<typeof api.auth.active>>

const CHANGELOG_URL = 'https://raw.githubusercontent.com/RefractMC/Refract_MC/main/CHANGELOG.md'
const activeLaunchIds = new Set<string>()
const consoleLogCache = new Map<string, string[]>()

interface ChangelogEntry { version: string; notes: string[]; date?: string }

function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: { version: string; notes: string[] } | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      if (current && current.notes.length > 0) entries.push(current)
      current = { version: line.slice(3).trim(), notes: [] }
    } else if (current && (line.startsWith('- ') || line.startsWith('* '))) {
      current.notes.push(line.slice(2).trim().replace(/\*\*/g, ''))
    }
  }
  if (current && current.notes.length > 0) entries.push(current)
  return entries
}

const FALLBACK_WHATS_NEW: ChangelogEntry[] = [
  { version: '1.0.4', notes: ['Custom accent color', 'Bulk mod operations', 'JVM performance presets', 'World backup', 'Screenshot lightbox', 'CurseForge modpacks', 'Sort in Browse Mods', 'Page jump in pagination', 'Custom instance location', 'Custom Java path'] },
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

function greeting(t: T) {
  const h = new Date().getHours()
  if (h < 5)  return t.home.stillUp
  if (h < 12) return t.home.morning
  if (h < 18) return t.home.afternoon
  if (h < 22) return t.home.evening
  return t.home.welcomeBack
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
  return (
    <Button
      variant="primary"
      disabled={disabled}
      onClick={onClick}
      style={{ flex: 1, height: 40, fontSize: 14, letterSpacing: '.03em' }}
    >
      {label}
    </Button>
  )
}

function formatPlaytime(seconds: number): string {
  if (seconds < 60) return '< 1 min'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function requiredJava(mcVersion: string): number {
  const nums = [...mcVersion.matchAll(/\d+/g)].map(match => Number(match[0]))
  const major = nums[0] ?? 1
  const minor = nums[1] ?? 0
  const patch = nums[2] ?? 0
  if (major >= 26) return 25
  if (major === 1 && (minor >= 21 || (minor === 20 && patch >= 5))) return 21
  if (major === 1 && minor >= 17) return 17
  return 8
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'info' }) {
  const toneVars = {
    neutral: { color: 'var(--ink-3)', background: 'var(--surface-2)' },
    good: { color: 'var(--grass)', background: 'color-mix(in srgb, var(--grass) 12%, transparent)' },
    warn: { color: 'var(--gold)', background: 'color-mix(in srgb, var(--gold) 12%, transparent)' },
    info: { color: 'var(--diamond)', background: 'color-mix(in srgb, var(--diamond) 12%, transparent)' },
  }[tone]

  return (
    <span style={{
      height: 20,
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 7px',
      borderRadius: 'var(--radius-sm)',
      background: toneVars.background,
      color: toneVars.color,
      fontSize: 10,
      fontWeight: 700,
      lineHeight: 1,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function InstanceCard({ instance, onLaunch, onEdit, onConsole, onMods, onOpenFolder, onServers, onDropJar, blockReason, isRunning, isLaunching, hasLogs, updateCount, javaOk, selectionMode, selected, onSelect, updateAvailable, onUpdate }: { instance: Instance; onLaunch: () => void; onEdit: () => void; onConsole: () => void; onMods: () => void; onOpenFolder: () => void; onServers: () => void; onDropJar: (path: string) => void; blockReason: 'no-profile' | 'no-license' | null; isRunning: boolean; isLaunching?: boolean; hasLogs: boolean; updateCount: number; javaOk: boolean; selectionMode?: boolean; selected?: boolean; onSelect?: () => void; updateAvailable?: boolean; onUpdate?: () => void }) {
  const t = useT()
  const [dragOver, setDragOver] = useState(false)
  const [bannerHover, setBannerHover] = useState(false)
  const label = isLaunching ? t.home.launching : isRunning ? t.home.stop : instance.isInstalled ? t.home.play : t.home.install
  const statusChips: Array<{ label: string; tone?: 'neutral' | 'good' | 'warn' | 'info' }> = []
  if (isLaunching) statusChips.push({ label: t.home.launching, tone: 'info' })
  else if (isRunning) statusChips.push({ label: t.home.running, tone: 'good' })
  if (instance.isInstalled && updateAvailable) statusChips.push({ label: t.home.update, tone: 'good' })
  if (instance.isInstalled && updateCount > 0) statusChips.push({ label: t.home.modCount(updateCount), tone: 'warn' })
  if (instance.isInstalled && !javaOk) statusChips.push({ label: t.home.missingJava, tone: 'warn' })
  if (instance.isInstalled && blockReason === 'no-profile') statusChips.push({ label: t.home.statusNoAccount, tone: 'warn' })
  if (instance.isInstalled && blockReason === 'no-license') statusChips.push({ label: t.home.licenseRequired, tone: 'warn' })
  if (statusChips.length === 0) {
    statusChips.push(instance.isInstalled ? { label: t.home.statusInstalled, tone: 'info' } : { label: t.home.statusNeedsInstall, tone: 'neutral' })
  }
  useEffect(() => registerNativeDropTarget(
    instance.id,
    paths => paths.filter(p => /\.(jar|zip)$/i.test(p)).forEach(onDropJar),
    setDragOver,
  ), [instance.id, onDropJar])
  return (
    <div
      data-instance-drop-id={instance.id}
      onDragOver={e => { e.preventDefault(); if ([...e.dataTransfer.items].some(i => i.kind === 'file')) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        for (const file of [...e.dataTransfer.files]) {
          const path = getFilePath(file)
          if (path && /\.(jar|zip)$/i.test(path)) onDropJar(path)
        }
      }}
      className="instance-card"
      style={{
        width: 300,
        flexShrink: 0,
        outline: dragOver ? '2px solid var(--accent)' : selected ? '2px solid var(--accent)' : 'none',
        background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012)), var(--surface)',
        border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
      <div
        onClick={selectionMode ? onSelect : onMods}
        onMouseEnter={() => setBannerHover(true)}
        onMouseLeave={() => setBannerHover(false)}
        style={{ height: 164, position: 'relative', overflow: 'hidden', cursor: 'pointer' }}
      >
        {instance.iconPath
          ? <img src={instance.iconPath} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          : <PixelScene name={loaderToScene(instance.modLoader)} style={{ width: '100%', height: '100%' }} />
        }
        {selectionMode && (
          <div
            onClick={e => { e.stopPropagation(); onSelect?.() }}
            style={{
              position: 'absolute', top: 8, left: 8, zIndex: 5,
              width: 18, height: 18,
              background: selected ? 'var(--accent)' : 'rgba(0,0,0,.55)',
              border: `2px solid ${selected ? 'var(--accent)' : 'rgba(255,255,255,.5)'}`,
              borderRadius: 3,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            {selected && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
          </div>
        )}
        {!selectionMode && bannerHover && !dragOver && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', letterSpacing: '.08em', background: 'rgba(0,0,0,.5)', padding: '5px 14px', borderRadius: 'var(--radius-sm)' }}>{t.home.viewDetails}</div>
          </div>
        )}
        {dragOver && (
          <div style={{ position:'absolute', inset:0, background:'rgba(79,184,232,.25)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#fff', letterSpacing:'.04em', background:'rgba(0,0,0,.6)', padding:'6px 16px', borderRadius:'var(--radius-sm)' }}>{t.home.dropMod}</div>
          </div>
        )}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,.76))',
          height: 72,
        }} />
        {!javaOk && instance.isInstalled && (
          <div style={{
            position: 'absolute', top: 8, left: selectionMode ? 34 : 8,
            background: 'rgba(196,148,50,.9)',
            borderRadius: 'var(--radius-sm)', padding: '2px 7px',
            fontSize: 11, fontWeight: 600,
            color: '#000', letterSpacing: '.02em',
          }}>
            {t.home.javaWarning(requiredJava(instance.minecraftVersion))}
          </div>
        )}
        <div style={{
          position: 'absolute', top: 8, right: 8,
          background: 'rgba(0,0,0,.55)',
          border: '1px solid rgba(255,255,255,.08)',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 7px',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--ink-2)',
          letterSpacing: '.06em',
        }}>
          {instance.modLoader?.toUpperCase() ?? 'VANILLA'}
        </div>
      </div>

      <div style={{ padding: '13px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.2 }}>{instance.name}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'var(--ink-4)', letterSpacing: '.02em' }}>
            MC {instance.minecraftVersion}
          </div>
          {instance.totalTimePlayed > 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-4)', display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ opacity: 0.5 }}>⏱</span>
              {formatPlaytime(instance.totalTimePlayed)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minHeight: 20 }}>
          {statusChips.map(chip => (
            <StatusChip key={chip.label} label={chip.label} tone={chip.tone} />
          ))}
        </div>
        {!instance.isInstalled && (
          <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.35 }}>
            {t.home.notInstalled}
          </div>
        )}
        {instance.isInstalled && blockReason === 'no-profile' && (
          <div style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.35 }}>
            {t.home.noProfile}
          </div>
        )}
        {instance.isInstalled && blockReason === 'no-license' && (
          <div style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.35 }}>
            {t.home.licenseNeeded}
          </div>
        )}
        {instance.isInstalled && updateAvailable && (
          <button
            onClick={onUpdate}
            title={t.home.modpackUpdateTitle}
            style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 2, padding: '3px 9px', fontSize: 11, fontWeight: 600, color: 'var(--grass)', background: 'color-mix(in srgb, var(--grass) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--grass) 45%, transparent)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
          >
            ↑ {t.home.modpackUpdate}
          </button>
        )}
        <div style={{ marginTop: 'auto', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Primary row: PLAY + CONSOLE */}
          <div style={{ display: 'flex', gap: 6 }}>
            <PlayButton onClick={onLaunch} disabled={isLaunching} label={label} />
            {(isRunning || isLaunching || hasLogs) && (
              <Button
                variant="outline"
                onClick={onConsole}
                style={{
                  height: 40,
                  ...(isRunning || isLaunching ? { color: 'var(--grass)', borderColor: 'color-mix(in srgb, var(--grass) 40%, transparent)' } : {}),
                }}
              >
                {isRunning || isLaunching ? t.home.console : t.home.log}
              </Button>
            )}
          </div>
          {/* Secondary row: Mods · Servers · Edit · Folder */}
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={onMods}
              style={{ flex: 1, height: 32, position: 'relative', borderColor: updateCount > 0 ? 'var(--gold)' : undefined }}
            >
              {t.home.mods}
              {updateCount > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -5,
                  background: 'var(--gold)', color: '#000',
                  fontSize: 9, fontWeight: 700,
                  borderRadius: 8, padding: '1px 4px', lineHeight: 1.4,
                }}>
                  {updateCount}
                </span>
              )}
            </Button>
            <Button variant="secondary" size="sm" onClick={onServers} style={{ flex: 1, height: 32 }}>
              {t.home.srv}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit} style={{ flex: 1, height: 32 }}>
              {t.home.edit}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={onOpenFolder}
              title={t.home.openFolderTip}
              style={{ width: 32, height: 32, flexShrink: 0, fontSize: 14 }}
            >
              📁
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}


function EmptyState({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  return (
    <div className="launcher-panel" style={{
      padding: '60px 40px',
      textAlign: 'center',
    }}>
      <div style={{ width: 72, height: 72, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="#b48aff" aria-hidden="true">
          <g stroke="#b48aff" strokeWidth="1.2" strokeLinejoin="miter">
            <polygon points="3,14 12,10 21,14 12,18" fill="#b48aff" fillOpacity="0.35" />
            <polygon points="3,10 12,6 21,10 12,14" fill="#b48aff" fillOpacity="0.55" />
            <polygon points="3,6 12,2 21,6 12,10" fill="#b48aff" fillOpacity="0.85" />
          </g>
          <g stroke="#b48aff" strokeLinecap="round" strokeWidth="1" opacity="0.7">
            <line x1="6" y1="20" x2="9" y2="20" />
            <line x1="10.5" y1="20" x2="13.5" y2="20" />
            <line x1="15" y1="20" x2="18" y2="20" />
            <line x1="8" y1="22" x2="16" y2="22" opacity="0.5" />
          </g>
        </svg>
      </div>
      <p style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', margin: '0 0 6px' }}>{t.home.emptyTitle}</p>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '0 0 20px', maxWidth: 320, marginInline: 'auto' }}>
        {t.home.emptyDesc}
      </p>
      <Button variant="primary" size="lg" onClick={onOpen} style={{ margin: '0 auto' }}>
        {t.home.emptyBtn}
      </Button>
    </div>
  )
}

/// Uploads a log to mclo.gs, copies the share link and opens it. A second click
/// after a successful upload just re-opens the link.
function UploadLogButton({ instanceId, source, style }: { instanceId: string; source: 'latest' | 'crash'; style?: React.CSSProperties }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [url, setUrl] = useState<string | null>(null)
  async function upload() {
    if (state === 'uploading') return
    if (url) { void api.external.open(url); return }
    setState('uploading')
    try {
      const link = await api.mc.uploadLog(instanceId, source)
      setUrl(link)
      navigator.clipboard?.writeText(link).catch(() => {})
      setState('done')
      void api.external.open(link)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 3000)
    }
  }
  const label = state === 'uploading' ? t.home.uploading
    : state === 'done' ? t.home.linkCopied
    : state === 'error' ? t.home.uploadFailed
    : t.home.uploadLog
  return (
    <button
      onClick={upload}
      disabled={state === 'uploading'}
      title={t.home.uploadLogTip}
      style={{
        height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700,
        background: state === 'done' ? 'var(--grass)' : 'var(--surface-2)',
        color: state === 'done' ? '#fff' : state === 'error' ? 'var(--lava, #d93b3b)' : 'var(--ink)',
        border: '1px solid var(--border-r)', borderRadius: 3,
        cursor: state === 'uploading' ? 'default' : 'pointer', transition: 'background .15s',
        ...style,
      }}
    >
      {label}
    </button>
  )
}

function CrashReportModal({
  instanceId,
  instanceName,
  text,
  diagnosticText,
  lastLines,
  code,
  error,
  reportFileName,
  onClose,
  onOpenConsole,
  onOpenFolder,
}: {
  instanceId: string
  instanceName: string
  text: string
  diagnosticText: string
  lastLines: string[]
  code: number | null
  error?: string
  reportFileName?: string
  onClose: () => void
  onOpenConsole: () => void
  onOpenFolder: () => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [diagnosticCopied, setDiagnosticCopied] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function copyNow() {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function copyDiagnosticsNow() {
    navigator.clipboard?.writeText(diagnosticText).catch(() => {})
    setDiagnosticCopied(true)
    setTimeout(() => setDiagnosticCopied(false), 2000)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: '72vw', maxWidth: 860, height: '75vh', background: '#0d0d0d', border: '1px solid rgba(217,59,59,.6)', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(217,59,59,.3)', background: 'rgba(217,59,59,.08)', flexShrink: 0 }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#ff6b6b', letterSpacing: '.02em' }}>{t.home.crashTitle}</span>
            <span style={{ fontSize: 12, color: 'var(--ink-4)', marginLeft: 12 }}>{instanceName}</span>
            {copied && <span style={{ fontSize: 11, color: 'var(--grass)', marginLeft: 10 }}>{t.home.copiedClipboard}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={copyNow} style={{ height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700, background: copied ? 'var(--grass)' : 'var(--surface-2)', color: copied ? '#fff' : 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer', transition: 'background .15s' }}>
              {copied ? t.home.copied : t.home.copyReport}
            </button>
            <button onClick={copyDiagnosticsNow} style={{ height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700, background: diagnosticCopied ? 'var(--grass)' : 'var(--surface-2)', color: diagnosticCopied ? '#fff' : 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer', transition: 'background .15s' }}>
              {diagnosticCopied ? t.home.copied : t.home.copyDiagnostics}
            </button>
            <UploadLogButton instanceId={instanceId} source={reportFileName ? 'crash' : 'latest'} />
            <button onClick={onOpenConsole} style={{ height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700, background: 'var(--surface-2)', color: 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer' }}>{t.home.openLogs}</button>
            <button onClick={onOpenFolder} style={{ height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700, background: 'var(--surface-2)', color: 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer' }}>{t.home.openFolder}</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, fontSize: 11, color: 'var(--ink-3)' }}>
            <span>{t.home.exitCode(code ?? t.home.unknownError)}</span>
            {error && <span>{t.home.errorLine(error)}</span>}
            {reportFileName && <span>{t.home.reportLine(reportFileName)}</span>}
          </div>
          {lastLines.length > 0 && (
            <>
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.08em', marginBottom: 4 }}>{t.home.lastGameOutput}</div>
              <pre style={{ fontFamily: 'monospace', fontSize: 10, color: '#a0a0a0', margin: '0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.4, background: '#111', padding: '8px 10px', borderRadius: 3, maxHeight: 120, overflowY: 'auto' }}>{lastLines.join('\n')}</pre>
              <div style={{ margin: '10px 0', borderTop: '1px solid rgba(255,255,255,.08)' }} />
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.08em', marginBottom: 4 }}>{t.home.crashReportHead}</div>
            </>
          )}
          <pre style={{ fontFamily: 'monospace', fontSize: 11, color: '#e8e8e8', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}>{text}</pre>
        </div>
      </div>
    </div>
  )
}

function OnboardingModal({ step, onNext, onClose, onAddAccount, onNewInstance }: { step: number; onNext: () => void; onClose: () => void; onAddAccount: () => void; onNewInstance: () => void }) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  const steps = [
    {
      title: t.home.onboarding0Title,
      body: t.home.onboarding0Body,
      footer: (
        <button onClick={onNext} style={primaryBtnStyle}>{t.home.onboarding0Action}</button>
      ),
    },
    {
      title: t.home.onboarding1Title,
      body: t.home.onboarding1Body,
      footer: (
        <div style={{ display: 'flex', gap: 10 }}>
          <Link to="/account" onClick={onAddAccount} style={{ ...primaryBtnStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>{t.home.onboarding1Action}</Link>
          <button onClick={onNext} style={secondaryBtnStyle}>{t.home.onboarding1Skip}</button>
        </div>
      ),
    },
    {
      title: t.home.onboarding2Title,
      body: t.home.onboarding2Body,
      footer: (
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onNewInstance} style={primaryBtnStyle}>{t.home.onboarding2Action}</button>
          <button onClick={onClose} style={secondaryBtnStyle}>{t.home.onboarding2Done}</button>
        </div>
      ),
    },
    {
      title: t.home.onboarding3Title,
      body: t.home.onboarding3Body,
      footer: (
        <button onClick={onClose} style={primaryBtnStyle}>{t.home.onboarding3Action}</button>
      ),
    },
  ]
  const current = steps[step]
  if (!current) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 205, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 460, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {steps.map((_, i) => (
              <div key={i} style={{ width: 24, height: 4, borderRadius: 2, background: i <= step ? 'var(--accent)' : 'var(--surface-3)' }} />
            ))}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '28px 24px' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.01em', marginBottom: 14 }}>{current.title}</div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '0 0 24px' }}>{current.body}</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{current.footer}</div>
        </div>
      </div>
    </div>
  )
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 36, padding: '0 18px', background: 'var(--accent)', color: 'var(--accent-fg)',
  border: '1px solid transparent', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  fontSize: 14, fontWeight: 600,
}
const secondaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 36, padding: '0 16px', background: 'var(--surface-3)', color: 'var(--ink)',
  border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  fontSize: 14, fontWeight: 600,
}

function ConsoleModal({ instanceId, instanceName, lines, onClose }: { instanceId: string; instanceName: string; lines: string[]; onClose: () => void }) {
  const t = useT()
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
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
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, fontWeight: 600, color: 'var(--grass)', letterSpacing: '.02em' }}>
            {t.home.consoleTitle(instanceName)}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <UploadLogButton instanceId={instanceId} source="latest" style={{ height: 26 }} />
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px' }}>
          {lines.length === 0
            ? <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ink-4)' }}>{t.home.consoleWaiting}</span>
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

function NoLicenseModal({ instanceName, onClose }: { instanceName: string; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: 440, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)', letterSpacing: '.02em' }}>{t.home.licenseTitle}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '24px 22px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>{t.home.licenseHeading}</div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '0 0 6px' }}>
            {t.home.licenseBody(instanceName)}
          </p>
          <p style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.5, margin: '0 0 22px' }}>
            {t.home.licenseNote}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={() => { void api.external.open('https://www.minecraft.net/en-us/get-minecraft') }}
              style={primaryBtnStyle}
            >
              {t.home.buyMinecraft}
            </button>
            <Link to="/account" onClick={onClose} style={{ ...secondaryBtnStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
              {t.home.goToAccounts}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

function LowMemoryModal({ neededMb, availableMb, onLaunch, onClose }: { neededMb: number; availableMb: number; onLaunch: () => void; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  const gb = (mb: number) => (mb / 1024).toFixed(1).replace(/\.0$/, '')
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: 440, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)', letterSpacing: '.02em' }}>{t.home.ramWarnTitle}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '24px 22px' }}>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '0 0 22px' }}>
            {t.home.ramWarnBody(gb(neededMb), gb(availableMb))}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={onLaunch} style={primaryBtnStyle}>{t.home.ramWarnLaunch}</button>
            <button onClick={onClose} style={secondaryBtnStyle}>{t.home.ramWarnCancel}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlayOfflineModal({ instanceName, onPlayOffline, onClose }: { instanceName: string; onPlayOffline: () => void; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: 440, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)', letterSpacing: '.02em' }}>{t.home.offlineTitle}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '24px 22px' }}>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '0 0 22px' }}>
            {t.home.offlineBody(instanceName)}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={onPlayOffline} style={primaryBtnStyle}>{t.home.offlinePlay}</button>
            <button onClick={onClose} style={secondaryBtnStyle}>{t.home.offlineCancel}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function NewGroupDialog({ existing, onCancel, onCreate }: { existing: string[]; onCancel: () => void; onCreate: (name: string) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const trimmed = name.trim()
  const duplicate = trimmed.length > 0 && existing.includes(trimmed)
  const canCreate = trimmed.length > 0 && !duplicate

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (canCreate) onCreate(trimmed)
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <form
        onSubmit={submit}
        style={{ width: 380, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-floating)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{t.home.newGroupHeading}</div>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 14px' }}>{t.home.newGroupDesc}</p>
          <input
            ref={inputRef}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t.home.newGroupPlaceholder}
            maxLength={48}
            style={{
              width: '100%', height: 38, padding: '0 12px',
              background: 'var(--bg)', color: 'var(--ink)',
              border: `1px solid ${duplicate ? 'var(--lava)' : 'var(--border-r)'}`,
              borderRadius: 'var(--radius-md)', outline: 'none', fontSize: 14,
            }}
          />
          <div style={{ minHeight: 16, marginTop: 6, fontSize: 11, color: 'var(--lava)' }}>
            {duplicate ? t.home.newGroupDuplicate : ''}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 20px 18px' }}>
          <Button variant="ghost" type="button" onClick={onCancel}>{t.home.newGroupCancel}</Button>
          <Button variant="primary" type="submit" disabled={!canCreate}>{t.home.newGroupCreate}</Button>
        </div>
      </form>
    </div>
  )
}

function ConfirmDialog({ title, body, confirmLabel, danger, onCancel, onConfirm }: { title: string; body: string; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ width: 380, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-floating)', padding: '20px' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5, margin: '8px 0 18px' }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onCancel}>{t.home.cancel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

function MoveToGroupDialog({ groups, count, onCancel, onApply }: { groups: string[]; count: number; onCancel: () => void; onApply: (groupId: string | undefined) => void }) {
  const t = useT()
  const [newName, setNewName] = useState('')
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ width: 380, maxHeight: '70vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-floating)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{t.home.moveTitle}</div>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 12px' }}>{t.home.moveDesc(count)}</p>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {groups.map(g => (
            <Button key={g} variant="secondary" onClick={() => onApply(g)} style={{ justifyContent: 'flex-start', width: '100%' }}>{g}</Button>
          ))}
          <Button variant="ghost" onClick={() => onApply(undefined)} style={{ justifyContent: 'flex-start', width: '100%', color: 'var(--ink-3)' }}>{t.home.ungroup}</Button>
        </div>
        <form
          onSubmit={e => { e.preventDefault(); if (newName.trim()) onApply(newName.trim()) }}
          style={{ display: 'flex', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--line)', marginTop: 8 }}
        >
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t.home.newGroupPlaceholder}
            maxLength={48}
            style={{ flex: 1, height: 34, padding: '0 12px', background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', outline: 'none', fontSize: 13 }}
          />
          <Button variant="primary" type="submit" disabled={!newName.trim()}>{t.home.newGroupCreate}</Button>
        </form>
      </div>
    </div>
  )
}

function Library() {
  const t = useT()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Instance | null>(null)
  const [launchToast, setLaunchToast] = useState<string | null>(null)
  const [carouselTab, setCarouselTab] = useState<'recent' | 'pinned' | 'all'>('recent')
  const [carouselPage, setCarouselPage] = useState(0)
  const [activeAccount, setActiveAccount] = useState<ActiveAccount>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [, setTick] = useState(0)
  const [installing, setInstalling] = useState<{ instanceId: string; name: string } | null>(null)
  const [javaPrep, setJavaPrep] = useState<{ step: string; percent: number } | null>(null)
  const launchingRef = useRef(false)
  const [modpackUpdates, setModpackUpdates] = useState<Set<string>>(new Set())
  const [modpackUpdating, setModpackUpdating] = useState<{ step: string; percent: number } | null>(null)
  const updatingModpackRef = useRef(false)
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set(activeLaunchIds))
  const [launchingIds, setLaunchingIds] = useState<Set<string>>(() => new Set(activeLaunchIds))
  const [mcVersions, setMcVersions] = useState<MinecraftVersion[]>([])
  const [consoleLogs, setConsoleLogs] = useState<Map<string, string[]>>(() => new Map(consoleLogCache))
  const consoleLogsRef = useRef(consoleLogs)
  const [consoleOpen, setConsoleOpen] = useState<string | null>(null)
  const [modsTarget, setModsTarget] = useState<Instance | null>(null)
  const [serversTarget, setServersTarget] = useState<Instance | null>(null)
  const [updateCounts, setUpdateCounts] = useState<Map<string, number>>(new Map())
  const [searchQuery, setSearchQuery] = useState('')
  const [filterLoader, setFilterLoader] = useState('')
  const [filterVersion, setFilterVersion] = useState('')
  const [dragInstanceId, setDragInstanceId] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // User-created groups persist even while empty (regular groups are derived from
  // instances that carry a groupId, so a brand-new group needs its own store).
  const [customGroups, setCustomGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('refract.customGroups') ?? '[]') as string[] } catch { return [] }
  })
  // User-defined ordering of groups (drag to reorder). Names not present here
  // fall back to alphabetical, appended after the ordered ones.
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('refract.groupOrder') ?? '[]') as string[] } catch { return [] }
  })
  const [dragGroupKey, setDragGroupKey] = useState<string | null>(null)
  const [javas, setJavas] = useState<import('@refract/core').JavaInstallation[]>([])
  const [jarToast, setJarToast] = useState<string | null>(null)
  const [whatsNew, setWhatsNew] = useState<ChangelogEntry[]>(FALLBACK_WHATS_NEW)
  const [fileImport, setFileImport] = useState<FileImportState | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<number | null>(null)
  const [crashReport, setCrashReport] = useState<{ instanceId: string; text: string; diagnosticText: string; lastLines: string[]; code: number | null; error?: string; reportFileName?: string } | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [noLicenseTarget, setNoLicenseTarget] = useState<Instance | null>(null)
  const [ramWarning, setRamWarning] = useState<{ instance: Instance; availableMb: number; quickPlay?: QuickPlayTarget } | null>(null)
  const [offlineOffer, setOfflineOffer] = useState<{ instance: Instance; quickPlay?: QuickPlayTarget } | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [externalInstances, setExternalInstances] = useState<ExternalInstance[] | null>(null)
  const [externalScanning, setExternalScanning] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [moveGroupOpen, setMoveGroupOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: instances = [], isLoading } = useInstances()
  const createInstance = useCreateInstance()
  const updateInstance = useUpdateInstance()
  const deleteInstance = useDeleteInstance()

  const clock = useClock()
  const timeStr = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const hasProfile = activeAccount != null
  const canPlayMinecraft = activeAccount?.canPlayMinecraft ?? false

  useEffect(() => {
    api.auth.active()
      .then(setActiveAccount)
      .catch(() => setActiveAccount(null))
  }, [])

  useEffect(() => {
    api.config.get()
      .then(cfg => {
        setAppConfig(cfg)
        if (!cfg.onboardingDone) setOnboardingStep(0)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    api.activity.list()
      .then(setActivity)
      .catch(() => setActivity([]))
  }, [])

  // Fetch CHANGELOG.md directly — always accurate, no CI dependency
  useEffect(() => {
    fetch(CHANGELOG_URL)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        const entries = parseChangelog(text)
        if (entries.length) setWhatsNew(entries)
      })
      .catch(() => { /* keep fallback */ })
  }, [])

  // Re-render relative timestamps every minute
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // Load Java list once
  useEffect(() => {
    api.mc.java().then(setJavas).catch(() => setJavas([]))
  }, [])

  useEffect(() => {
    const sync = () => {
      const next = new Set(activeLaunchIds)
      setLaunchingIds(prev => sameSet(prev, next) ? prev : next)
    }
    sync()
    const interval = window.setInterval(sync, 500)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (instances.length === 0) {
      setRunningIds(prev => activeLaunchIds.size === 0 && prev.size === 0 ? prev : new Set(activeLaunchIds))
      return
    }
    let alive = true
    const refresh = async () => {
      const installedIds = instances.filter(inst => inst.isInstalled).map(inst => inst.id)
      const pairs = await Promise.all(installedIds.map(async id => [id, await api.mc.isRunning(id).catch(() => false)] as const))
      if (!alive) return
      const next = new Set(activeLaunchIds)
      for (const [id, running] of pairs) if (running) next.add(id)
      setRunningIds(prev => sameSet(prev, next) ? prev : next)
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 3000)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [instances])

  // Background mod update check — deferred 8 s so page renders first
  useEffect(() => {
    if (instances.length === 0) return
    const tid = window.setTimeout(() => {
      for (const inst of instances) {
        if (!inst.isInstalled) continue
        api.modrinth.checkModUpdates(inst.id)
          .then(updates => {
            const count = updates.filter(u => u.hasUpdate).length
            setUpdateCounts(prev => {
              if ((prev.get(inst.id) ?? 0) === count) return prev
              const next = new Map(prev); next.set(inst.id, count); return next
            })
          })
          .catch(() => {})
      }
    }, 8000)
    return () => window.clearTimeout(tid)
  }, [instances])

  // Background modpack-update check for instances created from a modpack.
  useEffect(() => {
    if (instances.length === 0) return
    const tid = window.setTimeout(() => {
      for (const inst of instances) {
        if (!inst.isInstalled || !inst.modpackSource) continue
        api.modpack.checkUpdate(inst.id)
          .then(info => {
            if (info?.hasUpdate) setModpackUpdates(prev => prev.has(inst.id) ? prev : new Set(prev).add(inst.id))
          })
          .catch(() => {})
      }
    }, 9000)
    return () => window.clearTimeout(tid)
  }, [instances])

  // Modpack update progress (in-place re-install) for the overlay.
  useEffect(() => {
    const offP = api.modpack.onProgress(({ step, percent }) => { if (updatingModpackRef.current) setModpackUpdating({ step, percent }) })
    const offD = api.modpack.onDone(({ instanceId, error }) => {
      if (!updatingModpackRef.current) return
      updatingModpackRef.current = false
      setModpackUpdating(null)
      if (error) {
        setLaunchToast(t.home.updateFailed(error))
        setTimeout(() => setLaunchToast(null), 5000)
      } else {
        setLaunchToast(t.home.modpackUpdated)
        setTimeout(() => setLaunchToast(null), 4000)
        if (instanceId) setModpackUpdates(prev => { const n = new Set(prev); n.delete(instanceId); return n })
        void queryClient.invalidateQueries({ queryKey: ['instances'] })
      }
    })
    return () => { offP(); offD() }
  }, [])

  async function handleUpdateModpack(inst: Instance) {
    updatingModpackRef.current = true
    setModpackUpdating({ step: t.home.starting, percent: 0 })
    try {
      await api.modpack.update(inst.id)
    } catch (e) {
      updatingModpackRef.current = false
      setModpackUpdating(null)
      setLaunchToast(t.home.updateFailed(e instanceof Error ? e.message : t.home.unknownError))
      setTimeout(() => setLaunchToast(null), 5000)
    }
  }

  function dismissOnboarding() {
    setOnboardingStep(null)
    api.config.set('onboardingDone', true).catch(() => {})
  }

  function dismissAnalyticsNotice() {
    setAppConfig(c => c ? { ...c, analyticsNoticeShown: true } : c)
    api.config.set('analyticsNoticeShown', true).catch(() => {})
  }

  async function recordActivity(label: string): Promise<void> {
    try {
      const entry = await api.activity.add(label)
      setActivity(prev => [entry, ...prev].slice(0, 50))
    } catch { /* non-critical */ }
  }

  useEffect(() => {
    const unsubProg = api.modpack.onProgress(({ projectId, step, percent }) => {
      setFileImport(prev => prev?.importId === projectId && prev.status === 'importing' ? { ...prev, step, percent } : prev)
    })
    const unsubDone = api.modpack.onDone(({ projectId, instanceId, error }) => {
      setFileImport(prev => {
        if (prev?.importId !== projectId) return prev
        if (error) return { ...prev, status: 'error', step: t.home.importFailedShort, error }
        if (instanceId) return { ...prev, status: 'done', step: t.home.readyToPlay, percent: 100, instanceId }
        return { ...prev, status: 'done', step: t.home.importComplete, percent: 100 }
      })
      if (instanceId) {
        void queryClient.invalidateQueries({ queryKey: ['instances'] })
        void recordActivity(t.home.activityImportedFile)
      }
    })
    return () => { unsubProg(); unsubDone() }
  }, [])

  async function handleImportFile(filePath: string): Promise<void> {
    const importId = `file-import-${Date.now()}`
    const name = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.(mrpack|zip)$/i, '') ?? t.home.importedPack
    setFileImport({ importId, step: t.home.starting, percent: 0, name, filePath, status: 'importing' })
    try {
      await api.modpack.installFromFile(filePath, name, importId)
    } catch (e) {
      setFileImport(prev => prev?.importId === importId
        ? { ...prev, status: 'error', step: t.home.importFailedShort, error: e instanceof Error ? e.message : t.home.unknownError }
        : prev
      )
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
      setLaunchToast(t.home.installFailedWith(e instanceof Error ? e.message : t.home.unknownError))
      setTimeout(() => setLaunchToast(null), 4000)
      setInstalling(null)
    }
  }

  async function handleLaunch(instance: Instance, opts?: { skipRamCheck?: boolean; quickPlay?: QuickPlayTarget; offline?: boolean }) {
    if (!hasProfile) {
      setLaunchToast(t.home.signInFirst)
      setTimeout(() => setLaunchToast(null), 3600)
      return
    }
    if (!canPlayMinecraft) {
      setNoLicenseTarget(instance)
      return
    }
    if (!instance.isInstalled) {
      await handleInstallMc(instance)
      return
    }
    if (launchingIds.has(instance.id) || activeLaunchIds.has(instance.id)) return
    if (runningIds.has(instance.id)) {
      activeLaunchIds.delete(instance.id)
      api.mc.stop(instance.id)
      setRunningIds(prev => { const n = new Set(prev); n.delete(instance.id); return n })
      return
    }
    // Warn when the instance wants more RAM than is currently free — the game
    // would swap or die at JVM startup. "Launch anyway" re-enters with the skip.
    if (!opts?.skipRamCheck) {
      const availableMb = await api.system.availableRamMb().catch(() => null)
      if (availableMb !== null && instance.memoryMb > availableMb) {
        setRamWarning({ instance, availableMb, quickPlay: opts?.quickPlay })
        return
      }
    }
    // Surface the one-time Java download (if the required runtime is missing)
    // that resolveJava performs in the main process during launch.
    launchingRef.current = true
    activeLaunchIds.add(instance.id)
    setLaunchingIds(prev => new Set([...prev, instance.id]))
    setRunningIds(prev => new Set([...prev, instance.id]))
    setConsoleOpen(instance.id)
    try {
      await api.mc.launch(instance.id, opts?.quickPlay, opts?.offline)
      void recordActivity(`Launched "${instance.name}"`)
    } catch (e) {
      activeLaunchIds.delete(instance.id)
      setRunningIds(prev => { const n = new Set(prev); n.delete(instance.id); return n })
      const msg = e instanceof Error ? e.message : t.home.unknownError
      // A failed launch must leave a trace the user can find later — the toast
      // is transient, and a pre-spawn failure produces no game log at all.
      logger.error('launch', `Launch failed for "${instance.name}": ${msg}`)
      // Expired sign-in: show the friendly message and send them to Accounts
      // to re-authenticate, instead of dumping the raw AADSTS error.
      if (msg.includes('AUTH_EXPIRED')) {
        setLaunchToast(t.home.sessionExpired)
        setTimeout(() => setLaunchToast(null), 4000)
        navigate({ to: '/account' })
        return
      }
      // Auth failed for connectivity reasons (not a rejected refresh token):
      // offer to start the game without signing in.
      if (!opts?.offline && /request|network|connect|timed out|dns|resolve/i.test(msg)) {
        setOfflineOffer({ instance, quickPlay: opts?.quickPlay })
        return
      }
      setLaunchToast(t.home.launchFailed(msg))
      setTimeout(() => setLaunchToast(null), 10000)
    } finally {
      launchingRef.current = false
      activeLaunchIds.delete(instance.id)
      setLaunchingIds(prev => { const n = new Set(prev); n.delete(instance.id); return n })
      setJavaPrep(null)
    }
  }

  // Show Java auto-download progress, but only while a launch is in flight
  // (the same channel also fires for manual downloads in Settings).
  useEffect(() => {
    const off = api.java.onProgress(({ step, percent }) => {
      if (launchingRef.current) setJavaPrep(step === 'Done' ? null : { step, percent })
    })
    return off
  }, [])

  // Listen for MC exit events
  useEffect(() => {
    consoleLogsRef.current = consoleLogs
  }, [consoleLogs])

  useEffect(() => {
    const unsub = api.mc.onExit(({ instanceId, code, error }) => {
      activeLaunchIds.delete(instanceId)
      setLaunchingIds(prev => { const n = new Set(prev); n.delete(instanceId); return n })
      setRunningIds(prev => { const n = new Set(prev); n.delete(instanceId); return n })
      // The exit watcher records the session's playtime before emitting, so
      // refetch to refresh playtime totals and the daily streak.
      void queryClient.invalidateQueries({ queryKey: ['instances'] })
      if (error || (typeof code === 'number' && code !== 0)) {
        void (async () => {
          const lastLines = consoleLogsRef.current.get(instanceId)?.slice(-30) ?? []
          const report = await api.mc.crashReport(instanceId).catch(() => null)
          const launcherLogs = await api.log.read(40).catch(() => [])
          const instance = instances.find(i => i.id === instanceId)
          const fallbackText = [
            error ? t.home.crashedWith(error) : t.home.exitedWith(code ?? t.home.unknownError),
            '',
            lastLines.length > 0 ? lastLines.join('\n') : 'No recent game output was captured.',
          ].join('\n')
          setCrashReport({
            instanceId,
            code,
            error,
            text: report?.text ?? fallbackText,
            diagnosticText: buildCrashDiagnosticBundle({
              instanceId,
              instance,
              code,
              error,
              report,
              lastLines,
              launcherLogs,
              javas,
            }),
            reportFileName: report?.filename,
            lastLines,
          })
        })()
      }
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [instances, javas, queryClient])

  // Accumulate MC log lines per instance
  useEffect(() => {
    const unsub = api.mc.onLog(({ instanceId, line }) => {
      const lines = line.split(/\r?\n/).filter(l => l.length > 0)
      setConsoleLogs(prev => {
        const next = new Map(prev)
        const existing = next.get(instanceId) ?? []
        const updated = [...existing, ...lines].slice(-2000)
        next.set(instanceId, updated)
        consoleLogCache.set(instanceId, updated)
        return next
      })
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [])

  const allGroupNames = [...new Set([...(instances.map(i => i.groupId).filter(Boolean) as string[]), ...customGroups])]
  // Ordered groups come first (user drag order), then any not-yet-ordered names
  // alphabetically — so newly added groups still show up predictably.
  const groups = [
    ...groupOrder.filter(g => allGroupNames.includes(g)),
    ...allGroupNames.filter(g => !groupOrder.includes(g)).sort(),
  ]
  const isGroupedView = carouselTab === 'all' && groups.length > 0

  function persistCustomGroups(next: string[]) {
    setCustomGroups(next)
    try { localStorage.setItem('refract.customGroups', JSON.stringify(next)) } catch { /* ignore */ }
  }
  function persistGroupOrder(next: string[]) {
    setGroupOrder(next)
    try { localStorage.setItem('refract.groupOrder', JSON.stringify(next)) } catch { /* ignore */ }
  }
  // Move the dragged group so it sits just before `targetKey` in the order.
  function reorderGroup(dragKey: string, targetKey: string) {
    if (dragKey === targetKey || !groups.includes(targetKey)) return
    const without = groups.filter(g => g !== dragKey)
    const idx = without.indexOf(targetKey)
    persistGroupOrder([...without.slice(0, idx), dragKey, ...without.slice(idx)])
  }
  // The desktop renderer has no working window.prompt, so group creation uses a
  // small in-app dialog (see NewGroupDialog) rather than a native prompt.
  function createGroupNamed(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (!groups.includes(trimmed)) persistCustomGroups([...customGroups, trimmed])
    setCarouselTab('all')
    setCarouselPage(0)
    setNewGroupOpen(false)
  }
  function deleteGroup(name: string) {
    persistCustomGroups(customGroups.filter(g => g !== name))
    if (groupOrder.includes(name)) persistGroupOrder(groupOrder.filter(g => g !== name))
    // Any instances still tagged with this group fall back to ungrouped.
    for (const inst of instances) {
      if (inst.groupId === name) updateInstance.mutate({ id: inst.id, patch: { groupId: undefined } })
    }
  }
  async function applyMoveToGroup(groupId: string | undefined) {
    if (groupId && !groups.includes(groupId)) persistCustomGroups([...customGroups, groupId])
    for (const id of selectedIds) await updateInstance.mutateAsync({ id, patch: { groupId } })
    setSelectedIds(new Set())
    setMoveGroupOpen(false)
  }
  async function confirmBulkDelete() {
    for (const id of [...selectedIds]) await deleteInstance.mutateAsync(id)
    setSelectedIds(new Set())
    setSelectionMode(false)
    setBulkDeleteOpen(false)
  }

  const applyFilters = (base: Instance[]) => {
    if (searchQuery) base = base.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    if (filterLoader) base = base.filter(i => (i.modLoader ?? 'vanilla') === filterLoader)
    if (filterVersion) base = base.filter(i => i.minecraftVersion === filterVersion)
    return base
  }

  const allVersions = [...new Set(instances.map(i => i.minecraftVersion).filter(Boolean))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

  const tabInstances = (() => {
    let base = applyFilters(instances)
    if (carouselTab === 'pinned') return base.filter(i => i.pinned)
    if (carouselTab === 'recent') return [...base].sort((a, b) => {
      const at = a.lastPlayed ?? a.createdAt
      const bt = b.lastPlayed ?? b.createdAt
      return bt.localeCompare(at)
    })
    return base
  })()
  const visibleInstances = tabInstances.slice(carouselPage * 3, carouselPage * 3 + 3)
  const totalPages = Math.max(1, Math.ceil(tabInstances.length / 3))

  return (
    <div className="library-dashboard">
      {/* Greeting + clock */}
      <div className="library-hero">
        <div>
          <div className="library-kicker">{greeting(t)}</div>
          <div className="library-title">
            <span>{t.home.readyFor}</span>
            <strong>{activeAccount?.username ?? t.sidebar.guest}</strong>
          </div>
          <div className="library-status" style={{ color: hasProfile && canPlayMinecraft ? 'var(--grass)' : 'var(--gold)' }}>
            {hasProfile && canPlayMinecraft
              ? t.home.playEnabled
              : hasProfile
              ? t.home.licenseRequired
              : t.home.signInToPlay}
          </div>
        </div>
        <div className="library-clock">
          {timeStr}
        </div>
      </div>

      {/* Instance carousel */}
      <div>
        {/* Search + group filter row */}
        {instances.length > 0 && (
          <div className="library-filter-row" style={{ marginBottom: 10 }}>
            <input
              className="launcher-input"
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setCarouselPage(0) }}
              placeholder={t.home.searchInstances}
            />
            <select
              className="launcher-select"
              value={filterLoader}
              onChange={e => { setFilterLoader(e.target.value); setCarouselPage(0) }}
              style={{ color: filterLoader ? 'var(--ink)' : 'var(--ink-4)' }}
            >
              <option value="">{t.home.allLoaders}</option>
              <option value="vanilla">Vanilla</option>
              <option value="fabric">Fabric</option>
              <option value="forge">Forge</option>
              <option value="neoforge">NeoForge</option>
              <option value="quilt">Quilt</option>
            </select>
            <select
              className="launcher-select"
              value={filterVersion}
              onChange={e => { setFilterVersion(e.target.value); setCarouselPage(0) }}
              style={{ color: filterVersion ? 'var(--ink)' : 'var(--ink-4)' }}
            >
              <option value="">{t.home.allVersions}</option>
              {allVersions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        )}

        {/* Header row */}
        <div className="library-control-bar" style={{ marginBottom: 12 }}>
          <div className="library-tabs">
            <span style={{ fontSize: 13, fontWeight: 750, color: 'var(--ink)', marginRight: 2 }}>{t.home.yourInstances}</span>
            {(['recent', 'pinned', 'all'] as const).map(tab => (
              <button
                className="launcher-tab"
                data-active={carouselTab === tab}
                key={tab}
                onClick={() => { setCarouselTab(tab); setCarouselPage(0) }}
              >
                {tab === 'recent' ? t.home.recent : tab === 'pinned' ? t.home.pinned : t.home.all}
              </button>
            ))}
            {instances.length > 0 && (
              <button
                onClick={() => {
                  if (selectionMode) { setSelectedIds(new Set()); setSelectionMode(false) }
                  else setSelectionMode(true)
                }}
                style={{
                  marginLeft: 8,
                  fontSize: 11, fontWeight: 500,
                  color: selectionMode ? 'var(--accent)' : 'var(--ink-4)',
                  background: selectionMode ? 'var(--accent-tint)' : 'transparent',
                  border: `1px solid ${selectionMode ? 'var(--accent)' : 'var(--border-r)'}`,
                  borderRadius: 3,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                {selectionMode ? (
                  'Cancel'
                ) : (
                  <>
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
                    {t.home.selectBtn}
                  </>
                )}
              </button>
            )}
          </div>

          {instances.length > 0 && (
            <div className="library-action-row">
              {!isGroupedView && (
                <>
                  <NavBtn disabled={carouselPage === 0} onClick={() => setCarouselPage(p => Math.max(0, p - 1))}>
                    <ChevLeftIcon />
                  </NavBtn>
                  <NavBtn disabled={carouselPage >= totalPages - 1} onClick={() => setCarouselPage(p => Math.min(totalPages - 1, p + 1))}>
                    <ChevRightIcon />
                  </NavBtn>
                </>
              )}
              <Button
                variant="secondary"
                onClick={() => setNewGroupOpen(true)}
                title={t.home.newGroupTitle}
              >
                {t.home.newGroup}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setSyncOpen(true)}
                title={t.home.syncTip}
              >
                ⇄ {t.home.syncBtn}
              </Button>
              <Button
                variant="primary"
                onClick={() => setCreateOpen(true)}
                style={{ marginLeft: isGroupedView ? 0 : 4 }}
              >
                {t.home.newBtn}
              </Button>
            </div>
          )}
        </div>

        {/* Bulk action bar */}
        {selectionMode && selectedIds.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
            padding: '8px 12px',
            background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)',
            fontSize: 12,
          }}>
            <span style={{ color: 'var(--ink)', fontWeight: 600, marginRight: 4 }}>{t.home.selectedCount(selectedIds.size)}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const visible = isGroupedView ? applyFilters(instances) : tabInstances
                setSelectedIds(new Set(visible.map(i => i.id)))
              }}
            >
              {t.home.selectAll}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMoveGroupOpen(true)}>
              {t.home.moveToGroup} ▾
            </Button>
            <Button variant="danger" size="sm" onClick={() => setBulkDeleteOpen(true)}>
              {t.home.delete}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}
            >
              ✕ {t.home.clearSelection}
            </Button>
          </div>
        )}

        {/* Cards */}
        {isLoading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
            {t.home.loading}
          </div>
        ) : instances.length === 0 ? (
          <EmptyState onOpen={() => setCreateOpen(true)} />
        ) : isGroupedView ? (
          (() => {
            const filtered = applyFilters(instances)
            const sections: Array<{ key: string; title: string; items: Instance[] }> = groups
              .map(g => ({ key: g, title: g, items: filtered.filter(i => i.groupId === g) }))
            const ungrouped = filtered.filter(i => !i.groupId)
            if (ungrouped.length > 0) sections.push({ key: '__ungrouped__', title: '', items: ungrouped })

            if (sections.length === 0) return (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
                {t.home.nothingHere}
              </div>
            )

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {sections.map(section => {
                  const isCollapsed = collapsedGroups.has(section.key)
                  const isGroup = section.key !== '__ungrouped__'
                  const isDragTarget = dragOverGroup === section.key && (dragInstanceId !== null || (dragGroupKey !== null && dragGroupKey !== section.key && isGroup))
                  return (
                    <div
                      key={section.key}
                      onDragOver={e => { e.preventDefault(); setDragOverGroup(section.key) }}
                      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverGroup(null) }}
                      onDrop={e => {
                        e.preventDefault()
                        setDragOverGroup(null)
                        // Reordering a whole group takes priority over moving an instance.
                        if (dragGroupKey) {
                          const dk = dragGroupKey
                          setDragGroupKey(null)
                          if (isGroup) reorderGroup(dk, section.key)
                          return
                        }
                        const id = dragInstanceId
                        setDragInstanceId(null)
                        if (!id) return
                        const newGroupId = isGroup ? section.key : undefined
                        updateInstance.mutate({ id, patch: { groupId: newGroupId } })
                      }}
                      style={{ outline: isDragTarget ? '2px dashed var(--accent)' : undefined, borderRadius: 4, padding: isDragTarget ? 4 : 0 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--line)', marginBottom: isCollapsed ? 0 : 10 }}>
                        {isGroup && (
                          <span
                            draggable
                            onDragStart={() => setDragGroupKey(section.key)}
                            onDragEnd={() => { setDragGroupKey(null); setDragOverGroup(null) }}
                            title={t.home.groupReorder}
                            style={{ cursor: 'grab', color: 'var(--ink-4)', fontSize: 13, padding: '0 6px 0 0', lineHeight: 1, userSelect: 'none' }}
                          >
                            ⠿
                          </span>
                        )}
                        <button
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev)
                            if (next.has(section.key)) next.delete(section.key)
                            else next.add(section.key)
                            return next
                          })}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0',
                            background: 'none', border: 'none', cursor: 'pointer', flex: 1, textAlign: 'left',
                          }}
                        >
                          <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>{isCollapsed ? '▶' : '▼'}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '.1em', textTransform: 'uppercase' }}>
                            {section.title || t.home.ungrouped}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--ink-4)', background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 8, padding: '0 6px', lineHeight: 1.7 }}>
                            {section.items.length}
                          </span>
                        </button>
                        {customGroups.includes(section.key) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t.home.groupDelete}
                            onClick={() => deleteGroup(section.key)}
                            style={{ width: 24, height: 24, color: 'var(--ink-4)' }}
                          >
                            ✕
                          </Button>
                        )}
                      </div>
                      {!isCollapsed && section.items.length === 0 && (
                        <div style={{
                          padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-4)',
                          border: '1px dashed var(--border-2)', borderRadius: 'var(--radius-md)',
                        }}>
                          {t.home.groupDropHint}
                        </div>
                      )}
                      {!isCollapsed && section.items.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                          {section.items.map(inst => {
                            const needed = requiredJava(inst.minecraftVersion)
                            const javaOk = javas.some(j => j.version >= needed)
                            return (
                              <div
                                key={inst.id}
                                draggable
                                onDragStart={() => setDragInstanceId(inst.id)}
                                onDragEnd={() => { setDragInstanceId(null); setDragOverGroup(null) }}
                                style={{ cursor: 'grab', opacity: dragInstanceId === inst.id ? 0.5 : 1 }}
                              >
                                <InstanceCard
                                  instance={inst}
                                  onLaunch={() => handleLaunch(inst)}
                                  onEdit={() => setEditTarget(inst)}
                                  onConsole={() => setConsoleOpen(inst.id)}
                                  onMods={() => setModsTarget(inst)}
                                  onOpenFolder={() => api.instance.openFolder(inst.id)}
                                  onServers={() => setServersTarget(inst)}
                                  onDropJar={async (path) => {
                                    try {
                                      await api.mods.installLocal(inst.id, path)
                                      setJarToast(t.home.modInstalledTo(inst.name))
                                    } catch (e) {
                                      setJarToast(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
                                    }
                                    setTimeout(() => setJarToast(null), 3500)
                                  }}
                                  blockReason={!hasProfile ? 'no-profile' : !canPlayMinecraft ? 'no-license' : null}
                                  isRunning={runningIds.has(inst.id)}
                                  isLaunching={launchingIds.has(inst.id)}
                                  hasLogs={(consoleLogs.get(inst.id)?.length ?? 0) > 0}
                                  updateCount={updateCounts.get(inst.id) ?? 0}
                                  javaOk={javaOk}
                                  updateAvailable={modpackUpdates.has(inst.id)}
                                  onUpdate={() => handleUpdateModpack(inst)}
                                  selectionMode={selectionMode}
                                  selected={selectedIds.has(inst.id)}
                                  onSelect={() => setSelectedIds(prev => {
                                    const next = new Set(prev)
                                    if (next.has(inst.id)) next.delete(inst.id)
                                    else next.add(inst.id)
                                    return next
                                  })}
                                />
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()
        ) : tabInstances.length === 0 ? (
          <div style={{
            height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-4)', letterSpacing: '.01em' }}>
              {carouselTab === 'pinned' ? t.home.noPinned : t.home.nothingHere}
            </div>
            {carouselTab === 'pinned' && (
              <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.home.pinHint}</div>
            )}
          </div>
        ) : (
          <div className="instance-grid">
            {visibleInstances.map(inst => {
              const needed = requiredJava(inst.minecraftVersion)
              const javaOk = javas.some(j => j.version >= needed)
              return (
                <InstanceCard
                  key={inst.id}
                  instance={inst}
                  onLaunch={() => handleLaunch(inst)}
                  onEdit={() => setEditTarget(inst)}
                  onConsole={() => setConsoleOpen(inst.id)}
                  onMods={() => setModsTarget(inst)}
                  onOpenFolder={() => api.instance.openFolder(inst.id)}
                  onServers={() => setServersTarget(inst)}
                  onDropJar={async (path) => {
                    try {
                      await api.mods.installLocal(inst.id, path)
                      setJarToast(t.home.modInstalledTo(inst.name))
                    } catch (e) {
                      setJarToast(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
                    }
                    setTimeout(() => setJarToast(null), 3500)
                  }}
                  blockReason={!hasProfile ? 'no-profile' : !canPlayMinecraft ? 'no-license' : null}
                  isRunning={runningIds.has(inst.id)}
                  isLaunching={launchingIds.has(inst.id)}
                  hasLogs={(consoleLogs.get(inst.id)?.length ?? 0) > 0}
                  updateCount={updateCounts.get(inst.id) ?? 0}
                  javaOk={javaOk}
                  updateAvailable={modpackUpdates.has(inst.id)}
                  onUpdate={() => handleUpdateModpack(inst)}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(inst.id)}
                  onSelect={() => setSelectedIds(prev => {
                    const next = new Set(prev)
                    if (next.has(inst.id)) next.delete(inst.id)
                    else next.add(inst.id)
                    return next
                  })}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Bottom panels */}
      {instances.length > 0 && (
        <div className="panel-grid">
          <WhatsNewPanel entries={whatsNew} />
          <ActivityPanel items={activity} />
          <PlaytimePanel instances={instances} />
        </div>
      )}

      {/* Jar drop toast */}
      {jarToast && (
        <div style={{
          position: 'fixed', bottom: 72, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          fontSize: 13, color: 'var(--ink)',
          zIndex: 50,
        }}>
          <div style={{ width: 8, height: 8, background: 'var(--grass)', flexShrink: 0 }} />
          {jarToast}
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
          void recordActivity(t.home.activityCreated(inst.name))
        }}
        onImportFile={handleImportFile}
        onImportMultiMc={async () => {
          try {
            const inst = await api.instance.importMultiMc()
            if (inst) {
              await queryClient.invalidateQueries({ queryKey: ['instances'] })
              void recordActivity(t.home.activityImportedMmc(inst.name))
            }
          } catch (e) {
            setLaunchToast(e instanceof Error ? e.message : t.home.importFailedShort)
          }
        }}
      />

      <EditInstanceDialog
        instance={editTarget}
        open={editTarget !== null}
        onOpenChange={(v) => { if (!v) setEditTarget(null) }}
        onSave={async (id, patch) => {
          const inst = await updateInstance.mutateAsync({ id, patch })
          void recordActivity(t.home.activityEdited(inst.name))
        }}
        onDelete={async (id) => {
          const inst = instances.find(i => i.id === id)
          await deleteInstance.mutateAsync(id)
          setEditTarget(null)
          if (inst) void recordActivity(t.home.activityDeleted(inst.name))
        }}
        onRepair={(id) => {
          const inst = instances.find(i => i.id === id)
          if (!inst) return
          setEditTarget(null)
          setInstalling({ instanceId: id, name: inst.name })
          api.mc.repair(id).catch((e: unknown) => {
            setInstalling(null)
            setLaunchToast(t.home.repairFailed(e instanceof Error ? e.message : t.home.unknownError))
            setTimeout(() => setLaunchToast(null), 4000)
          })
        }}
        onDuplicate={async (id) => {
          const inst = instances.find(i => i.id === id)
          await api.instance.duplicate(id)
          void queryClient.invalidateQueries({ queryKey: ['instances'] })
          if (inst) void recordActivity(t.home.activityDuplicated(inst.name))
        }}
      />

      {modpackUpdating && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-floating)', padding: '28px 32px', width: 380, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.04em' }}>{t.home.modpackUpdating}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{modpackUpdating.step}</div>
            <div style={{ height: 8, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-max)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${modpackUpdating.percent}%`, background: 'var(--accent)', transition: 'width 200ms linear' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>{t.home.modpackUpdateNote}</div>
          </div>
        </div>
      )}

      {javaPrep && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-floating)', padding: '28px 32px', width: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.04em' }}>{t.home.settingUpJava}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{javaPrep.step}</div>
            <div style={{ height: 8, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-max)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${javaPrep.percent}%`, background: 'var(--accent)', transition: 'width 200ms linear' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>{t.home.javaDownloadNote}</div>
          </div>
        </div>
      )}

      {installing && (
        <InstallProgress
          instanceId={installing.instanceId}
          instanceName={installing.name}
          onDone={() => {
            setInstalling(null)
            void recordActivity(t.home.activityInstalledMc(installing.name))
            void queryClient.invalidateQueries({ queryKey: ['instances'] })
          }}
          onError={(err) => {
            setInstalling(null)
            if (!err.toLowerCase().includes('cancel')) {
              setLaunchToast(t.home.installFailedWith(err))
              setTimeout(() => setLaunchToast(null), 4000)
            }
          }}
        />
      )}

      {fileImport && (() => {
        const tone = fileImport.status === 'error' ? 'var(--lava)' : fileImport.status === 'done' ? 'var(--grass)' : 'var(--accent)'
        const imported = fileImport.instanceId ? instances.find(i => i.id === fileImport.instanceId) : null
        return (
          <div style={{ position:'fixed', bottom:24, right:24, zIndex:100, width:340, pointerEvents:'auto' }}>
            <div style={{ background:'var(--surface-2)', borderRadius:'var(--radius)', padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:tone, letterSpacing:'.02em' }}>
                  {fileImport.status === 'done' ? t.home.importComplete : fileImport.status === 'error' ? t.home.importFailedShort : t.home.importingModpack}
                </div>
                <span style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, color:tone }}>{Math.round(fileImport.percent)}%</span>
              </div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--ink)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fileImport.name}</div>
              <div style={{ height:6, background:'var(--surface-3)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${fileImport.percent}%`, background:tone, transition:'width 200ms linear', borderRadius:3 }} />
              </div>
              <div style={{ fontSize:11, color:fileImport.status === 'error' ? 'var(--lava)' : 'var(--ink-4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {fileImport.error ?? fileImport.step}
              </div>
              {fileImport.status !== 'importing' && (
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                  {fileImport.status === 'done' && fileImport.instanceId && (
                    <Button variant="secondary" size="sm" onClick={() => { void api.instance.openFolder(fileImport.instanceId!) }}>
                      {t.home.openFolder}
                    </Button>
                  )}
                  {fileImport.status === 'done' && imported && (
                    <Button variant="primary" size="sm" onClick={() => { setFileImport(null); void handleLaunch(imported) }}>
                      {t.home.playShort}
                    </Button>
                  )}
                  {fileImport.status === 'error' && (
                    <Button variant="secondary" size="sm" onClick={() => { void handleImportFile(fileImport.filePath) }}>
                      {t.home.retry}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setFileImport(null)}>
                    {t.home.dismiss}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      <InstanceModsDialog
        instance={modsTarget}
        open={modsTarget !== null}
        onOpenChange={(v) => { if (!v) setModsTarget(null) }}
        onUpdateApplied={(instanceId) => {
          api.modrinth.checkModUpdates(instanceId)
            .then(updates => setUpdateCounts(prev => { const next = new Map(prev); next.set(instanceId, updates.filter(u => u.hasUpdate).length); return next }))
            .catch(() => {})
        }}
        onInstanceUpdated={() => queryClient.invalidateQueries({ queryKey: ['instances'] })}
        onLaunch={modsTarget ? (quickPlay?: QuickPlayTarget) => handleLaunch(modsTarget, { quickPlay }) : undefined}
        isRunning={modsTarget ? runningIds.has(modsTarget.id) : false}
        onEdit={modsTarget ? () => setEditTarget(modsTarget) : undefined}
      />

      <ServersDialog
        instance={serversTarget}
        open={serversTarget !== null}
        onOpenChange={(v) => { if (!v) setServersTarget(null) }}
      />

      {consoleOpen && (() => {
        const inst = instances.find(i => i.id === consoleOpen)
        return (
          <ConsoleModal
            instanceId={consoleOpen}
            instanceName={inst?.name ?? consoleOpen}
            lines={consoleLogs.get(consoleOpen) ?? []}
            onClose={() => setConsoleOpen(null)}
          />
        )
      })()}

      {crashReport && (() => {
        const inst = instances.find(i => i.id === crashReport.instanceId)
        return (
          <CrashReportModal
            instanceId={crashReport.instanceId}
            instanceName={inst?.name ?? crashReport.instanceId}
            text={crashReport.text}
            diagnosticText={crashReport.diagnosticText}
            lastLines={crashReport.lastLines}
            code={crashReport.code}
            error={crashReport.error}
            reportFileName={crashReport.reportFileName}
            onClose={() => setCrashReport(null)}
            onOpenConsole={() => { setCrashReport(null); setConsoleOpen(crashReport.instanceId) }}
            onOpenFolder={() => { void api.instance.openFolder(crashReport.instanceId) }}
          />
        )
      })()}

      {noLicenseTarget && (
        <NoLicenseModal
          instanceName={noLicenseTarget.name}
          onClose={() => setNoLicenseTarget(null)}
        />
      )}

      {offlineOffer && (
        <PlayOfflineModal
          instanceName={offlineOffer.instance.name}
          onPlayOffline={() => { const o = offlineOffer; setOfflineOffer(null); void handleLaunch(o.instance, { skipRamCheck: true, offline: true, quickPlay: o.quickPlay }) }}
          onClose={() => setOfflineOffer(null)}
        />
      )}

      {ramWarning && (
        <LowMemoryModal
          neededMb={ramWarning.instance.memoryMb}
          availableMb={ramWarning.availableMb}
          onLaunch={() => { const w = ramWarning; setRamWarning(null); void handleLaunch(w.instance, { skipRamCheck: true, quickPlay: w.quickPlay }) }}
          onClose={() => setRamWarning(null)}
        />
      )}

      {onboardingStep !== null && (
        <OnboardingModal
          step={onboardingStep}
          onNext={() => setOnboardingStep(s => s !== null ? Math.min(s + 1, 3) : null)}
          onClose={dismissOnboarding}
          onAddAccount={dismissOnboarding}
          onNewInstance={() => { setOnboardingStep(3); setCreateOpen(true) }}
        />
      )}

      {newGroupOpen && (
        <NewGroupDialog
          existing={groups}
          onCancel={() => setNewGroupOpen(false)}
          onCreate={createGroupNamed}
        />
      )}

      {moveGroupOpen && (
        <MoveToGroupDialog
          groups={groups}
          count={selectedIds.size}
          onCancel={() => setMoveGroupOpen(false)}
          onApply={applyMoveToGroup}
        />
      )}

      {bulkDeleteOpen && (
        <ConfirmDialog
          title={t.home.bulkDeleteTitle}
          body={t.home.bulkDeleteBody(selectedIds.size)}
          confirmLabel={t.home.delete}
          danger
          onCancel={() => setBulkDeleteOpen(false)}
          onConfirm={confirmBulkDelete}
        />
      )}

      {syncOpen && (
        <SyncPanel
          instances={externalInstances}
          scanning={externalScanning}
          onClose={() => setSyncOpen(false)}
          onScan={async () => {
            setExternalScanning(true)
            try {
              const found = await api.instance.scanExternal()
              setExternalInstances(found)
            } catch { setExternalInstances([]) }
            finally { setExternalScanning(false) }
          }}
          onScanFolder={async () => {
            setExternalScanning(true)
            try {
              const found = await api.instance.scanExternalFolder()
              setExternalInstances(prev => {
                const byDir = new Map<string, ExternalInstance>()
                for (const inst of prev ?? []) byDir.set(inst.instanceDir, inst)
                for (const inst of found) byDir.set(inst.instanceDir, inst)
                return [...byDir.values()]
              })
            } catch {
              setExternalInstances(prev => prev ?? [])
            } finally { setExternalScanning(false) }
          }}
          onLink={async (ext) => {
            const inst = await api.instance.linkExternal(ext)
            await queryClient.invalidateQueries({ queryKey: ['instances'] })
            void recordActivity(t.home.activityLinked(inst.name, ext.sourceName))
            return inst
          }}
          onImport={async (ext) => {
            const inst = await api.instance.importExternal(ext)
            await queryClient.invalidateQueries({ queryKey: ['instances'] })
            void recordActivity(t.home.activityImportedExt(inst.name, ext.sourceName))
            return inst
          }}
        />
      )}

      {analyticsAvailable && appConfig && appConfig.analyticsNoticeShown === false && onboardingStep === null && (
        <div style={{ position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 70, maxWidth: 560, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.5)' }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', flex: 1, lineHeight: 1.5 }}>{t.privacy.noticeText}</span>
          <Link to="/settings" onClick={() => dismissAnalyticsNotice()} style={{ fontSize: 12, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{t.privacy.noticeOpenSettings}</Link>
          <button onClick={() => dismissAnalyticsNotice()} style={{ fontSize: 12, fontWeight: 600, padding: '6px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>{t.privacy.noticeDismiss}</button>
        </div>
      )}

      <CornerCat />
    </div>
  )
}

function fmtSeconds(s: number): string {
  if (s < 60) return '< 1m'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

const SOURCE_META: Record<string, { label: string; color: string }> = {
  prism:      { label: 'Prism Launcher', color: '#e67e22' },
  multimc:    { label: 'MultiMC',        color: '#4caf50' },
  modrinth:   { label: 'Modrinth',       color: '#1bd96a' },
  atlauncher: { label: 'ATLauncher',     color: '#3ea5d6' },
  curseforge: { label: 'CurseForge',     color: '#f16436' },
  gdlauncher: { label: 'GDLauncher',     color: '#8e44ad' },
}

interface SyncPanelProps {
  instances: ExternalInstance[] | null
  scanning: boolean
  onClose: () => void
  onScan: () => Promise<void>
  onScanFolder: () => Promise<void>
  onLink: (ext: ExternalInstance) => Promise<Instance>
  onImport: (ext: ExternalInstance) => Promise<Instance>
}

function SyncPanel({ instances, scanning, onClose, onScan, onScanFolder, onLink, onImport }: SyncPanelProps) {
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)

  async function handleAction(ext: ExternalInstance, action: 'link' | 'import') {
    const key = `${ext.source}:${ext.name}:${action}`
    setBusy(key)
    setErr(null)
    try {
      if (action === 'link') await onLink(ext)
      else await onImport(ext)
      setDone(prev => { const n = new Set(prev); n.add(`${ext.source}:${ext.name}`); return n })
    } catch (e) {
      setErr(e instanceof Error ? e.message : t.sync.failed)
    } finally {
      setBusy(null)
    }
  }

  const bySource: Record<string, ExternalInstance[]> = {}
  for (const inst of instances ?? []) {
    if (!bySource[inst.source]) bySource[inst.source] = []
    bySource[inst.source].push(inst)
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div style={{ width: 580, maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', boxShadow: '0 24px 64px rgba(0,0,0,.7)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '.01em', color: 'var(--accent)' }}>{t.sync.title}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{t.sync.subtitle}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ fontSize: 16, color: 'var(--ink-4)' }}>✕</Button>
        </div>

        {/* scan button */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            variant="primary"
            onClick={() => { void onScan() }}
            disabled={scanning}
          >
            {scanning ? t.sync.scanning : t.sync.scan}
          </Button>
          <Button
            variant="secondary"
            onClick={() => { void onScanFolder() }}
            disabled={scanning}
          >
            {t.sync.scanFolder}
          </Button>
          <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>
            Prism · MultiMC · Modrinth · ATLauncher · CurseForge · GDLauncher
          </span>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 20px' }}>
          {err && <div style={{ marginBottom: 10, fontSize: 12, color: '#ff6b6b', background: 'rgba(255,100,100,.1)', border: '1px solid rgba(255,100,100,.2)', borderRadius: 6, padding: '8px 12px' }}>{err}</div>}

          {instances === null && !scanning && (
            <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontSize: 13, padding: '32px 0' }}>
              {t.sync.scanHintPre} <strong>{t.sync.scan}</strong> {t.sync.scanHintPost}
            </div>
          )}

          {instances !== null && instances.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--ink-4)', fontSize: 13, padding: '32px 0' }}>
              {t.sync.noneFound}
            </div>
          )}

          {Object.entries(bySource).map(([source, list]) => {
            const meta = SOURCE_META[source] ?? { label: source, color: 'var(--accent)' }
            return (
              <div key={source} style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: meta.color }}>{meta.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{t.sync.instances(list.length)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map(ext => {
                    const key = `${ext.source}:${ext.name}`
                    const isDone = done.has(key)
                    const isLinkBusy = busy === `${key}:link`
                    const isImportBusy = busy === `${key}:import`
                    return (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: isDone ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'var(--surface-2)', border: `1px solid ${isDone ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ext.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
                            MC {ext.minecraftVersion}
                            {ext.modLoader && <span style={{ marginLeft: 6, color: 'var(--accent)' }}>{ext.modLoader}{ext.modLoaderVersion ? ` ${ext.modLoaderVersion}` : ''}</span>}
                          </div>
                        </div>
                        {isDone ? (
                          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{t.sync.added}</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button
                              disabled={!!busy}
                              onClick={() => { void handleAction(ext, 'link') }}
                              title={t.sync.linkTitle}
                              style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', background: 'var(--surface-3)', border: '1px solid var(--border-r)', borderRadius: 6, color: 'var(--ink)', cursor: busy ? 'default' : 'pointer', opacity: busy ? .6 : 1 }}
                            >
                              {isLinkBusy ? '…' : t.sync.link}
                            </button>
                            <button
                              disabled={!!busy}
                              onClick={() => { void handleAction(ext, 'import') }}
                              title={t.sync.importTitle}
                              style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', background: 'var(--accent)', border: 'none', borderRadius: 6, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .6 : 1 }}
                            >
                              {isImportBusy ? '…' : t.sync.import}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* legend */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 16, fontSize: 10, color: 'var(--ink-4)' }}>
          <span><strong style={{ color: 'var(--ink)' }}>{t.sync.link}</strong> — {t.sync.legendLink}</span>
          <span><strong style={{ color: 'var(--ink)' }}>{t.sync.import}</strong> — {t.sync.legendImport}</span>
        </div>
      </div>
    </div>
  )
}

function computeStreak(instances: Instance[]): { streak: number; savesLeft: number } {
  const played = new Set<string>()
  for (const inst of instances) {
    for (const [date, secs] of Object.entries(inst.playtimeLog ?? {})) {
      if (secs > 0) played.add(date)
    }
  }
  if (played.size === 0) return { streak: 0, savesLeft: 2 }

  const now = new Date()
  const todayStr = localDateKey(now)
  const currentMonth = todayStr.slice(0, 7)
  const missedPerMonth: Record<string, number> = {}
  let streak = 0

  // Grace period: if today not played yet, start walking from yesterday
  const startI = played.has(todayStr) ? 0 : 1

  for (let i = startI; i < 400; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = localDateKey(d)
    const month = dateStr.slice(0, 7)

    if (played.has(dateStr)) {
      streak++
    } else {
      // Gap: within streak or before first played day — consume a monthly save
      missedPerMonth[month] = (missedPerMonth[month] ?? 0) + 1
      if (missedPerMonth[month] > 2) break
      // else: save covers this day, continue
    }
  }

  const savesLeft = Math.max(0, 2 - (missedPerMonth[currentMonth] ?? 0))
  return { streak, savesLeft }
}

function WhatsNewPanel({ entries }: { entries: ChangelogEntry[] }) {
  const t = useT()
  const latest = entries[0]
  const latestNotes = latest?.notes.slice(0, 4) ?? []
  const older = entries.slice(1, 4)
  const [openVersion, setOpenVersion] = useState<string | null>(latest?.version ?? null)

  return (
    <Panel title={t.home.whatsNew} meta={latest ? `v${latest.version}` : undefined}>
      {latest ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            onClick={() => setOpenVersion(v => v === latest.version ? null : latest.version)}
            style={{
              padding: '10px 12px',
              background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-2))',
              border: '1px solid color-mix(in srgb, var(--accent) 34%, var(--border-r))',
              borderRadius: 'var(--radius-md)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', letterSpacing: '.01em' }}>
                v{latest.version}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {latest.date && <span style={{ fontSize: 10, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>{latest.date}</span>}
                <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>{openVersion === latest.version ? t.home.collapse : t.home.readMore}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
              {(openVersion === latest.version ? latest.notes : latestNotes).map((note, index) => (
                <div key={`${latest.version}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ width: 5, height: 5, marginTop: 6, flexShrink: 0, background: 'var(--accent)' }} />
                  <span style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>{note}</span>
                </div>
              ))}
            </div>
          </button>

          {older.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {older.map(item => (
                <button
                  key={item.version}
                  type="button"
                  onClick={() => setOpenVersion(v => v === item.version ? null : item.version)}
                  style={{
                    padding: '7px 0',
                    border: 'none',
                    borderTop: '1px solid var(--line)',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '56px 1fr auto',
                    gap: 10,
                    alignItems: 'baseline',
                  }}>
                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)' }}>
                      v{item.version}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.notes[0]}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>{openVersion === item.version ? t.home.less : t.home.readMore}</span>
                  </div>
                  {openVersion === item.version && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7, paddingLeft: 66 }}>
                      {item.notes.map((note, index) => (
                        <div key={`${item.version}-${index}`} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                          <span style={{ width: 4, height: 4, marginTop: 6, flexShrink: 0, background: 'var(--surface-3)' }} />
                          <span style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.45 }}>{note}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <PanelEmpty label={t.news.empty} />
      )}
    </Panel>
  )
}

function ActivityPanel({ items }: { items: ActivityEntry[] }) {
  const t = useT()
  const recent = items.slice(0, 6)

  return (
    <Panel title={t.home.activity} meta={items.length > 0 ? String(items.length) : undefined}>
      {recent.length === 0 ? (
        <PanelEmpty label={t.home.noActivity} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {recent.map((item, index) => (
            <div key={item.id} style={{
              display: 'grid',
              gridTemplateColumns: '8px minmax(0, 1fr) auto',
              gap: 10,
              alignItems: 'center',
              minHeight: 36,
              padding: '7px 0',
              borderTop: index === 0 ? 'none' : '1px solid var(--line)',
            }}>
              <span style={{ width: 6, height: 6, background: index === 0 ? 'var(--accent)' : 'var(--surface-3)' }} />
              <span style={{ fontSize: 12, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
              <span style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 10,
                color: 'var(--ink-4)',
                whiteSpace: 'nowrap',
              }}>
                {timeAgo(item.ts)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function PlaytimePanel({ instances }: { instances: Instance[] }) {
  const t = useT()
  const sorted = [...instances]
    .filter(i => i.totalTimePlayed > 0)
    .sort((a, b) => b.totalTimePlayed - a.totalTimePlayed)
    .slice(0, 6)

  const grandTotal = instances.reduce((acc, i) => acc + i.totalTimePlayed, 0)
  const maxTime = sorted[0]?.totalTimePlayed ?? 1

  // Last 7 days
  const today = new Date()
  const days: { label: string; seconds: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = localDateKey(d)
    const dayIdx = d.getDay() // 0=Sun
    const DAY_ABBR = t.home.dayAbbr
    let secs = 0
    for (const inst of instances) {
      secs += inst.playtimeLog?.[key] ?? 0
    }
    days.push({ label: DAY_ABBR[dayIdx] ?? '', seconds: secs })
  }
  const maxDay = Math.max(...days.map(d => d.seconds), 1)

  const { streak, savesLeft } = computeStreak(instances)
  const activeDays = days.filter(day => day.seconds > 0).length
  const topInstance = sorted[0]

  if (sorted.length === 0 && grandTotal === 0) {
    return (
      <Panel title={t.home.playtime}>
        <PanelEmpty label={t.home.playtimeEmpty} />
      </Panel>
    )
  }

  return (
    <Panel title={t.home.playtime} meta={t.home.activeDays(activeDays)}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '10px 12px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius-md)',
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 850, color: 'var(--ink)', lineHeight: 1 }}>
            {fmtSeconds(grandTotal)}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.home.playtimeTotal}{topInstance ? t.home.ledBy(topInstance.name) : ''}
          </div>
        </div>
        {streak > 0 && (
          <div style={{
            minWidth: 74,
            padding: '8px 9px',
            border: '1px solid color-mix(in srgb, var(--accent) 36%, var(--border-r))',
            background: 'color-mix(in srgb, var(--accent) 9%, transparent)',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 7,
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>🔥</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--accent)', lineHeight: 1 }}>{streak}</div>
              <div style={{ marginTop: 3, fontSize: 9, color: 'var(--ink-4)', letterSpacing: '.05em', textTransform: 'uppercase' }}>
                {t.home.dayStreak}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {sorted.map(inst => {
          const pct = (inst.totalTimePlayed / maxTime) * 100
          return (
            <div key={inst.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 78px) 1fr 44px', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inst.name}
              </div>
              <div style={{ height: 7, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden', border: '1px solid var(--line)' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
              </div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, color: 'var(--ink-4)', textAlign: 'right' }}>
                {fmtSeconds(inst.totalTimePlayed)}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 13, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-4)', letterSpacing: '.08em', textTransform: 'uppercase' }}>{t.home.last7Days}</div>
          {savesLeft > 0 && streak > 0 && (
            <div style={{ fontSize: 10, color: 'var(--ink-4)' }}>{savesLeft} {savesLeft === 1 ? t.home.saveLeft : t.home.savesLeft}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 48 }}>
          {days.map((day, i) => {
            const h = day.seconds > 0 ? Math.max(5, Math.round((day.seconds / maxDay) * 40)) : 0
            return (
              <div key={i} title={`${day.label}: ${fmtSeconds(day.seconds)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ width: '100%', height: 40, display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{
                    width: '100%',
                    height: h,
                    background: h > 0 ? 'var(--accent)' : 'var(--surface-2)',
                    borderRadius: 2,
                    opacity: h > 0 ? 1 : 0.4,
                  }} />
                </div>
                <div style={{ fontSize: 9, color: 'var(--ink-4)' }}>{day.label}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Streak */}
      {false && streak > 0 && (() => {
        const streakColor = streak >= 90 ? '#a020f0' : streak >= 31 ? '#ff2200' : '#ff9966'
        return (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 24, lineHeight: 1 }}>🔥</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: streakColor, lineHeight: 1 }}>{streak}</span>
                <span style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.04em' }}>{t.home.dayStreak}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {[0, 1].map(idx => (
                  <div key={idx} title={idx < savesLeft ? t.home.saveAvailable : t.home.saveUsed} style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: idx < savesLeft ? streakColor : 'var(--surface-2)',
                    border: `1.5px solid ${idx < savesLeft ? streakColor : 'var(--line)'}`,
                    boxShadow: idx < savesLeft ? `0 0 6px ${streakColor}88` : 'none',
                    transition: 'background 300ms, border-color 300ms, box-shadow 300ms',
                  }} />
                ))}
              </div>
              <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>{savesLeft} {savesLeft === 1 ? t.home.saveLeft : t.home.savesLeft}</span>
            </div>
          </div>
        )
      })()}

    </Panel>
  )
}

function PanelEmpty({ label }: { label: string }) {
  return (
    <div style={{
      minHeight: 96,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px dashed var(--border-r)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--ink-4)',
      fontSize: 12,
      background: 'color-mix(in srgb, var(--surface-2) 58%, transparent)',
    }}>
      {label}
    </div>
  )
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="launcher-panel" style={{
      padding: 14,
      minHeight: 258,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
          {title}
        </div>
        {meta && (
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>
            {meta}
          </div>
        )}
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
