import { createFileRoute, Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type React from 'react'
import type { Instance, MinecraftVersion } from '@refract/core'
import { useT, type T } from '@/i18n'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
import { ChevLeftIcon, ChevRightIcon } from '@/components/ui/BlockIcons'
import { CreateInstanceDialog } from '@/components/instances/CreateInstanceDialog'
import { EditInstanceDialog } from '@/components/instances/EditInstanceDialog'
import { InstanceModsDialog } from '@/components/instances/InstanceModsDialog'
import { ServersDialog } from '@/components/instances/ServersDialog'
import { InstallProgress } from '@/components/minecraft/InstallProgress'
import { useInstances, useCreateInstance, useUpdateInstance, useDeleteInstance } from '@/hooks/use-instances'
import { api, type AppConfig } from '@/lib/api'

export const Route = createFileRoute('/')({
  component: Library,
})

type ActiveAccount = Awaited<ReturnType<typeof api.auth.active>>

const RELEASES_URL = 'https://api.github.com/repos/ShevRuslan1/Refract_MC/releases'

interface ChangelogEntry { version: string; notes: string[]; date?: string }

type GitHubRelease = { tag_name: string; name: string; body: string; published_at: string; draft: boolean; prerelease: boolean }

function parseReleaseBody(body: string): string[] {
  const notes: string[] = []
  for (const raw of (body ?? '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('- ') || line.startsWith('* ')) notes.push(line.slice(2).trim())
  }
  return notes
}

function releasesToChangelog(releases: GitHubRelease[]): ChangelogEntry[] {
  return releases
    .filter(r => !r.draft && !r.prerelease)
    .map(r => ({
      version: r.tag_name.replace(/^v/, ''),
      notes: parseReleaseBody(r.body),
      date: r.published_at ? new Date(r.published_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
    }))
    .filter(e => e.notes.length > 0)
}

const FALLBACK_WHATS_NEW: ChangelogEntry[] = [
  { version: '0.6.0', notes: ['Java Manager — auto-download Temurin JRE from settings', 'Instance search bar and group tags', 'Drag-and-drop .jar onto instance card to install mod'] },
  { version: '0.5.1', notes: ['Mod update checker with one-click Update All', 'Server list viewer with copy-IP', 'Instance export as ZIP, duplicate instance'] },
  { version: '0.5.0', notes: ['Worlds browser with delete, Screenshots grid', 'Crash report viewer on non-zero MC exit', 'First-run onboarding flow'] },
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

function requiredJava(mcVersion: string): number {
  const parts = mcVersion.split('.').map(Number)
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 17) return 17
  return 8
}

function InstanceCard({ instance, onLaunch, onEdit, onConsole, onMods, onOpenFolder, onServers, onDropJar, blockReason, isRunning, hasLogs, updateCount, javaOk }: { instance: Instance; onLaunch: () => void; onEdit: () => void; onConsole: () => void; onMods: () => void; onOpenFolder: () => void; onServers: () => void; onDropJar: (path: string) => void; blockReason: 'no-profile' | 'no-license' | null; isRunning: boolean; hasLogs: boolean; updateCount: number; javaOk: boolean }) {
  const t = useT()
  const [dragOver, setDragOver] = useState(false)
  const label = isRunning ? t.home.stop : instance.isInstalled ? t.home.play : t.home.install
  return (
    <div
      onDragOver={e => { e.preventDefault(); if ([...e.dataTransfer.items].some(i => i.kind === 'file')) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file && (file as File & { path?: string }).path) {
          onDropJar((file as File & { path: string }).path)
        }
      }}
      style={{
        width: 300,
        flexShrink: 0,
        outline: dragOver ? '2px solid var(--accent)' : 'none',
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
        {dragOver && (
          <div style={{ position:'absolute', inset:0, background:'rgba(79,184,232,.25)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>
            <div style={{ fontFamily:"'VT323',monospace", fontSize:18, color:'#fff', letterSpacing:'.1em', background:'rgba(0,0,0,.6)', padding:'6px 16px', borderRadius:4 }}>{t.home.dropMod}</div>
          </div>
        )}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
          height: 60,
        }} />
        {!javaOk && instance.isInstalled && (
          <div style={{
            position: 'absolute', top: 8, left: 8,
            background: 'rgba(196,148,50,.9)',
            borderRadius: 3, padding: '2px 7px',
            fontFamily: "'VT323',monospace", fontSize: 12,
            color: '#000', letterSpacing: '.06em',
          }}>
            {t.home.javaWarning(requiredJava(instance.minecraftVersion))}
          </div>
        )}
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
        <div style={{ marginTop: 'auto', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Primary row: PLAY + CONSOLE */}
          <div style={{ display: 'flex', gap: 6 }}>
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
                  borderRadius: 3, padding: '0 12px', height: 40, cursor: 'pointer',
                }}
              >
                {isRunning ? t.home.console : t.home.log}
              </button>
            )}
          </div>
          {/* Secondary row: MODS · SRV · Edit · Folder */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onMods}
              style={{
                fontFamily: "'VT323',monospace", fontSize: 13, letterSpacing: '.06em',
                color: 'var(--ink-2)', flex: 1,
                background: 'var(--surface-2)', border: `1px solid ${updateCount > 0 ? 'var(--gold)' : 'var(--border-r)'}`,
                borderRadius: 3, height: 32, cursor: 'pointer', position: 'relative',
              }}
            >
              {t.home.mods}
              {updateCount > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -5,
                  background: 'var(--gold)', color: '#000',
                  fontSize: 9, fontFamily: 'sans-serif', fontWeight: 700,
                  borderRadius: 8, padding: '1px 4px', lineHeight: 1.4,
                }}>
                  {updateCount}
                </span>
              )}
            </button>
            <button
              onClick={onServers}
              style={{
                fontFamily: "'VT323',monospace", fontSize: 13, letterSpacing: '.06em',
                color: 'var(--ink-2)', flex: 1,
                background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                borderRadius: 3, height: 32, cursor: 'pointer',
              }}
            >
              {t.home.srv}
            </button>
            <button
              onClick={onEdit}
              style={{
                fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', flex: 1,
                background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                borderRadius: 3, height: 32, cursor: 'pointer',
              }}
            >
              {t.home.edit}
            </button>
            <button
              onClick={onOpenFolder}
              title="Open instance folder"
              style={{
                width: 32, height: 32, flexShrink: 0,
                background: 'var(--surface-2)', border: '1px solid var(--border-r)',
                borderRadius: 3, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14,
              }}
            >
              📁
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


function EmptyState({ onOpen }: { onOpen: () => void }) {
  const t = useT()
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
      <p style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', margin: '0 0 6px' }}>{t.home.emptyTitle}</p>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '0 0 20px', maxWidth: 320, marginInline: 'auto' }}>
        {t.home.emptyDesc}
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
        {t.home.emptyBtn}
      </button>
    </div>
  )
}

function CrashReportModal({ instanceName, text, onClose, onOpenConsole }: { instanceName: string; text: string; onClose: () => void; onOpenConsole: () => void }) {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: '72vw', maxWidth: 860, height: '75vh', background: '#0d0d0d', border: '1px solid rgba(217,59,59,.6)', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(217,59,59,.3)', background: 'rgba(217,59,59,.08)', flexShrink: 0 }}>
          <div>
            <span style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: '#ff6b6b', letterSpacing: '.1em' }}>{t.home.crashTitle}</span>
            <span style={{ fontSize: 12, color: 'var(--ink-4)', marginLeft: 12 }}>{instanceName}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onOpenConsole} style={{ height: 30, padding: '0 12px', fontSize: 11, fontWeight: 700, background: 'var(--surface-2)', color: 'var(--ink)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer' }}>{t.home.viewConsole}</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
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
          <div style={{ fontFamily: "'VT323',monospace", fontSize: 22, color: 'var(--accent)', letterSpacing: '.06em', marginBottom: 14 }}>{current.title}</div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '0 0 24px' }}>{current.body}</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{current.footer}</div>
        </div>
      </div>
    </div>
  )
}

const primaryBtnStyle: React.CSSProperties = {
  height: 36, padding: '0 18px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 700,
  boxShadow: 'inset 0 -2px 0 var(--accent-lo)',
}
const secondaryBtnStyle: React.CSSProperties = {
  height: 36, padding: '0 14px', background: 'var(--surface-2)', color: 'var(--ink)',
  border: '1px solid var(--border-r)', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
}

function ConsoleModal({ instanceName, lines, onClose }: { instanceName: string; lines: string[]; onClose: () => void }) {
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
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--grass)', letterSpacing: '.1em' }}>
            {t.home.consoleTitle(instanceName)}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 440, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: 'var(--gold)', letterSpacing: '.08em' }}>{t.home.licenseTitle}</span>
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
              onClick={() => window.open('https://www.minecraft.net/en-us/get-minecraft')}
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
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [mcVersions, setMcVersions] = useState<MinecraftVersion[]>([])
  const [consoleLogs, setConsoleLogs] = useState<Map<string, string[]>>(new Map())
  const [consoleOpen, setConsoleOpen] = useState<string | null>(null)
  const [modsTarget, setModsTarget] = useState<Instance | null>(null)
  const [serversTarget, setServersTarget] = useState<Instance | null>(null)
  const [updateCounts, setUpdateCounts] = useState<Map<string, number>>(new Map())
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [javas, setJavas] = useState<import('@refract/core').JavaInstallation[]>([])
  const [jarToast, setJarToast] = useState<string | null>(null)
  const [whatsNew, setWhatsNew] = useState<ChangelogEntry[]>(FALLBACK_WHATS_NEW)
  const [fileImport, setFileImport] = useState<{ importId: string; step: string; percent: number; name: string } | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<number | null>(null)
  const [crashReport, setCrashReport] = useState<{ instanceId: string; text: string } | null>(null)
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [noLicenseTarget, setNoLicenseTarget] = useState<Instance | null>(null)

  const queryClient = useQueryClient()
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

  // Fetch releases from GitHub
  useEffect(() => {
    fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then(r => r.ok ? r.json() as Promise<GitHubRelease[]> : Promise.reject())
      .then(releases => {
        const entries = releasesToChangelog(releases)
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

  // Background mod update check whenever instances load
  useEffect(() => {
    if (instances.length === 0) return
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
  }, [instances])

  function dismissOnboarding() {
    setOnboardingStep(null)
    api.config.set('onboardingDone', true).catch(() => {})
  }

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
        api.mc.crashReport(instanceId)
          .then(text => {
            if (text) {
              setCrashReport({ instanceId, text })
            } else {
              setLaunchToast(`Minecraft exited with code ${code}. Check the Console for details.`)
              setTimeout(() => setLaunchToast(null), 6000)
            }
          })
          .catch(() => {
            setLaunchToast(`Minecraft exited with code ${code}. Check the Console for details.`)
            setTimeout(() => setLaunchToast(null), 6000)
          })
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

  const groups = [...new Set(instances.map(i => i.groupId).filter(Boolean) as string[])].sort()
  const isGroupedView = carouselTab === 'all' && groups.length > 0

  const tabInstances = (() => {
    let base = instances
    if (searchQuery) base = base.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Greeting + clock */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 2 }}>{greeting(t)}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', lineHeight: 1 }}>
            <span style={{ color: 'var(--accent)' }}>{activeAccount?.username ?? 'Guest'}</span>
          </div>
          <div style={{ fontSize: 11, color: hasProfile && canPlayMinecraft ? 'var(--grass)' : 'var(--gold)', marginTop: 5 }}>
            {hasProfile && canPlayMinecraft
              ? t.home.playEnabled
              : hasProfile
              ? t.home.licenseRequired
              : t.home.signInToPlay}
          </div>
        </div>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 22, color: 'var(--ink-4)', letterSpacing: '.08em', lineHeight: 1 }}>
          {timeStr}
        </div>
      </div>

      {/* Instance carousel */}
      <div>
        {/* Search + group filter row */}
        {instances.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setCarouselPage(0) }}
              placeholder="Search instances…"
              style={{
                height: 28, padding: '0 10px', background: 'var(--bg)',
                border: '1px solid var(--border-r)', borderRadius: 3,
                color: 'var(--ink)', fontSize: 12, outline: 'none', width: 180,
              }}
            />
          </div>
        )}

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{t.home.yourInstances}</span>
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
                }}
              >
                {tab === 'recent' ? t.home.recent : tab === 'pinned' ? t.home.pinned : t.home.all}
              </button>
            ))}
          </div>

          {instances.length > 0 && (
            <div style={{ display: 'flex', gap: 4 }}>
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
              <button
                onClick={() => setCreateOpen(true)}
                style={{
                  marginLeft: isGroupedView ? 0 : 4,
                  fontSize: 11, fontWeight: 600,
                  color: 'var(--ink-2)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-r)',
                  borderRadius: 3,
                  padding: '3px 10px',
                  cursor: 'pointer',
                }}
              >
                {t.home.newBtn}
              </button>
            </div>
          )}
        </div>

        {/* Cards */}
        {isLoading ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
            {t.home.loading}
          </div>
        ) : instances.length === 0 ? (
          <EmptyState onOpen={() => setCreateOpen(true)} />
        ) : isGroupedView ? (
          (() => {
            const filtered = searchQuery
              ? instances.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
              : instances
            const sections: Array<{ key: string; title: string; items: Instance[] }> = groups
              .map(g => ({ key: g, title: g, items: filtered.filter(i => i.groupId === g) }))
              .filter(s => s.items.length > 0)
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
                  return (
                    <div key={section.key}>
                      <button
                        onClick={() => setCollapsedGroups(prev => {
                          const next = new Set(prev)
                          if (next.has(section.key)) next.delete(section.key)
                          else next.add(section.key)
                          return next
                        })}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0',
                          background: 'none', border: 'none', borderBottom: '1px solid var(--line)',
                          cursor: 'pointer', width: '100%', marginBottom: isCollapsed ? 0 : 10,
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
                      {!isCollapsed && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                          {section.items.map(inst => {
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
                                    setJarToast(`Mod installed to "${inst.name}"`)
                                  } catch (e) {
                                    setJarToast(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
                                  }
                                  setTimeout(() => setJarToast(null), 3500)
                                }}
                                blockReason={!hasProfile ? 'no-profile' : !canPlayMinecraft ? 'no-license' : null}
                                isRunning={runningIds.has(inst.id)}
                                hasLogs={(consoleLogs.get(inst.id)?.length ?? 0) > 0}
                                updateCount={updateCounts.get(inst.id) ?? 0}
                                javaOk={javaOk}
                              />
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
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: 'var(--ink-4)', letterSpacing: '.08em' }}>
              {carouselTab === 'pinned' ? t.home.noPinned : t.home.nothingHere}
            </div>
            {carouselTab === 'pinned' && (
              <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.home.pinHint}</div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
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
                      setJarToast(`Mod installed to "${inst.name}"`)
                    } catch (e) {
                      setJarToast(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
                    }
                    setTimeout(() => setJarToast(null), 3500)
                  }}
                  blockReason={!hasProfile ? 'no-profile' : !canPlayMinecraft ? 'no-license' : null}
                  isRunning={runningIds.has(inst.id)}
                  hasLogs={(consoleLogs.get(inst.id)?.length ?? 0) > 0}
                  updateCount={updateCounts.get(inst.id) ?? 0}
                  javaOk={javaOk}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Bottom panels */}
      {instances.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* What's New */}
          <Panel title={t.home.whatsNew}>
            {whatsNew.slice(0, 4).map(item => (
              <div key={item.version} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--accent)', letterSpacing: '.06em' }}>v{item.version}</span>
                  {item.date && <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>{item.date}</span>}
                </div>
                <ul style={{ margin: '3px 0 0', paddingLeft: 14, listStyle: 'disc' }}>
                  {item.notes.slice(0, 3).map((n, i) => (
                    <li key={i} style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.5 }}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
          </Panel>

          {/* Activity */}
          <Panel title={t.home.activity}>
            {activity.length === 0 ? (
              <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>
                {t.home.noActivity}
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
          await deleteInstance.mutateAsync(id)
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
        onDuplicate={async (id) => {
          const inst = instances.find(i => i.id === id)
          await api.instance.duplicate(id)
          void queryClient.invalidateQueries({ queryKey: ['instances'] })
          if (inst) void recordActivity(`Duplicated "${inst.name}"`)
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
            <div style={{ fontFamily:"'VT323',monospace", fontSize:20, color:'var(--accent)', letterSpacing:'.1em' }}>{t.home.importingModpack}</div>
            <div style={{ fontSize:13, color:'var(--ink-2)', fontWeight:600 }}>{fileImport.name}</div>
            <div>
              <div style={{ fontSize:12, color:'var(--ink-3)', marginBottom:8 }}>{fileImport.step}</div>
              <div style={{ height:8, background:'var(--surface-2)', border:'1px solid var(--border-r)' }}>
                <div style={{ height:'100%', width:`${fileImport.percent}%`, background:'var(--accent)', transition:'width 200ms linear', boxShadow:'inset 0 -2px 0 var(--accent-lo), inset 0 2px 0 var(--accent-hi)' }} />
              </div>
              <div style={{ fontFamily:"'VT323',monospace", fontSize:13, color:'var(--ink-4)', marginTop:4, textAlign:'right' }}>{Math.round(fileImport.percent)}%</div>
            </div>
            <div style={{ fontSize:11, color:'var(--ink-4)', textAlign:'center', lineHeight:1.4 }}>{t.home.downloadingFiles}</div>
          </div>
        </div>
      )}

      <InstanceModsDialog
        instance={modsTarget}
        open={modsTarget !== null}
        onOpenChange={(v) => { if (!v) setModsTarget(null) }}
        onUpdateApplied={(instanceId) => {
          api.modrinth.checkModUpdates(instanceId)
            .then(updates => setUpdateCounts(prev => { const next = new Map(prev); next.set(instanceId, updates.filter(u => u.hasUpdate).length); return next }))
            .catch(() => {})
        }}
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
            instanceName={inst?.name ?? crashReport.instanceId}
            text={crashReport.text}
            onClose={() => setCrashReport(null)}
            onOpenConsole={() => { setCrashReport(null); setConsoleOpen(crashReport.instanceId) }}
          />
        )
      })()}

      {noLicenseTarget && (
        <NoLicenseModal
          instanceName={noLicenseTarget.name}
          onClose={() => setNoLicenseTarget(null)}
        />
      )}

      {onboardingStep !== null && (
        <OnboardingModal
          step={onboardingStep}
          onNext={() => setOnboardingStep(s => s !== null ? Math.min(s + 1, 2) : null)}
          onClose={dismissOnboarding}
          onAddAccount={dismissOnboarding}
          onNewInstance={() => { dismissOnboarding(); setCreateOpen(true) }}
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
