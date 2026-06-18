import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useMemo } from 'react'
import type React from 'react'
import { SearchIcon } from '@/components/ui/BlockIcons'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { htmlToText } from '@/lib/sanitize'
import type { ModrinthProject, ModrinthVersion, ModrinthSortIndex, Instance, CFProject, CFFile, CFProjectDetail, ResolvedDep } from '@refract/core'
import { useScrollLock } from '@/lib/use-scroll-lock'
import { useT } from '@/i18n'

export const Route = createFileRoute('/browse/')({
  component: Browse,
})

const CATEGORIES = ['All', 'Performance', 'Utility', 'Magic', 'Technology', 'Adventure', 'Decoration']
const LOADERS = ['All', 'fabric', 'forge', 'quilt', 'neoforge']
const SORT_OPTIONS: Array<{ label: string; value: ModrinthSortIndex }> = [
  { label: 'Most Downloaded',  value: 'downloads' },
  { label: 'Most Followed',    value: 'follows'   },
  { label: 'Newest',           value: 'newest'    },
  { label: 'Recently Updated', value: 'updated'   },
  { label: 'Relevance',        value: 'relevance' },
]
const LOADER_COLOR: Record<string, string> = {
  fabric: '#b8a892', forge: '#4b8fc4', quilt: '#b070b0', neoforge: '#e8883c',
}

interface ModrinthProjectDetail {
  id: string
  slug: string
  title: string
  description: string
  body: string
  categories: string[]
  client_side: string
  server_side: string
  downloads: number
  followers: number
  icon_url: string | null
  gallery: Array<{ url: string; featured: boolean; title?: string; description?: string }>
  game_versions: string[]
  loaders: string[]
  issues_url?: string | null
  source_url?: string | null
  discord_url?: string | null
  published?: string
  updated?: string
}

function stripMarkdown(text: string): string {
  const md = (text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[​-‍﻿‎‏]/g, '')
  return htmlToText(md).trim()
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

function bestVersionForInstance(versions: ModrinthVersion[], instance: Instance): ModrinthVersion | null {
  const mcVer = instance.minecraftVersion
  const loader = instance.modLoader?.toLowerCase()
  const exact = versions.filter(v =>
    v.game_versions.includes(mcVer) && (!loader || v.loaders.some(l => l.toLowerCase() === loader))
  )
  if (exact.length > 0) return exact[0]
  const mcOnly = versions.filter(v => v.game_versions.includes(mcVer))
  if (mcOnly.length > 0) return mcOnly[0]
  return null
}

function versionCompatibility(v: ModrinthVersion, instance: Instance | null): 'compatible' | 'partial' | 'incompatible' {
  if (!instance) return 'compatible'
  const mcOk = v.game_versions.includes(instance.minecraftVersion)
  const loader = instance.modLoader?.toLowerCase()
  const loaderOk = !loader || v.loaders.some(l => l.toLowerCase() === loader)
  if (mcOk && loaderOk) return 'compatible'
  if (mcOk && !loaderOk) return 'partial'
  return 'incompatible'
}

// ─── VersionDropdown ──────────────────────────────────────────────────────────

function InstanceDropdown({ instances, value, onChange }: {
  instances: Instance[]
  value: Instance | null
  onChange: (inst: Instance | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button variant={value ? 'outline' : 'secondary'} onClick={() => setOpen(o => !o)} style={{
        gap: 6,
        fontSize: 12,
        color: value ? 'var(--ink)' : 'var(--ink-4)',
        background: value ? 'var(--accent-tint)' : 'var(--surface)',
        border: `1px solid ${value ? 'var(--accent)' : 'var(--border-r)'}`,
        borderRadius: 'var(--radius-sm)', padding: '4px 10px', whiteSpace: 'nowrap',
      }}>
        {value
          ? <><span style={{ color: 'var(--ink-4)', fontSize: 10, fontWeight: 400 }}>instance:</span> {value.name}</>
          : 'Check against instance…'}
        <span style={{ fontSize: 9, opacity: .7 }}>{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)',
          minWidth: 220, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          <Button variant="ghost" onClick={() => { onChange(null); setOpen(false) }} style={{
            width: '100%', justifyContent: 'flex-start',
            padding: '8px 14px', textAlign: 'left', borderRadius: 0, borderBottom: '1px solid var(--line)',
            fontSize: 12, fontWeight: 500, color: !value ? 'var(--accent)' : 'var(--ink-3)',
            background: !value ? 'var(--accent-tint)' : 'transparent',
          }}>
            None (show all)
          </Button>
          {instances.map(inst => (
            <Button variant="ghost" key={inst.id} onClick={() => { onChange(inst); setOpen(false) }} style={{
              width: '100%', justifyContent: 'flex-start',
              padding: '8px 14px', textAlign: 'left', borderRadius: 0,
              fontSize: 12, fontWeight: 500,
              color: value?.id === inst.id ? 'var(--accent)' : 'var(--ink-2)',
              background: value?.id === inst.id ? 'var(--accent-tint)' : 'transparent',
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
            }}>
              <span>{inst.name}</span>
              <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.04em' }}>
                MC {inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}
              </span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function SortDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [])

  const current = SORT_OPTIONS.find(o => o.value === value) ?? SORT_OPTIONS[0]

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button variant="secondary" onClick={() => setOpen(o => !o)} style={{
        gap: 6,
        fontSize: 12, color: 'var(--ink)',
        background: 'var(--surface)', border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius-sm)', padding: '4px 10px', whiteSpace: 'nowrap',
      }}>
        {current.label}
        <span style={{ fontSize: 9, opacity: .7 }}>{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)',
          minWidth: 180, display: 'flex', flexDirection: 'column',
        }}>
          {SORT_OPTIONS.map(opt => (
            <Button variant="ghost" key={opt.value} onClick={() => { onChange(opt.value); setOpen(false) }} style={{
              width: '100%', justifyContent: 'flex-start',
              padding: '8px 14px', textAlign: 'left', borderRadius: 0,
              fontSize: 12, fontWeight: 500,
              color: value === opt.value ? 'var(--accent)' : 'var(--ink-2)',
              background: value === opt.value ? 'var(--accent-tint)' : 'transparent',
            }}>{opt.label}</Button>
          ))}
        </div>
      )}
    </div>
  )
}

function VersionDropdown({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function toggle() {
    if (!open && versions.length === 0) {
      setLoading(true)
      api.modrinth.gameVersions()
        .then(list => setVersions(list.map(v => v.version)))
        .catch(() => setVersions([]))
        .finally(() => setLoading(false))
    }
    setOpen(o => !o)
  }

  const active = value !== null
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button
        variant={active ? 'outline' : 'secondary'}
        onClick={toggle}
        style={{
          gap: 5,
          fontWeight: 500,
          fontSize: active ? 12 : 11,
          fontFamily: active ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
          letterSpacing: active ? '.04em' : 'inherit',
          color: active ? 'var(--diamond)' : 'var(--ink-4)',
          background: active ? 'rgba(79,184,232,.12)' : 'var(--surface)',
          border: `1px solid ${active ? 'var(--diamond)' : 'var(--border-r)'}`,
          borderRadius: 'var(--radius-sm)', padding: '3px 10px',
        } as React.CSSProperties}
      >
        {active ? `MC ${value}` : t.browse.allVersions}
        <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)',
          width: 140, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          <Button
            variant="ghost"
            onClick={() => { onChange(null); setOpen(false) }}
            style={{
              width: '100%', justifyContent: 'flex-start',
              padding: '7px 12px', textAlign: 'left', fontSize: 12, fontWeight: 500,
              color: value === null ? 'var(--accent)' : 'var(--ink-3)',
              background: value === null ? 'var(--accent-tint)' : 'transparent',
              borderRadius: 0, borderBottom: '1px solid var(--line)',
            }}
          >
            {t.browse.allVersions}
          </Button>
          {loading ? (
            <div style={{ padding: '12px', fontSize: 11, color: 'var(--ink-4)', textAlign: 'center' }}>{t.browse.loading}</div>
          ) : (
            versions.map(ver => (
              <Button
                variant="ghost"
                key={ver}
                onClick={() => { onChange(ver); setOpen(false) }}
                style={{
                  width: '100%', justifyContent: 'flex-start',
                  padding: '6px 12px', textAlign: 'left',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, fontWeight: 500, letterSpacing: '.04em',
                  color: value === ver ? 'var(--diamond)' : 'var(--ink-2)',
                  background: value === ver ? 'rgba(79,184,232,.12)' : 'transparent',
                  borderRadius: 0,
                }}
              >
                {ver}
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ─── DepsModal ────────────────────────────────────────────────────────────────

interface DepsTarget {
  instanceId: string
  mainName: string
  mainKey: string                 // for the tile install spinner
  deps: ResolvedDep[]
  install: () => Promise<void>     // installs the main mod itself
}

function DepsModal({ target, onClose, onConfirm, onSkip }: {
  target: DepsTarget
  onClose: () => void
  onConfirm: (selectedOptionalKeys: Set<string>) => void
  onSkip: () => void
}) {
  useScrollLock()
  const requiredMissing = target.deps.filter(d => d.type === 'required' && !d.alreadyInstalled)
  const optional        = target.deps.filter(d => d.type === 'optional' && !d.alreadyInstalled)
  const already         = target.deps.filter(d => d.alreadyInstalled)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setPicked(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  const total = requiredMissing.length + picked.size

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 91, background: 'rgba(0,0,0,.60)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', width: 480, maxHeight: '74vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-floating)' }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Dependencies</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
              Installing <strong style={{ color: 'var(--ink)' }}>{target.mainName}</strong>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {requiredMissing.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 2 }}>Required ({requiredMissing.length})</div>
              {requiredMissing.map(dep => (
                <div key={dep.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'var(--accent-tint)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: 'var(--accent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.2 2.2L8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{dep.name}</span>
                </div>
              ))}
            </>
          )}
          {optional.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginTop: requiredMissing.length > 0 ? 8 : 2, marginBottom: 2 }}>Optional ({optional.length})</div>
              {optional.map(dep => {
                const on = picked.has(dep.key)
                return (
                  <button key={dep.key} onClick={() => toggle(dep.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: on ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: on ? 'var(--accent)' : 'var(--bg)', border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      {on && <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.2 2.2L8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>{dep.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-4)' }}>optional</span>
                  </button>
                )
              })}
            </>
          )}
          {already.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginTop: 8, marginBottom: 2 }}>Already installed ({already.length})</div>
              {already.map(dep => (
                <div key={dep.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', opacity: 0.7 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-4)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{dep.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--grass)', border: '1px solid var(--grass)', borderRadius: 'var(--radius-sm)', padding: '0 4px' }}>✓ installed</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={onSkip} style={{ fontSize: 12, color: 'var(--ink-3)', padding: '0 16px', height: 32 }}>Just this mod</Button>
          <Button variant="primary" onClick={() => onConfirm(picked)} style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', padding: '0 24px', height: 36 }}>
            Install{total > 0 ? ` (+${total})` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── InstallModal ─────────────────────────────────────────────────────────────

interface InstallModalProps {
  mod: ModrinthProject
  instances: Instance[]
  onClose: () => void
  onInstall: (instanceId: string, version: ModrinthVersion) => void
}

function InstallModal({ mod, instances, onClose, onInstall }: InstallModalProps) {
  useScrollLock()
  const t = useT()
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [installedInstanceIds, setInstalledInstanceIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    setLoadingVersions(true)
    api.modrinth.versions(mod.project_id)
      .then(v => { setVersions(v); setLoadingVersions(false) })
      .catch(() => setLoadingVersions(false))
  }, [mod.project_id])

  useEffect(() => {
    if (!selectedInstance || versions.length === 0) return
    const best = bestVersionForInstance(versions, selectedInstance)
    if (best) setSelectedVersionId(best.id)
  }, [selectedInstance, versions])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const installed = await Promise.all(instances.map(async inst => {
        const recorded = inst.mods?.find(m => m.projectId === mod.project_id && (!m.contentType || m.contentType === 'mod'))
        if (!recorded?.fileName) return null
        const entries = await api.mods.list(inst.id).catch(() => [])
        const present = entries.some(entry =>
          entry.type === 'mod'
          && (entry.filename === recorded.fileName || entry.filename === `${recorded.fileName}.disabled`),
        )
        return present ? inst.id : null
      }))
      if (!cancelled) setInstalledInstanceIds(new Set(installed.filter((id): id is string => id !== null)))
    })()
    return () => { cancelled = true }
  }, [instances, mod.project_id])

  const canInstall = selectedInstance !== null && selectedVersionId !== null

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', width: 680, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-floating)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {mod.icon_url && (
            <img src={mod.icon_url} alt="" style={{ width: 32, height: 32, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.1em' }}>{t.browse.installMod}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{mod.title}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>
              {t.browse.selectInstance}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {instances.length === 0 ? (
                <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>{t.browse.noInstances}</div>
              ) : instances.map(inst => {
                const active = selectedInstance?.id === inst.id
                const alreadyHas = installedInstanceIds.has(inst.id)
                return (
                  <Button variant="secondary" key={inst.id} onClick={() => setSelectedInstance(inst)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, background: active ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{inst.name}</span>
                      {alreadyHas && <span style={{ fontSize: 9, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', padding: '0 3px', flexShrink: 0 }}>✓</span>}
                    </div>
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
                      {inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}
                    </div>
                  </Button>
                )
              })}
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
              {t.browse.selectVersion}
              {selectedInstance && (
                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em', textTransform: 'none', fontWeight: 400 }}>
                  {t.browse.forInstance(selectedInstance.minecraftVersion, selectedInstance.modLoader?.toUpperCase() ?? 'VANILLA')}
                </span>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {loadingVersions ? (
                <div style={{ padding: '30px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.browse.loadingVersions}</div>
              ) : versions.length === 0 ? (
                <div style={{ padding: '30px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.browse.noVersions}</div>
              ) : versions.map(v => {
                const compat = versionCompatibility(v, selectedInstance)
                const isBest = selectedInstance ? bestVersionForInstance(versions, selectedInstance)?.id === v.id : false
                const isSelected = selectedVersionId === v.id
                const dimmed = compat === 'incompatible' && !isSelected
                return (
                  <Button variant="secondary" key={v.id} onClick={() => setSelectedVersionId(v.id)} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, background: isBest ? 'rgba(91,156,58,.12)' : isSelected ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isBest ? 'var(--grass)' : isSelected ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', opacity: dimmed ? 0.45 : 1 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{v.version_number}</span>
                        {isBest && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: '#fff', background: 'var(--grass)', padding: '0 5px', borderRadius: 'var(--radius-sm)' }}>{t.browse.recommended}</span>}
                        {compat === 'partial' && !isBest && <span style={{ fontSize: 10, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 'var(--radius-sm)', padding: '0 4px' }}>{t.browse.loaderMismatch}</span>}
                        {compat === 'incompatible' && <span style={{ fontSize: 10, color: 'var(--redstone)', border: '1px solid var(--redstone)', borderRadius: 'var(--radius-sm)', padding: '0 4px' }}>{t.browse.incompatible}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span>{v.game_versions.slice(0, 3).join(', ')}{v.game_versions.length > 3 ? '…' : ''}</span>
                        <span>·</span>
                        <span>{v.loaders.join(', ')}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--ink-4)' }}>↓ {formatDownloads(v.downloads)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>{formatDate(v.date_published)}</div>
                    </div>
                  </Button>
                )
              })}
            </div>
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            {!selectedInstance && t.browse.selectInstanceHint}
            {selectedInstance && !selectedVersionId && t.browse.selectVersionHint}
            {canInstall && t.browse.installingTo(selectedInstance!.name)}
          </div>
          <Button
            variant="primary"
            disabled={!canInstall}
            onClick={() => {
              if (!canInstall) return
              const ver = versions.find(v => v.id === selectedVersionId)
              if (ver) onInstall(selectedInstance!.id, ver)
            }}
            style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', padding: '0 28px', height: 36 }}
          >
            {t.browse.install}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── ModDetailModal ───────────────────────────────────────────────────────────

function ModDetailModal({ mod, onClose, onInstall }: {
  mod: ModrinthProject
  onClose: () => void
  onInstall: () => void
}) {
  useScrollLock()
  const t = useT()
  const [detail, setDetail] = useState<ModrinthProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (galleryIndex !== null) setGalleryIndex(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, galleryIndex])

  useEffect(() => {
    setLoading(true)
    fetch(`https://api.modrinth.com/v2/project/${mod.project_id}`, {
      headers: { 'User-Agent': 'Refract/1.0 (github.com/ShevRuslan1)', Accept: 'application/json' },
    })
      .then(r => r.ok ? r.json() as Promise<ModrinthProjectDetail> : null)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [mod.project_id])

  const gallery = detail?.gallery ?? []
  const loaders = detail?.loaders ?? mod.loaders ?? []
  const gameVersions = detail?.game_versions ?? mod.game_versions ?? []
  const followers = detail?.followers ?? mod.follows
  const modrinthUrl = `https://modrinth.com/mod/${mod.slug ?? mod.project_id}`

  const bodyText = detail?.body ? stripMarkdown(detail.body) : mod.description

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '86vw', maxWidth: 960, maxHeight: '90vh', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-floating)' }}>

        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
          {mod.icon_url ? (
            <img src={mod.icon_url} alt="" style={{ width: 72, height: 72, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }} />
          ) : (
            <div style={{ width: 72, height: 72, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: 'var(--ink-4)' }}>
              {mod.title[0]}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>{mod.title}</div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ink-3)', flexWrap: 'wrap', marginBottom: 5 }}>
              <span>↓ {formatDownloads(mod.downloads)} downloads</span>
              {followers != null && <span>♥ {formatDownloads(followers)} followers</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {loaders.map(l => (
                <Tag key={l} color={LOADER_COLOR[l] ?? 'var(--ink-4)'}>{l}</Tag>
              ))}
              {gameVersions.length > 0 && (
                <Tag color="var(--diamond)">
                  MC {gameVersions[0]}{gameVersions.length > 1 ? ` – ${gameVersions[gameVersions.length - 1]}` : ''}
                </Tag>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-start' }}>
            <Button
              variant="outline"
              onClick={() => { void api.external.open(modrinthUrl) }}
              style={{ height: 32, padding: '0 14px', fontSize: 12, color: 'var(--accent)', border: '1px solid var(--accent)' }}
            >
              {t.browse.modrinth}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 20, lineHeight: 1 }}>✕</Button>
          </div>
        </div>

        {/* Gallery */}
        {gallery.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 22px', overflowX: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
            {gallery.map((img, i) => (
              <div
                key={i}
                onClick={() => setGalleryIndex(i)}
                style={{ flexShrink: 0, cursor: 'pointer', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border-r)', height: 130 }}
              >
                <img
                  src={img.url}
                  alt={img.title ?? ''}
                  style={{ height: '100%', width: 'auto', display: 'block', objectFit: 'cover' }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
          {/* Description */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
            {loading ? (
              <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>{t.browse.loadingDetails}</div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap' }}>
                {bodyText}
              </p>
            )}
          </div>

          {/* Sidebar */}
          <div style={{ width: 210, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Categories */}
            {mod.categories.length > 0 && (
              <div>
                <SideLabel>{t.browse.categories}</SideLabel>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                  {mod.categories.map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
                </div>
              </div>
            )}

            {/* Environment */}
            {detail && (
              <div>
                <SideLabel>{t.browse.environment}</SideLabel>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t.browse.client}</span>
                    <span style={{ color: detail.client_side === 'required' ? 'var(--grass)' : detail.client_side === 'unsupported' ? 'var(--lava)' : 'var(--gold)' }}>
                      {detail.client_side}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t.browse.server}</span>
                    <span style={{ color: detail.server_side === 'required' ? 'var(--grass)' : detail.server_side === 'unsupported' ? 'var(--lava)' : 'var(--gold)' }}>
                      {detail.server_side}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Dates */}
            {detail?.published && (
              <div>
                <SideLabel>{t.browse.published}</SideLabel>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>{formatDate(detail.published)}</div>
                {detail.updated && <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{t.browse.updatedOn(formatDate(detail.updated))}</div>}
              </div>
            )}

            {/* Links */}
            {detail && (detail.issues_url || detail.source_url || detail.discord_url) && (
              <div>
                <SideLabel>{t.browse.links}</SideLabel>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {detail.issues_url && (
                    <Button variant="ghost" onClick={() => { void api.external.open(detail.issues_url!) }} style={{ fontSize: 11, color: 'var(--accent)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>
                      🐛 Issues ↗
                    </Button>
                  )}
                  {detail.source_url && (
                    <Button variant="ghost" onClick={() => { void api.external.open(detail.source_url!) }} style={{ fontSize: 11, color: 'var(--accent)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>
                      {'</>'} Source ↗
                    </Button>
                  )}
                  {detail.discord_url && (
                    <Button variant="ghost" onClick={() => { void api.external.open(detail.discord_url!) }} style={{ fontSize: 11, color: 'var(--accent)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>
                      💬 Discord ↗
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Install CTA */}
            <div style={{ marginTop: 'auto', paddingTop: 10 }}>
              <Button
                variant="primary"
                onClick={onInstall}
                style={{ width: '100%', height: 36, fontSize: 13, fontWeight: 700, letterSpacing: '.04em' }}
              >
                {t.browse.install}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {galleryIndex !== null && gallery[galleryIndex] && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { e.stopPropagation(); setGalleryIndex(null) }}
        >
          <img
            src={gallery[galleryIndex].url}
            alt=""
            style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-r)' }}
            onClick={e => e.stopPropagation()}
          />
          {gallery.length > 1 && (
            <>
              <Button
                variant="ghost"
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i - 1 + gallery.length) % gallery.length : 0) }}
                style={{ position: 'absolute', left: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44 }}
              >
                ‹
              </Button>
              <Button
                variant="ghost"
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i + 1) % gallery.length : 0) }}
                style={{ position: 'absolute', right: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44 }}
              >
                ›
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setGalleryIndex(null)}
            style={{ position: 'absolute', top: 16, right: 20, fontSize: 22, color: '#fff' }}
          >
            ✕
          </Button>
        </div>
      )}
    </div>
  )
}

function SideLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
      {children}
    </div>
  )
}

// ─── Browse ───────────────────────────────────────────────────────────────────

function Browse() {
  const t = useT()
  const [source, setSource] = useState<'mr' | 'cf'>('mr')
  const [cfApiKey, setCfApiKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [loader, setLoader] = useState('All')
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const filtersRestoredRef = useRef(false)
  const [sort, setSort] = useState<ModrinthSortIndex>('downloads')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [cfResults, setCfResults] = useState<CFProject[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const LIMIT = 18

  const [instances, setInstances] = useState<Instance[]>([])
  const [activeInstance, setActiveInstance] = useState<Instance | null>(null)
  const [downloadedIds, setDownloadedIds]   = useState<Set<string>>(new Set())
  const [updateIds, setUpdateIds]           = useState<Set<string>>(new Set())
  const [detailTarget, setDetailTarget] = useState<ModrinthProject | null>(null)
  const [installTarget, setInstallTarget] = useState<ModrinthProject | null>(null)
  const [cfInstallTarget, setCfInstallTarget] = useState<CFProject | null>(null)
  const [cfModDetail, setCfModDetail]         = useState<CFProject | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [depsTarget, setDepsTarget] = useState<DepsTarget | null>(null)

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Feature 3: suggested instance for empty-query recommendations
  const suggested = useMemo(() => {
    const recent = instances
      .filter(i => i.isInstalled && i.lastPlayed)
      .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''))
    const inst = recent[0]
    if (!inst) return null
    return { version: inst.minecraftVersion, loader: inst.modLoader ?? null, name: inst.name }
  }, [instances])

  useEffect(() => {
    api.instance.list().then(setInstances).catch(() => setInstances([]))
    api.config.get().then(cfg => setCfApiKey((cfg as { curseforgeApiKey?: string }).curseforgeApiKey ?? null)).catch(() => {})
  }, [])

  // Restore filters from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('refract.browse.filters')
      if (saved) {
        const { gameVersion: gv, loader: ld } = JSON.parse(saved) as { gameVersion: string | null; loader: string | null }
        if (gv !== undefined) setGameVersion(gv)
        if (ld !== undefined) setLoader(ld ?? 'All')
      }
    } catch { /* ignore */ }
    filtersRestoredRef.current = true
  }, [])

  // Save filters to localStorage when they change (skip the very first render before restore)
  useEffect(() => {
    if (!filtersRestoredRef.current) return
    try {
      localStorage.setItem('refract.browse.filters', JSON.stringify({ gameVersion, loader: loader === 'All' ? null : loader }))
    } catch { /* ignore */ }
  }, [gameVersion, loader])

  async function savedModProjectIds(instance: Instance | null): Promise<Set<string>> {
    if (!instance) return new Set()
    const entries = await api.mods.list(instance.id).catch(() => [])
    const installedFiles = new Set(entries
      .filter(entry => entry.type === 'mod')
      .flatMap(entry => entry.filename.endsWith('.disabled')
        ? [entry.filename, entry.filename.slice(0, -'.disabled'.length)]
        : [entry.filename, `${entry.filename}.disabled`]))
    return new Set((instance.mods ?? [])
      .filter(m =>
        (!m.contentType || m.contentType === 'mod')
        && !!m.fileName
        && installedFiles.has(m.fileName))
      .map(m => m.projectId))
  }

  // When instance changes: apply filters, then layer update scan results over the saved install records.
  useEffect(() => {
    let cancelled = false
    if (!activeInstance) {
      setDownloadedIds(new Set())
      setUpdateIds(new Set())
      return () => { cancelled = true }
    }
    setGameVersion(activeInstance.minecraftVersion)
    setLoader(activeInstance.modLoader ? activeInstance.modLoader.toLowerCase() : 'All')
    setOffset(0)

    void (async () => {
      const savedIds = await savedModProjectIds(activeInstance)
      if (cancelled) return
      setDownloadedIds(savedIds)
      setUpdateIds(new Set())

      // checkModUpdates scans actual jars and asks Modrinth which ones have newer versions.
      api.modrinth.checkModUpdates(activeInstance.id)
        .then(results => {
          if (cancelled) return
          setDownloadedIds(new Set([...savedIds, ...results.map(r => r.projectId)]))
          setUpdateIds(new Set(results.filter(r => r.hasUpdate).map(r => r.projectId)))
        })
        .catch(() => {
          if (cancelled) return
          setDownloadedIds(savedIds)
          setUpdateIds(new Set())
        })
    })()

    return () => { cancelled = true }
  }, [activeInstance?.id, activeInstance?.mods])

  async function refreshActiveModStatus(instanceId: string, instanceSnapshot: Instance | null = activeInstance) {
    const savedIds = await savedModProjectIds(instanceSnapshot)
    setDownloadedIds(savedIds)
    try {
      const results = await api.modrinth.checkModUpdates(instanceId)
      setDownloadedIds(new Set([...savedIds, ...results.map(r => r.projectId)]))
      setUpdateIds(new Set(results.filter(r => r.hasUpdate).map(r => r.projectId)))
    } catch {
      setDownloadedIds(savedIds)
      setUpdateIds(new Set())
    }
  }

  function getModStatus(mod: ModrinthProject): 'downloaded' | 'update' | 'incompatible' | null {
    if (!activeInstance) return null
    if (downloadedIds.has(mod.project_id)) return updateIds.has(mod.project_id) ? 'update' : 'downloaded'
    const mcOk = !mod.game_versions?.length || mod.game_versions.includes(activeInstance.minecraftVersion)
    const instLoader = activeInstance.modLoader?.toLowerCase()
    const loaderOk = !instLoader || !mod.loaders?.length || mod.loaders.some(l => l.toLowerCase() === instLoader)
    return (!mcOk || !loaderOk) ? 'incompatible' : null
  }

  function getCfModStatus(mod: CFProject): 'downloaded' | null {
    if (!activeInstance) return null
    return downloadedIds.has(`cf:${mod.id}`) ? 'downloaded' : null
  }

  useEffect(() => {
    if (source === 'cf' && !cfApiKey) return
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => doSearch(0), query ? 400 : 0)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category, loader, gameVersion, sort, source, cfApiKey, suggested])

  async function doSearch(newOffset: number) {
    setLoading(true)
    setOffset(newOffset)
    // Feature 3: when query is empty and user hasn't set filters, silently use suggested instance's version/loader
    const effectiveVersion = query === '' && gameVersion === null ? suggested?.version ?? null : gameVersion
    const effectiveLoader = query === '' && loader === 'All' ? (suggested?.loader ?? null) : (loader !== 'All' ? loader : null)
    try {
      if (source === 'cf' && cfApiKey) {
        const gameLoader = effectiveLoader ?? undefined
        const res = await api.curseforge.searchMods(query || undefined, effectiveVersion ?? undefined, gameLoader, LIMIT, newOffset)
        const cfRes = res as { data: CFProject[]; pagination: { totalCount: number } }
        setCfResults(cfRes.data)
        setTotal(cfRes.pagination.totalCount)
      } else {
        const res = await api.modrinth.searchContent({
          query: query || '',
          projectType: 'mod',
          gameVersion: effectiveVersion ?? undefined,
          loader: effectiveLoader ?? undefined,
          category: category !== 'All' ? category.toLowerCase() : undefined,
          sortIndex: sort,
          limit: LIMIT,
          offset: newOffset,
        })
        setResults(res.hits)
        setTotal(res.total_hits)
      }
    } catch (e) {
      showToast(`Search failed: ${e instanceof Error ? e.message : 'Unknown error'}`, false)
    } finally {
      setLoading(false)
    }
  }

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  // Install a single mod directly (no deps to resolve).
  async function installOne(key: string, run: () => Promise<void>, name: string) {
    setInstallingId(key)
    try {
      await run()
      showToast(`${name} installed successfully!`, true)
      const nextInstances = await api.instance.list().catch(() => null)
      if (nextInstances) {
        setInstances(nextInstances)
        if (activeInstance) {
          const nextActive = nextInstances.find(i => i.id === activeInstance.id) ?? activeInstance
          setActiveInstance(nextActive)
          await refreshActiveModStatus(activeInstance.id, nextActive)
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Install failed', false)
    } finally {
      setInstallingId(null)
    }
  }

  async function handleInstall(instanceId: string, version: ModrinthVersion) {
    if (!installTarget) return
    const modName = installTarget.title
    const mainProjectId = installTarget.project_id
    setInstallTarget(null)

    let deps: ResolvedDep[] = []
    try { deps = await api.mods.planDeps({ source: 'modrinth', instanceId, version }) } catch { /* resolve best-effort */ }
    const actionable = deps.some(d => (d.type === 'required' && !d.alreadyInstalled) || (d.type === 'optional' && !d.alreadyInstalled))
    const install = () => api.modrinth.install(instanceId, mainProjectId, modName, version.id)
    if (actionable) {
      setDepsTarget({ instanceId, mainName: modName, mainKey: mainProjectId, deps, install: async () => { await install() } })
    } else {
      await installOne(mainProjectId, async () => { await install() }, modName)
    }
  }

  async function handleCfInstall(instanceId: string, file: CFFile, displayName: string) {
    setCfInstallTarget(null)
    const key = `cf:${file.modId}`
    let deps: ResolvedDep[] = []
    try { deps = await api.mods.planDeps({ source: 'curseforge', instanceId, file }) } catch { /* best-effort */ }
    const actionable = deps.some(d => !d.alreadyInstalled)
    const install = () => api.curseforge.install(instanceId, file.modId, file.id, displayName)
    if (actionable) {
      setDepsTarget({ instanceId, mainName: displayName, mainKey: key, deps, install: async () => { await install() } })
    } else {
      await installOne(key, async () => { await install() }, displayName)
    }
  }

  // Install the chosen deps (required + selected optional) then the main mod.
  async function handleDepsConfirm(selectedOptional: Set<string>) {
    if (!depsTarget) return
    const { instanceId, mainName, mainKey, deps, install } = depsTarget
    setDepsTarget(null)
    setInstallingId(mainKey)
    const toInstall = deps.filter(d => !d.alreadyInstalled && (d.type === 'required' || selectedOptional.has(d.key)))
    try {
      for (const d of toInstall) {
        if (d.source === 'modrinth' && d.projectId) await api.modrinth.install(instanceId, d.projectId, d.name, d.versionId)
        else if (d.source === 'curseforge' && d.modId != null && d.fileId != null) await api.curseforge.install(instanceId, d.modId, d.fileId, d.name)
      }
      await install()
      const n = toInstall.length
      showToast(n > 0 ? `${mainName} + ${n} dependenc${n > 1 ? 'ies' : 'y'} installed!` : `${mainName} installed successfully!`, true)
      const nextInstances = await api.instance.list().catch(() => null)
      if (nextInstances) {
        setInstances(nextInstances)
        if (activeInstance) {
          const nextActive = nextInstances.find(i => i.id === activeInstance.id) ?? activeInstance
          setActiveInstance(nextActive)
          await refreshActiveModStatus(activeInstance.id, nextActive)
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Install failed', false)
    } finally {
      setInstallingId(null)
    }
  }

  async function handleDepsSkip() {
    if (!depsTarget) return
    const { mainName, mainKey, install } = depsTarget
    setDepsTarget(null)
    await installOne(mainKey, install, mainName)
  }

  const totalPages = Math.ceil(total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: '0 0 3px' }}>{t.browse.title}</h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>{t.browse.subtitle}</p>
        </div>
        {/* Source toggle */}
        <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', padding: 3, gap: 3, flexShrink: 0 }}>
          {(['mr', 'cf'] as const).map(src => (
            <Button
              variant="ghost"
              key={src}
              onClick={() => { setSource(src); setOffset(0); setResults([]); setCfResults([]) }}
              style={{
                height: 26, padding: '0 12px', fontSize: 11, fontWeight: 600,
                color: source === src ? '#fff' : 'var(--ink-3)',
                background: source === src ? (src === 'cf' ? 'var(--ender)' : 'var(--accent)') : 'transparent',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {src === 'mr' ? t.browse.sourceMr : t.browse.sourceCf}
            </Button>
          ))}
        </div>
      </div>

      {/* No API key notice */}
      {source === 'cf' && !cfApiKey ? (
        <div style={{ padding: '40px 24px', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '.04em', color: 'var(--ender)' }}>
            {t.browse.noApiKey}
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0, maxWidth: 400 }}>{t.browse.noApiKeyDesc}</p>
          <a
            href="#"
            onClick={e => { e.preventDefault(); window.location.hash = '/settings/' }}
            style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}
          >
            {t.browse.goToSettings}
          </a>
        </div>
      ) : (
        <>
          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', padding: '0 12px', height: 38 }}>
            <div style={{ color: 'var(--ink-4)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><SearchIcon /></div>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t.browse.searchPlaceholder}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: 'var(--ink)' }}
            />
            {query && <Button variant="ghost" size="icon" onClick={() => setQuery('')} style={{ color: 'var(--ink-4)', fontSize: 13 }}>✕</Button>}
          </div>

          {/* Instance selector */}
          {instances.length > 0 && (
            <InstanceDropdown
              instances={instances}
              value={activeInstance}
              onChange={inst => {
                if (!inst) {
                  setActiveInstance(null)
                  setGameVersion(null)
                  setLoader('All')
                } else {
                  setActiveInstance(inst)
                }
              }}
            />
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {source === 'mr' && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {CATEGORIES.map(cat => (
                  <FilterChip key={cat} active={category === cat} onClick={() => setCategory(cat)}>{cat}</FilterChip>
                ))}
              </div>
            )}
            {source === 'mr' && <div style={{ width: 1, height: 18, background: 'var(--border-r)' }} />}
            <VersionDropdown value={gameVersion} onChange={v => { setGameVersion(v); setOffset(0) }} />
            {source === 'mr' && <SortDropdown value={sort} onChange={s => { setSort(s as ModrinthSortIndex); setOffset(0) }} />}
            <div style={{ width: 1, height: 18, background: 'var(--border-r)' }} />
            <div style={{ display: 'flex', gap: 4 }}>
              {LOADERS.map(l => (
                <FilterChip key={l} active={loader === l} onClick={() => setLoader(l)} color={LOADER_COLOR[l]}>
                  {l === 'All' ? t.browse.allLoaders : l}
                </FilterChip>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
            {loading ? t.browse.searching : t.browse.modsFound(total)}
          </div>

          {/* Feature 3: Popular for your setup banner */}
          {query === '' && suggested && !loading && gameVersion === null && loader === 'All' && (
            <div style={{ fontSize: 11, color: 'var(--ink-4)', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Showing popular mods for</span>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{suggested.name}</span>
              <span style={{ color: 'var(--ink-4)' }}>MC {suggested.version}{suggested.loader ? ` · ${suggested.loader}` : ''}</span>
            </div>
          )}

          {loading ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.browse.loading}</div>
          ) : source === 'cf' ? (
            cfResults.length === 0 ? (
              <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.browse.noMods}</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                {cfResults.map(mod => (
                  <CFModTile
                    key={mod.id}
                    mod={mod}
                    installing={installingId === `cf:${mod.id}`}
                    status={getCfModStatus(mod)}
                    onDetail={() => setCfModDetail(mod)}
                    onInstall={() => setCfInstallTarget(mod)}
                  />
                ))}
              </div>
            )
          ) : results.length === 0 ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.browse.noMods}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {results.map(mod => (
                <ModTile
                  key={mod.project_id}
                  mod={mod}
                  installing={installingId === mod.project_id}
                  installedInInstances={instances.filter(i => i.mods?.some(m => m.projectId === mod.project_id)).length}
                  status={getModStatus(mod)}
                  onInstall={() => setInstallTarget(mod)}
                  onDetail={() => setDetailTarget(mod)}
                />
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', paddingTop: 4 }}>
              <PageBtn disabled={currentPage === 0} onClick={() => doSearch((currentPage - 1) * LIMIT)}>←</PageBtn>
              <PageJumper current={currentPage} total={totalPages} onGo={p => doSearch(p * LIMIT)} />
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, color: 'var(--ink-3)', letterSpacing: '.04em' }}>
                / {totalPages}
              </span>
              <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => doSearch((currentPage + 1) * LIMIT)}>→</PageBtn>
            </div>
          )}
        </>
      )}

      {detailTarget && (
        <ModDetailModal
          mod={detailTarget}
          onClose={() => setDetailTarget(null)}
          onInstall={() => setInstallTarget(detailTarget)}
        />
      )}

      {installTarget && (
        <InstallModal
          mod={installTarget}
          instances={instances}
          onClose={() => setInstallTarget(null)}
          onInstall={handleInstall}
        />
      )}

      {depsTarget && (
        <DepsModal
          target={depsTarget}
          onClose={() => setDepsTarget(null)}
          onConfirm={handleDepsConfirm}
          onSkip={handleDepsSkip}
        />
      )}

      {cfModDetail && (
        <CFModDetailModal
          mod={cfModDetail}
          onClose={() => setCfModDetail(null)}
          onInstall={() => { setCfModDetail(null); setCfInstallTarget(cfModDetail) }}
        />
      )}

      {cfInstallTarget && (
        <CFInstallModal
          mod={cfInstallTarget}
          instances={instances}
          onClose={() => setCfInstallTarget(null)}
          onInstall={handleCfInstall}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 44, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px', background: 'var(--surface-2)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-floating)',
          fontSize: 13, color: 'var(--ink)', zIndex: 100,
        }}>
          <div style={{ width: 8, height: 8, background: toast.ok ? 'var(--grass)' : 'var(--lava)', flexShrink: 0 }} />
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── ModTile ──────────────────────────────────────────────────────────────────

function ModTile({ mod, installing, installedInInstances, status, onInstall, onDetail }: {
  mod: ModrinthProject
  installing: boolean
  installedInInstances: number
  status: 'downloaded' | 'update' | 'incompatible' | null
  onInstall: () => void
  onDetail: () => void
}) {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  const loaders = mod.loaders ?? []

  return (
    <div
      onClick={onDetail}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${hovered ? 'var(--accent)' : 'var(--border-r)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        transition: 'border-color .14s',
      }}
    >
      {/* Top: icon + name + stats */}
      <div style={{ padding: '14px 14px 10px', display: 'flex', gap: 12 }}>
        {mod.icon_url ? (
          <img
            src={mod.icon_url}
            alt=""
            style={{ width: 64, height: 64, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }}
          />
        ) : (
          <div style={{ width: 64, height: 64, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--ink-4)' }}>
            {mod.title[0]}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mod.title}
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--ink-4)' }}>
            <span>↓ {formatDownloads(mod.downloads)}</span>
            {mod.follows != null && <span>♥ {formatDownloads(mod.follows)}</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {loaders.slice(0, 4).join(' · ')}
          </div>
          {installedInInstances > 0 && (
            <div style={{ fontSize: 10, color: 'var(--grass)', border: '1px solid var(--grass)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', width: 'fit-content', opacity: 0.9 }}>
              ✓ {installedInInstances} instance{installedInInstances > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <p style={{ fontSize: 12, color: 'var(--ink)', margin: '0 14px 10px', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {mod.description}
      </p>

      {/* Footer */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {mod.categories.slice(0, 2).map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
        </div>
        {status === 'downloaded' ? (
          <Button
            variant="outline"
            onClick={e => { e.stopPropagation(); onInstall() }}
            title="Already downloaded — click to reinstall"
            style={{
              fontSize: 12, fontWeight: 600, letterSpacing: '.04em',
              color: 'var(--grass)',
              border: '1px solid var(--grass)',
              padding: '0 18px', height: 36, flexShrink: 0,
            }}
          >
            {t.browse.downloaded}
          </Button>
        ) : status === 'update' ? (
          <Button
            variant="primary"
            onClick={e => { e.stopPropagation(); onInstall() }}
            title="Update available"
            style={{
              fontSize: 12, fontWeight: 700, letterSpacing: '.04em',
              color: '#fff', background: 'var(--gold)',
              padding: '0 20px', height: 36, flexShrink: 0,
            }}
          >
            {t.browse.update}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={e => { e.stopPropagation(); onInstall() }}
            disabled={installing}
            title={status === 'incompatible' ? `Incompatible with ${mod.game_versions?.[0] ?? '?'} — click to install anyway` : undefined}
            style={{
              fontSize: 13, fontWeight: 700, letterSpacing: '.04em',
              color: installing ? 'var(--ink-4)' : status === 'incompatible' ? 'var(--ink-3)' : '#fff',
              background: installing ? 'var(--surface-3)' : status === 'incompatible' ? 'var(--surface-2)' : 'var(--ender)',
              border: status === 'incompatible' ? '1px solid var(--border-r)' : 'none',
              padding: '0 32px', height: 36, flexShrink: 0,
              opacity: status === 'incompatible' ? 0.55 : 1,
            }}
          >
            {installing ? t.browse.installing : t.browse.install}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── CFModTile ────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function CFModTile({ mod, installing, status, onDetail, onInstall }: {
  mod: CFProject
  installing: boolean
  status: 'downloaded' | null
  onDetail: () => void
  onInstall: () => void
}) {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onDetail}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${hovered ? 'var(--ender)' : 'var(--border-r)'}`,
        borderRadius: 'var(--radius-md)',
        display: 'flex', flexDirection: 'column',
        transition: 'border-color .14s', cursor: 'pointer',
      }}
    >
      <div style={{ padding: '14px 14px 10px', display: 'flex', gap: 12 }}>
        {mod.logo?.thumbnailUrl ? (
          <img src={mod.logo.thumbnailUrl} alt="" style={{ width: 64, height: 64, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }} />
        ) : (
          <div style={{ width: 64, height: 64, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--ink-4)' }}>
            {mod.name[0]}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mod.name}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>↓ {fmtNum(mod.downloadCount)}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mod.authors.map(a => a.name).join(', ')}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
            <Tag color="var(--ender)" key="cf">CurseForge</Tag>
          </div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--ink)', margin: '0 14px 10px', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {mod.summary}
      </p>
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {mod.categories.slice(0, 2).map(cat => <Tag key={cat.id} color="var(--ink-4)">{cat.name}</Tag>)}
        </div>
        {status === 'downloaded' ? (
          <Button
            variant="outline"
            onClick={e => { e.stopPropagation(); onInstall() }}
            title="Already downloaded — click to reinstall"
            style={{
              fontSize: 12, fontWeight: 600, letterSpacing: '.04em',
              color: 'var(--grass)',
              border: '1px solid var(--grass)',
              padding: '0 18px', height: 36, flexShrink: 0,
            }}
          >
            {t.browse.downloaded}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={e => { e.stopPropagation(); onInstall() }}
            disabled={installing}
            style={{
              fontSize: 13, fontWeight: 700, letterSpacing: '.04em',
              color: installing ? 'var(--ink-4)' : '#fff',
              background: installing ? 'var(--surface-3)' : 'var(--ender)',
              padding: '0 32px', height: 36, flexShrink: 0,
            }}
          >
            {installing ? t.browse.cfInstalling : t.browse.cfInstall}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── CFInstallModal ───────────────────────────────────────────────────────────

function CFInstallModal({ mod, instances, onClose, onInstall }: {
  mod: CFProject
  instances: Instance[]
  onClose: () => void
  onInstall: (instanceId: string, file: CFFile, displayName: string) => void
}) {
  useScrollLock()
  const t = useT()
  const [files, setFiles] = useState<CFFile[]>([])
  const [loadingFiles, setLoadingFiles] = useState(true)
  const [selectedInst, setSelInst] = useState<Instance | null>(null)
  const [selectedFile, setSelFile] = useState<CFFile | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!selectedInst) {
      api.curseforge.files(mod.id, undefined, undefined)
        .then(f => { setFiles(f as CFFile[]); setLoadingFiles(false) })
        .catch(() => setLoadingFiles(false))
    } else {
      setLoadingFiles(true)
      api.curseforge.files(mod.id, selectedInst.minecraftVersion, selectedInst.modLoader ?? undefined)
        .then(f => { setFiles(f as CFFile[]); setLoadingFiles(false) })
        .catch(() => setLoadingFiles(false))
    }
  }, [mod.id, selectedInst])

  const canInstall = selectedInst !== null && selectedFile !== null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', width: 660, maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-floating)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {mod.logo?.thumbnailUrl && <img src={mod.logo.thumbnailUrl} alt="" style={{ width: 28, height: 28, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ender)', letterSpacing: '.1em' }}>{t.browse.cfInstallMod}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{mod.name}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>{t.browse.cfSelectInstance}</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {instances.length === 0
                ? <div style={{ padding: 16, fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>{t.browse.noInstances}</div>
                : instances.map(inst => {
                    const active = selectedInst?.id === inst.id
                    return (
                      <Button variant="secondary" key={inst.id} onClick={() => { setSelInst(inst); setSelFile(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: active ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst.name}</div>
                        <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--ink-4)', marginTop: 1 }}>{inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}</div>
                      </Button>
                    )
                  })
              }
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>{t.browse.cfSelectVersion}</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {loadingFiles
                ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.browse.cfLoadingFiles}</div>
                : files.length === 0
                  ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.browse.cfNoFiles}</div>
                  : files.map(f => {
                      const isSel = selectedFile?.id === f.id
                      const mcVers = f.gameVersions.filter(v => /^\d+\.\d+/.test(v))
                      return (
                        <Button variant="secondary" key={f.id} onClick={() => setSelFile(f)} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{f.displayName}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{mcVers.slice(0, 3).join(', ')}</div>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--ink-4)', flexShrink: 0, marginLeft: 8 }}>↓ {fmtNum(f.downloadCount)}</div>
                        </Button>
                      )
                    })
              }
            </div>
          </div>
        </div>

        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            {!selectedInst ? t.browse.selectInstanceHint : !selectedFile ? t.browse.selectVersionHint : t.browse.installingTo(selectedInst.name)}
          </div>
          <Button variant="primary" disabled={!canInstall} onClick={() => canInstall && onInstall(selectedInst!.id, selectedFile!, selectedFile!.displayName)} style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', color: canInstall ? '#fff' : 'var(--ink-4)', background: canInstall ? 'var(--ender)' : 'var(--surface-3)', padding: '0 24px', height: 34 }}>
            {t.browse.cfInstallBtn}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function FilterChip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  const c = color ?? 'var(--accent)'
  return (
    <Button variant="ghost" onClick={onClick} style={{ fontSize: 11, fontWeight: 500, color: active ? c : 'var(--ink-4)', background: active ? 'var(--accent-tint)' : 'var(--surface)', border: `1px solid ${active ? c : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', padding: '3px 10px' }}>
      {children}
    </Button>
  )
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 'var(--radius-sm)', padding: '1px 5px', opacity: 0.85 }}>
      {children}
    </span>
  )
}

function PageBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="secondary" disabled={disabled} onClick={onClick} style={{ width: 32, height: 28, padding: 0, fontSize: 14, fontWeight: 600, color: disabled ? 'var(--ink-4)' : 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', opacity: disabled ? 0.4 : 1 }}>
      {children}
    </Button>
  )
}

function PageJumper({ current, total, onGo }: { current: number; total: number; onGo: (zeroIdx: number) => void }) {
  const [val, setVal] = useState(String(current + 1))
  useEffect(() => setVal(String(current + 1)), [current])
  function go() {
    const n = parseInt(val, 10)
    if (!isNaN(n)) onGo(Math.max(0, Math.min(n - 1, total - 1)))
    else setVal(String(current + 1))
  }
  return (
    <input
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={go}
      onKeyDown={e => { if (e.key === 'Enter') go() }}
      style={{
        width: Math.max(String(total).length, 2) * 11 + 16,
        height: 28, textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
        background: 'var(--bg)', border: '1px solid var(--border-r)',
        color: 'var(--ink)', borderRadius: 'var(--radius-md)', outline: 'none',
      }}
    />
  )
}


// ─── CurseForge mod detail modal ─────────────────────────────────────────────

function CFModDetailModal({ mod, onClose, onInstall }: { mod: CFProject; onClose: () => void; onInstall: () => void }) {
  useScrollLock()
  const t = useT()
  const [detail, setDetail]             = useState<CFProjectDetail | null>(null)
  const [loading, setLoading]           = useState(true)
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (galleryIndex !== null) setGalleryIndex(null); else onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, galleryIndex])

  useEffect(() => {
    setLoading(true)
    api.curseforge.projectDetail(mod.id)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [mod.id])

  const screenshots = detail?.screenshots ?? []
  const bodyText    = detail?.description ? stripTags(detail.description) : mod.summary
  const cfUrl       = mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`
  const mcVersions  = [...new Set((mod.latestFilesIndexes ?? []).map(f => f.gameVersion).filter(Boolean))].slice(0, 3)

  function stripTags(html: string): string {
    return htmlToText(html).replace(/\s{2,}/g, ' ').trim()
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '86vw', maxWidth: 960, maxHeight: '90vh', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-floating)' }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
          <div style={{ width: 72, height: 72, flexShrink: 0, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-2)' }}>
            {mod.logo?.thumbnailUrl ? <img src={mod.logo.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--ink-4)' }}>{mod.name[0]}</div>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>{mod.name}</div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ink-3)', flexWrap: 'wrap', marginBottom: 5 }}>
              <span>↓ {fmtNum(mod.downloadCount)} downloads</span>
              {mod.authors[0] && <span>by {mod.authors[0].name}</span>}
              <span>Updated {new Date(mod.dateModified).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {mod.categories.slice(0, 4).map(c => <Tag key={c.id} color="var(--ender)">{c.name}</Tag>)}
              {mcVersions.length > 0 && <Tag color="var(--diamond)">MC {mcVersions[0]}{mcVersions.length > 1 ? ` – ${mcVersions[mcVersions.length - 1]}` : ''}</Tag>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-start' }}>
            <Button variant="outline" onClick={() => { void api.external.open(cfUrl) }} style={{ height: 32, padding: '0 14px', fontSize: 12, color: 'var(--ender)', border: '1px solid var(--ender)' }}>CurseForge ↗</Button>
            <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 20, lineHeight: 1 }}>&#x2715;</Button>
          </div>
        </div>

        {/* Gallery */}
        {screenshots.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 22px', overflowX: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
            {screenshots.map((s, i) => (
              <div key={s.id} onClick={() => setGalleryIndex(i)} style={{ flexShrink: 0, cursor: 'pointer', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border-r)', height: 130 }}>
                <img src={s.thumbnailUrl} alt={s.title} style={{ height: '100%', width: 'auto', display: 'block', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
            {loading
              ? <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>{t.browse.loadingDetails}</div>
              : <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{bodyText}</div>
            }
          </div>
          <div style={{ width: 200, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <SideLabel>{t.browse.categories}</SideLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {mod.categories.map(c => <div key={c.id} style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.name}</div>)}
              </div>
            </div>
            {(mod.links?.websiteUrl || mod.links?.issuesUrl || mod.links?.sourceUrl) && (
              <div>
                <SideLabel>{t.browse.links}</SideLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  {mod.links.websiteUrl && <Button variant="ghost" onClick={() => { void api.external.open(mod.links.websiteUrl!) }} style={{ fontSize: 11, color: 'var(--ender)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>CurseForge ↗</Button>}
                  {mod.links.issuesUrl  && <Button variant="ghost" onClick={() => { void api.external.open(mod.links.issuesUrl!) }}  style={{ fontSize: 11, color: 'var(--accent)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>Issues ↗</Button>}
                  {mod.links.sourceUrl  && <Button variant="ghost" onClick={() => { void api.external.open(mod.links.sourceUrl!) }}  style={{ fontSize: 11, color: 'var(--accent)', textAlign: 'left', padding: 0, justifyContent: 'flex-start' }}>Source ↗</Button>}
                </div>
              </div>
            )}
            <div>
              <SideLabel>{t.browse.published}</SideLabel>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>{new Date(mod.dateCreated).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 10 }}>
              <Button variant="primary" onClick={onInstall} style={{ width: '100%', height: 36, fontSize: 13, fontWeight: 700, letterSpacing: '.04em', color: '#fff', background: 'var(--ender)' }}>
                {t.browse.cfInstallMod}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {galleryIndex !== null && screenshots[galleryIndex] && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { e.stopPropagation(); setGalleryIndex(null) }}>
          <img src={screenshots[galleryIndex].url} alt="" style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} onClick={e => e.stopPropagation()} />
          {screenshots.length > 1 && (
            <>
              <Button variant="ghost" onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i - 1 + screenshots.length) % screenshots.length : 0) }} style={{ position: 'absolute', left: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44 }}>&#x2039;</Button>
              <Button variant="ghost" onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i + 1) % screenshots.length : 0) }} style={{ position: 'absolute', right: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44 }}>&#x203A;</Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={e => { e.stopPropagation(); setGalleryIndex(null) }} style={{ position: 'absolute', top: 16, right: 20, fontSize: 22, color: '#fff' }}>&#x2715;</Button>
        </div>
      )}
    </div>
  )
}
