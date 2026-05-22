import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import type React from 'react'
import { SearchIcon } from '@/components/ui/BlockIcons'
import { api } from '@/lib/api'
import type { ModrinthProject, ModrinthVersion, ModrinthSortIndex, ModrinthProjectType, Instance } from '@refract/core'

export const Route = createFileRoute('/modpacks/')({ component: ContentBrowser })

// ─── Constants ────────────────────────────────────────────────────────────────

type ContentTab = ModrinthProjectType & ('modpack' | 'resourcepack' | 'shader' | 'datapack')

const TABS: Array<{ type: ContentTab; label: string; icon: string; showLoader: boolean }> = [
  { type: 'modpack',     label: 'Modpacks',      icon: '📦', showLoader: true  },
  { type: 'resourcepack',label: 'Resource Packs', icon: '🎨', showLoader: true  },
  { type: 'shader',      label: 'Shaders',        icon: '✨', showLoader: false },
  { type: 'datapack',    label: 'Data Packs',     icon: '📜', showLoader: false },
]

const SORT_OPTIONS: Array<{ label: string; value: ModrinthSortIndex }> = [
  { label: 'Most Downloaded',  value: 'downloads' },
  { label: 'Most Followed',    value: 'follows'   },
  { label: 'Newest',           value: 'newest'    },
  { label: 'Recently Updated', value: 'updated'   },
  { label: 'Relevance',        value: 'relevance' },
]

const LOADERS = ['fabric', 'forge', 'quilt', 'neoforge']
const LIMIT = 20

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDate(iso?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

function loaderLabel(l: string): string {
  return l.charAt(0).toUpperCase() + l.slice(1)
}

function stripMarkdown(text: string): string {
  return (text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
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
    .trim()
}

function tabColor(tab: ContentTab): string {
  return tab === 'modpack' ? 'var(--ender)' : 'var(--accent)'
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 2, padding: '1px 5px', opacity: 0.85 }}>
      {children}
    </span>
  )
}

function SideLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)' }}>
      {children}
    </div>
  )
}

function PageBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{ width: 32, height: 28, fontFamily: "'VT323',monospace", fontSize: 18, color: disabled ? 'var(--ink-4)' : 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .4 : 1 }}>
      {children}
    </button>
  )
}

// ─── MC Version picker ────────────────────────────────────────────────────────

function VersionDropdown({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen]         = useState(false)
  const [versions, setVersions] = useState<string[]>([])
  const [loading, setLoading]   = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [])

  function toggle() {
    if (!open && !versions.length) {
      setLoading(true)
      api.modrinth.gameVersions()
        .then(list => setVersions(list.map(v => v.version)))
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    setOpen(o => !o)
  }

  const active = value !== null
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={toggle} style={{
        display: 'flex', alignItems: 'center', gap: 5,
        fontWeight: 500, fontSize: active ? 13 : 11,
        fontFamily: active ? "'VT323',monospace" : 'inherit',
        letterSpacing: active ? '.04em' : 'inherit',
        color: active ? 'var(--diamond)' : 'var(--ink-4)',
        background: active ? 'rgba(79,184,232,.12)' : 'var(--surface)',
        border: `1px solid ${active ? 'var(--diamond)' : 'var(--border-r)'}`,
        borderRadius: 3, padding: '3px 10px', cursor: 'pointer',
      } as React.CSSProperties}>
        {active ? `MC ${value}` : 'All versions'}
        <span style={{ fontSize: 9, opacity: .7, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          width: 140, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          <button onClick={() => { onChange(null); setOpen(false) }} style={{
            padding: '7px 12px', textAlign: 'left', fontSize: 12, border: 'none',
            color: value === null ? 'var(--accent)' : 'var(--ink-3)',
            background: value === null ? 'var(--accent-tint)' : 'transparent',
            borderBottom: '1px solid var(--line)', cursor: 'pointer',
          }}>All versions</button>
          {loading
            ? <div style={{ padding: 12, fontSize: 11, color: 'var(--ink-4)', textAlign: 'center' }}>Loading…</div>
            : versions.map(ver => (
                <button key={ver} onClick={() => { onChange(ver); setOpen(false) }} style={{
                  padding: '6px 12px', textAlign: 'left', border: 'none',
                  fontFamily: "'VT323',monospace", fontSize: 14, letterSpacing: '.04em',
                  color: value === ver ? 'var(--diamond)' : 'var(--ink-2)',
                  background: value === ver ? 'rgba(79,184,232,.12)' : 'transparent',
                  cursor: 'pointer',
                }}>{ver}</button>
              ))
          }
        </div>
      )}
    </div>
  )
}

// ─── Sort dropdown ────────────────────────────────────────────────────────────

function SortDropdown({ value, onChange }: { value: ModrinthSortIndex; onChange: (v: ModrinthSortIndex) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [])

  const current = SORT_OPTIONS.find(o => o.value === value)!

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 600, color: 'var(--ink)',
        background: 'var(--surface)', border: '1px solid var(--border-r)',
        borderRadius: 3, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
      }}>
        {current.label}
        <span style={{ fontSize: 9, opacity: .7 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          minWidth: 180, display: 'flex', flexDirection: 'column',
        }}>
          {SORT_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => { onChange(opt.value); setOpen(false) }} style={{
              padding: '8px 14px', textAlign: 'left', border: 'none',
              fontSize: 12, fontWeight: 500,
              color: value === opt.value ? 'var(--accent)' : 'var(--ink-2)',
              background: value === opt.value ? 'var(--accent-tint)' : 'transparent',
              cursor: 'pointer',
            }}>{opt.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ContentCard (tile) ───────────────────────────────────────────────────────

function ContentCard({ project, tab, onInstall, onDetail, installing }: {
  project: ModrinthProject
  tab: ContentTab
  onInstall: () => void
  onDetail: () => void
  installing: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const loaders = project.loaders ?? []
  const isModpack = tab === 'modpack'
  const accent = tabColor(tab)
  const tabInfo = TABS.find(t => t.type === tab)!

  return (
    <div
      onClick={onDetail}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${hovered ? accent : 'var(--border-r)'}`,
        borderRadius: 'var(--radius)',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        transition: 'border-color .14s',
      }}
    >
      {/* Top: icon + name + stats */}
      <div style={{ padding: '14px 14px 10px', display: 'flex', gap: 12 }}>
        {project.icon_url ? (
          <img
            src={project.icon_url}
            alt=""
            style={{ width: 64, height: 64, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 4 }}
          />
        ) : (
          <div style={{ width: 64, height: 64, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            {tabInfo.icon}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project.title}
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--ink-4)' }}>
            <span>↓ {fmtNum(project.downloads)}</span>
            {project.follows != null && <span>♥ {fmtNum(project.follows)}</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {loaders.slice(0, 4).map(loaderLabel).join(' · ') || 'universal'}
          </div>
          {(project.game_versions ?? []).length > 0 && (
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 11, letterSpacing: '.04em', color: 'var(--diamond)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {project.game_versions![0]}{(project.game_versions!).length > 1 ? ` – ${project.game_versions![project.game_versions!.length - 1]}` : ''}
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <p style={{ fontSize: 12, color: 'var(--ink)', margin: '0 14px 10px', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {project.description}
      </p>

      {/* Footer */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {project.categories.slice(0, 2).map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onInstall() }}
          disabled={installing}
          style={{
            fontFamily: "'VT323',monospace", fontSize: 18, letterSpacing: '.08em',
            color: installing ? 'var(--ink-4)' : '#fff',
            background: installing ? 'var(--surface-3)' : accent,
            border: 'none', cursor: installing ? 'not-allowed' : 'pointer',
            padding: '0 22px', height: 36, borderRadius: 3, flexShrink: 0,
            boxShadow: installing ? 'none' : isModpack
              ? 'inset 0 -2px 0 rgba(0,0,0,.3), inset 0 2px 0 rgba(255,255,255,.1)'
              : 'inset 0 -2px 0 var(--accent-lo), inset 0 2px 0 var(--accent-hi)',
          }}
        >
          {installing ? '…' : isModpack ? 'INSTALL' : 'ADD'}
        </button>
      </div>
    </div>
  )
}

// ─── ContentDetailModal ───────────────────────────────────────────────────────

function ContentDetailModal({ project, tab, onClose, onInstall }: {
  project: ModrinthProject
  tab: ContentTab
  onClose: () => void
  onInstall: () => void
}) {
  const [detail, setDetail]         = useState<ModrinthProjectDetail | null>(null)
  const [loading, setLoading]       = useState(true)
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  const isModpack = tab === 'modpack'
  const accent    = tabColor(tab)
  const tabInfo   = TABS.find(t => t.type === tab)!

  useEffect(() => {
    setLoading(true)
    fetch(`https://api.modrinth.com/v2/project/${project.project_id}`, {
      headers: { 'User-Agent': 'Refract/1.0 (github.com/ShevRuslan1)', Accept: 'application/json' },
    })
      .then(r => r.ok ? r.json() as Promise<ModrinthProjectDetail> : null)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [project.project_id])

  const gallery     = detail?.gallery ?? []
  const loaders     = detail?.loaders ?? project.loaders ?? []
  const gameVersions = detail?.game_versions ?? project.game_versions ?? []
  const followers   = detail?.followers ?? project.follows
  const modrinthUrl = `https://modrinth.com/${tab}/${project.slug ?? project.project_id}`
  const bodyText    = detail?.body ? stripMarkdown(detail.body) : project.description

  const btnLabel = isModpack ? 'INSTALL AS INSTANCE' : `ADD TO INSTANCE`

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '86vw', maxWidth: 960, maxHeight: '90vh', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
          {project.icon_url ? (
            <img src={project.icon_url} alt="" style={{ width: 72, height: 72, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 6 }} />
          ) : (
            <div style={{ width: 72, height: 72, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {tabInfo.icon}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>{project.title}</div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ink-3)', flexWrap: 'wrap', marginBottom: 5 }}>
              <span>↓ {fmtNum(project.downloads)} downloads</span>
              {followers != null && <span>♥ {fmtNum(followers)} followers</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {loaders.map(l => (
                <Tag key={l} color={accent}>{loaderLabel(l)}</Tag>
              ))}
              {gameVersions.length > 0 && (
                <Tag color="var(--diamond)">
                  MC {gameVersions[0]}{gameVersions.length > 1 ? ` – ${gameVersions[gameVersions.length - 1]}` : ''}
                </Tag>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-start' }}>
            <button
              onClick={() => window.open(modrinthUrl)}
              style={{ height: 32, padding: '0 14px', fontSize: 12, fontWeight: 600, background: 'transparent', color: accent, border: `1px solid ${accent}`, borderRadius: 3, cursor: 'pointer' }}
            >
              Modrinth ↗
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>✕</button>
          </div>
        </div>

        {/* Gallery */}
        {gallery.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 22px', overflowX: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
            {gallery.map((img, i) => (
              <div
                key={i}
                onClick={() => setGalleryIndex(i)}
                style={{ flexShrink: 0, cursor: 'pointer', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border-r)', height: 130 }}
              >
                <img src={img.url} alt={img.title ?? ''} style={{ height: '100%', width: 'auto', display: 'block', objectFit: 'cover' }} />
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
          {/* Description text */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
            {loading ? (
              <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>Loading details…</div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap' }}>
                {bodyText}
              </p>
            )}
          </div>

          {/* Sidebar */}
          <div style={{ width: 210, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Categories */}
            {project.categories.length > 0 && (
              <div>
                <SideLabel>Categories</SideLabel>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                  {project.categories.map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
                </div>
              </div>
            )}

            {/* Environment */}
            {detail && (
              <div>
                <SideLabel>Environment</SideLabel>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Client</span>
                    <span style={{ color: detail.client_side === 'required' ? 'var(--grass)' : detail.client_side === 'unsupported' ? 'var(--lava)' : 'var(--gold)' }}>
                      {detail.client_side}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Server</span>
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
                <SideLabel>Published</SideLabel>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>{fmtDate(detail.published)}</div>
                {detail.updated && <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>Updated {fmtDate(detail.updated)}</div>}
              </div>
            )}

            {/* Links */}
            {detail && (detail.issues_url || detail.source_url || detail.discord_url) && (
              <div>
                <SideLabel>Links</SideLabel>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {detail.issues_url && (
                    <button onClick={() => window.open(detail.issues_url!)} style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                      🐛 Issues ↗
                    </button>
                  )}
                  {detail.source_url && (
                    <button onClick={() => window.open(detail.source_url!)} style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                      {'</>'} Source ↗
                    </button>
                  )}
                  {detail.discord_url && (
                    <button onClick={() => window.open(detail.discord_url!)} style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                      💬 Discord ↗
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Install CTA */}
            <div style={{ marginTop: 'auto', paddingTop: 10 }}>
              <button
                onClick={onInstall}
                style={{ width: '100%', height: 36, fontFamily: "'VT323',monospace", fontSize: 18, letterSpacing: '.1em', color: '#fff', background: accent, border: 'none', cursor: 'pointer', boxShadow: isModpack ? 'inset 0 -3px 0 rgba(0,0,0,.3), inset 0 3px 0 rgba(255,255,255,.1)' : 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)' }}
              >
                {btnLabel}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {galleryIndex !== null && gallery[galleryIndex] && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setGalleryIndex(null)}
        >
          <img
            src={gallery[galleryIndex].url}
            alt=""
            style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 4, border: '1px solid var(--border-r)' }}
            onClick={e => e.stopPropagation()}
          />
          {gallery.length > 1 && (
            <>
              <button
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i - 1 + gallery.length) % gallery.length : 0) }}
                style={{ position: 'absolute', left: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', border: 'none', cursor: 'pointer', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                ‹
              </button>
              <button
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i + 1) % gallery.length : 0) }}
                style={{ position: 'absolute', right: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', border: 'none', cursor: 'pointer', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                ›
              </button>
            </>
          )}
          <button
            onClick={() => setGalleryIndex(null)}
            style={{ position: 'absolute', top: 16, right: 20, fontSize: 22, color: '#fff', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

// ─── ContentInstallModal (resource packs, shaders, data packs) ────────────────

interface ContentInstallModalProps {
  project: ModrinthProject
  tab: ContentTab
  instances: Instance[]
  onClose: () => void
  onInstall: (instanceId: string, versionId: string) => void
}

function ContentInstallModal({ project, tab, instances, onClose, onInstall }: ContentInstallModalProps) {
  const [versions, setVersions]    = useState<ModrinthVersion[]>([])
  const [loading, setLoading]      = useState(true)
  const [selectedInst, setSelInst] = useState<Instance | null>(null)
  const [selectedVer, setSelVer]   = useState<string | null>(null)

  useEffect(() => {
    api.modrinth.versions(project.project_id)
      .then(v => { setVersions(v); setLoading(false) })
      .catch(() => setLoading(false))
  }, [project.project_id])

  const canInstall = selectedInst !== null && selectedVer !== null
  const tabInfo    = TABS.find(t => t.type === tab)!

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 660, maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {project.icon_url && <img src={project.icon_url} alt="" style={{ width: 28, height: 28, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--accent)', letterSpacing: '.1em' }}>
              ADD {tabInfo.label.toUpperCase()}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{project.title}</div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        {tab === 'datapack' && (
          <div style={{ margin: '10px 18px 0', padding: '8px 12px', background: 'rgba(255,165,0,.1)', border: '1px solid rgba(255,165,0,.4)', borderRadius: 3, fontSize: 11, color: 'var(--gold)', lineHeight: 1.45 }}>
            Data packs are downloaded to the instance folder. Move them into a world's <code style={{ background: 'var(--surface-2)', padding: '0 3px' }}>datapacks/</code> folder in-game.
          </div>
        )}

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Instance picker */}
          <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>1. Select Instance</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {instances.length === 0
                ? <div style={{ padding: 16, fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>No instances yet.</div>
                : instances.map(inst => {
                    const active = selectedInst?.id === inst.id
                    return (
                      <button key={inst.id} onClick={() => setSelInst(inst)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: active ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 3, cursor: 'pointer' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst.name}</div>
                        <div style={{ fontFamily: "'VT323',monospace", fontSize: 11, color: 'var(--ink-4)', marginTop: 1 }}>{inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}</div>
                      </button>
                    )
                  })
              }
            </div>
          </div>

          {/* Version picker */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>2. Select Version</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {loading
                ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>Loading…</div>
                : versions.length === 0
                  ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>No versions found.</div>
                  : versions.map(v => {
                      const isSel  = selectedVer === v.id
                      const mcOk   = selectedInst ? v.game_versions.includes(selectedInst.minecraftVersion) : true
                      return (
                        <button key={v.id} onClick={() => setSelVer(v.id)} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 3, cursor: 'pointer', opacity: (!mcOk && !isSel) ? .45 : 1 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{v.version_number}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{v.game_versions.slice(0, 3).join(', ')}</div>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--ink-4)', flexShrink: 0, marginLeft: 8 }}>↓ {fmtNum(v.downloads)}</div>
                        </button>
                      )
                    })
              }
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            {!selectedInst ? 'Pick an instance' : !selectedVer ? 'Pick a version' : `Installing to "${selectedInst.name}"`}
          </div>
          <button disabled={!canInstall} onClick={() => canInstall && onInstall(selectedInst!.id, selectedVer!)} style={{ fontFamily: "'VT323',monospace", fontSize: 18, letterSpacing: '.1em', color: canInstall ? '#fff' : 'var(--ink-4)', background: canInstall ? 'var(--accent)' : 'var(--surface-3)', border: 'none', cursor: canInstall ? 'pointer' : 'not-allowed', padding: '0 24px', height: 34, boxShadow: canInstall ? 'inset 0 -3px 0 var(--accent-lo)' : 'none' }}>
            INSTALL
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modpack install modal ────────────────────────────────────────────────────

interface ModpackInstallModalProps {
  project: ModrinthProject
  onClose: () => void
  onInstall: (name: string, versionId: string) => void
}

function ModpackInstallModal({ project, onClose, onInstall }: ModpackInstallModalProps) {
  const [versions, setVersions]  = useState<ModrinthVersion[]>([])
  const [loading, setLoading]    = useState(true)
  const [name, setName]          = useState(project.title)
  const [selectedVer, setSelVer] = useState<string | null>(null)

  useEffect(() => {
    api.modrinth.versions(project.project_id)
      .then(v => {
        setVersions(v)
        if (v[0]) setSelVer(v[0].id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [project.project_id])

  const ver        = versions.find(v => v.id === selectedVer)
  const mcVer      = ver?.game_versions[0]
  const loader     = ver?.loaders.find(l => l !== 'mrpack')
  const canInstall = name.trim().length > 0 && selectedVer !== null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 520, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {project.icon_url && <img src={project.icon_url} alt="" style={{ width: 32, height: 32, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--ender)', letterSpacing: '.1em' }}>INSTALL MODPACK</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{project.title}</div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Instance name */}
          <div>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 12, letterSpacing: '.12em', color: 'var(--ink-4)', marginBottom: 5 }}>INSTANCE NAME</div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              style={{ width: '100%', height: 34, background: 'var(--bg)', border: '1px solid var(--border-r)', color: 'var(--ink)', padding: '0 10px', outline: 'none', fontSize: 13, borderRadius: 3 }}
            />
          </div>

          {/* Version picker */}
          <div>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 12, letterSpacing: '.12em', color: 'var(--ink-4)', marginBottom: 5 }}>VERSION</div>
            {loading
              ? <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>Loading versions…</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {versions.map(v => {
                    const isSel     = selectedVer === v.id
                    const loaderName = v.loaders.find(l => l !== 'mrpack')
                    return (
                      <button key={v.id} onClick={() => setSelVer(v.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', textAlign: 'left', background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 3, cursor: 'pointer' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{v.version_number}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 1 }}>
                            {v.game_versions[0]} {loaderName ? `· ${loaderLabel(loaderName)}` : ''}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>↓ {fmtNum(v.downloads)}</div>
                          <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 1 }}>{fmtDate(v.date_published)}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
            }
          </div>

          {/* Detected info */}
          {ver && (
            <div style={{ display: 'flex', gap: 8 }}>
              {mcVer && (
                <span style={{ fontSize: 11, fontFamily: "'VT323',monospace", letterSpacing: '.04em', color: 'var(--diamond)', background: 'rgba(79,184,232,.1)', border: '1px solid rgba(79,184,232,.3)', borderRadius: 3, padding: '2px 8px' }}>
                  MC {mcVer}
                </span>
              )}
              {loader && (
                <span style={{ fontSize: 11, fontFamily: "'VT323',monospace", letterSpacing: '.04em', color: 'var(--accent)', background: 'var(--accent-tint)', border: '1px solid var(--accent)', borderRadius: 3, padding: '2px 8px' }}>
                  {loaderLabel(loader)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, height: 36, background: 'var(--surface-2)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button disabled={!canInstall} onClick={() => canInstall && onInstall(name.trim(), selectedVer!)} style={{ flex: 2, height: 36, fontFamily: "'VT323',monospace", fontSize: 18, letterSpacing: '.12em', color: canInstall ? '#fff' : 'var(--ink-4)', background: canInstall ? 'var(--ender)' : 'var(--surface-3)', border: 'none', borderRadius: 3, cursor: canInstall ? 'pointer' : 'not-allowed', boxShadow: canInstall ? 'inset 0 -3px 0 rgba(0,0,0,.3)' : 'none' }}>
            CREATE INSTANCE
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Progress overlay ─────────────────────────────────────────────────────────

function ProgressOverlay({ title, step, percent }: { projectId: string; title: string; step: string; percent: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 440, padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 20, letterSpacing: '.14em', color: 'var(--ender)' }}>INSTALLING MODPACK</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
        <div style={{ height: 8, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${percent}%`, background: 'var(--ender)', transition: 'width .2s', borderRadius: 4 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-4)' }}>
          <span>{step}</span>
          <span style={{ fontFamily: "'VT323',monospace", color: 'var(--ender)' }}>{Math.round(percent)}%</span>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function ContentBrowser() {
  const [tab, setTab]             = useState<ContentTab>('modpack')
  const [query, setQuery]         = useState('')
  const [sort, setSort]           = useState<ModrinthSortIndex>('downloads')
  const [gameVersion, setVersion] = useState<string | null>(null)
  const [loader, setLoader]       = useState<string | null>(null)
  const [results, setResults]     = useState<ModrinthProject[]>([])
  const [total, setTotal]         = useState(0)
  const [offset, setOffset]       = useState(0)
  const [loading, setLoading]     = useState(false)
  const [instances, setInstances] = useState<Instance[]>([])
  const [toast, setToast]         = useState<{ msg: string; ok: boolean } | null>(null)

  const [detailTarget, setDetailTarget]   = useState<ModrinthProject | null>(null)
  const [installTarget, setTarget]        = useState<ModrinthProject | null>(null)
  const [installingId, setInstallingId]   = useState<string | null>(null)
  const [progressInfo, setProgress]       = useState<{ projectId: string; title: string; step: string; percent: number } | null>(null)

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabInfo   = TABS.find(t => t.type === tab)!

  useEffect(() => {
    api.instance.list().then(setInstances).catch(() => {})
  }, [])

  useEffect(() => {
    const offProgress = api.modpack.onProgress(({ projectId, step, percent }) => {
      setProgress(prev => prev?.projectId === projectId ? { ...prev, step, percent } : prev)
    })
    const offDone = api.modpack.onDone(({ projectId, instanceId, error }) => {
      setProgress(null)
      setInstallingId(null)
      if (error) {
        showToast(`Install failed: ${error}`, false)
      } else {
        showToast('Modpack installed! Find it in your Instance Library.', true)
        if (instanceId) api.instance.list().then(setInstances).catch(() => {})
      }
    })
    return () => { offProgress(); offDone() }
  }, [])

  useEffect(() => { setOffset(0) }, [tab, sort, gameVersion, loader])

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => doSearch(0), query ? 400 : 0)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  }, [query, tab, sort, gameVersion, loader])

  const doSearch = useCallback(async (newOffset: number) => {
    setLoading(true)
    setOffset(newOffset)
    try {
      const res = await api.modrinth.searchContent({
        query: query || '',
        projectType: tab,
        gameVersion: gameVersion ?? undefined,
        loader: loader ?? undefined,
        sortIndex: sort,
        limit: LIMIT,
        offset: newOffset,
      })
      setResults(res.hits)
      setTotal(res.total_hits)
    } catch (e) {
      showToast(`Search failed: ${e instanceof Error ? e.message : 'Unknown'}`, false)
    } finally {
      setLoading(false)
    }
  }, [query, tab, sort, gameVersion, loader])

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  async function handleContentInstall(instanceId: string, versionId: string) {
    if (!installTarget) return
    const name = installTarget.title
    setTarget(null)
    setInstallingId(installTarget.project_id)
    try {
      await api.modrinth.contentInstall(instanceId, installTarget.project_id, name, tab, versionId)
      showToast(`${name} installed to instance.`, true)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Install failed', false)
    } finally {
      setInstallingId(null)
    }
  }

  async function handleModpackInstall(name: string, versionId: string) {
    if (!installTarget) return
    const projectId = installTarget.project_id
    const title     = installTarget.title
    setTarget(null)
    setInstallingId(projectId)
    setProgress({ projectId, title, step: 'Starting…', percent: 0 })
    try {
      await api.modpack.install(name, projectId, versionId)
    } catch (e) {
      setProgress(null)
      setInstallingId(null)
      showToast(e instanceof Error ? e.message : 'Install failed', false)
    }
  }

  function openInstall(project: ModrinthProject) {
    setDetailTarget(null)
    setTarget(project)
  }

  const totalPages  = Math.ceil(total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: '0 0 3px' }}>Content Browser</h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>Browse modpacks, resource packs, shaders, and data packs from Modrinth.</p>
      </div>

      {/* Type tabs */}
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: 4 }}>
        {TABS.map(t => (
          <button key={t.type} onClick={() => { setTab(t.type as ContentTab); setQuery(''); setLoader(null) }} style={{
            flex: 1, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            fontFamily: "'VT323',monospace", fontSize: 14, letterSpacing: '.1em',
            color: tab === t.type ? '#fff' : 'var(--ink-3)',
            background: tab === t.type ? (t.type === 'modpack' ? 'var(--ender)' : 'var(--accent)') : 'transparent',
            border: 'none', borderRadius: 3, cursor: 'pointer',
            boxShadow: tab === t.type ? 'inset 0 -2px 0 rgba(0,0,0,.3)' : 'none',
          }}>
            <span style={{ fontSize: 16 }}>{t.icon}</span>
            {t.label.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 240px', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: '0 10px', height: 36 }}>
          <div style={{ color: 'var(--ink-4)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><SearchIcon /></div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Search ${tabInfo.label.toLowerCase()}…`}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: 'var(--ink)' }}
          />
          {query && <button onClick={() => setQuery('')} style={{ color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>✕</button>}
        </div>
        <SortDropdown value={sort} onChange={s => setSort(s)} />
        <VersionDropdown value={gameVersion} onChange={v => { setVersion(v); setOffset(0) }} />
        {tabInfo.showLoader && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setLoader(null)} style={{ fontSize: 11, fontWeight: 500, color: loader === null ? 'var(--accent)' : 'var(--ink-4)', background: loader === null ? 'var(--accent-tint)' : 'var(--surface)', border: `1px solid ${loader === null ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer' }}>
              All
            </button>
            {LOADERS.map(l => (
              <button key={l} onClick={() => setLoader(loader === l ? null : l)} style={{ fontSize: 11, fontWeight: 500, color: loader === l ? 'var(--accent)' : 'var(--ink-4)', background: loader === l ? 'var(--accent-tint)' : 'var(--surface)', border: `1px solid ${loader === l ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer' }}>
                {loaderLabel(l)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results count */}
      <div style={{ fontSize: 11, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
        {loading ? 'Searching…' : `${total.toLocaleString()} ${tabInfo.label.toLowerCase()} found`}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>Loading…</div>
      ) : results.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
          No {tabInfo.label.toLowerCase()} found. Try a different search or filter.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {results.map(project => (
            <ContentCard
              key={project.project_id}
              project={project}
              tab={tab}
              installing={installingId === project.project_id}
              onInstall={() => openInstall(project)}
              onDetail={() => setDetailTarget(project)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', paddingTop: 4 }}>
          <PageBtn disabled={currentPage === 0} onClick={() => doSearch((currentPage - 1) * LIMIT)}>←</PageBtn>
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--ink-3)', alignSelf: 'center', letterSpacing: '.06em' }}>
            {currentPage + 1} / {totalPages}
          </span>
          <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => doSearch((currentPage + 1) * LIMIT)}>→</PageBtn>
        </div>
      )}

      {/* Detail modal */}
      {detailTarget && (
        <ContentDetailModal
          project={detailTarget}
          tab={tab}
          onClose={() => setDetailTarget(null)}
          onInstall={() => openInstall(detailTarget)}
        />
      )}

      {/* Install modals */}
      {installTarget && tab === 'modpack' && (
        <ModpackInstallModal
          project={installTarget}
          onClose={() => setTarget(null)}
          onInstall={handleModpackInstall}
        />
      )}
      {installTarget && tab !== 'modpack' && (
        <ContentInstallModal
          project={installTarget}
          tab={tab}
          instances={instances}
          onClose={() => setTarget(null)}
          onInstall={handleContentInstall}
        />
      )}

      {/* Modpack progress overlay */}
      {progressInfo && (
        <ProgressOverlay
          projectId={progressInfo.projectId}
          title={progressInfo.title}
          step={progressInfo.step}
          percent={progressInfo.percent}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 44, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,.5)', fontSize: 13, color: 'var(--ink)', zIndex: 100 }}>
          <div style={{ width: 8, height: 8, background: toast.ok ? 'var(--grass)' : 'var(--lava)', flexShrink: 0 }} />
          {toast.msg}
        </div>
      )}
    </div>
  )
}
