import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import type React from 'react'
import { SearchIcon } from '@/components/ui/BlockIcons'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { htmlToText } from '@/lib/sanitize'
import type { ModrinthProject, ModrinthVersion, ModrinthSortIndex, ModrinthProjectType, Instance, CFProject, CFFile, CFProjectDetail, FtbModpack } from '@refract/core'
import { ftbIconUrl, ftbTargets } from '@refract/core'
import { useT } from '@/i18n'

export const Route = createFileRoute('/modpacks/')({ component: ContentBrowser })

// ─── Constants ────────────────────────────────────────────────────────────────

type ContentTab = ModrinthProjectType & ('modpack' | 'resourcepack' | 'shader' | 'datapack')

const TABS: Array<{ type: ContentTab; label: string; showLoader: boolean }> = [
  { type: 'modpack',     label: 'Modpacks',      showLoader: true  },
  { type: 'resourcepack',label: 'Resource Packs', showLoader: true  },
  { type: 'shader',      label: 'Shaders',        showLoader: false },
  { type: 'datapack',    label: 'Data Packs',     showLoader: false },
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

function tabColor(tab: ContentTab): string {
  return tab === 'modpack' ? 'var(--ender)' : 'var(--accent)'
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 'var(--radius-sm)', padding: '1px 5px', opacity: 0.85 }}>
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
    <Button variant="outline" disabled={disabled} onClick={onClick} style={{ width: 32, height: 28, padding: 0, fontSize: 15 }}>
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

// ─── MC Version picker ────────────────────────────────────────────────────────

function VersionDropdown({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const t = useT()
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
      <Button variant="outline" onClick={toggle} style={{
        gap: 5,
        fontWeight: active ? 600 : 500, fontSize: 11,
        fontFamily: active ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
        letterSpacing: active ? '.04em' : 'inherit',
        color: active ? 'var(--diamond)' : 'var(--ink-4)',
        background: active ? 'rgba(79,184,232,.12)' : 'var(--surface)',
        borderColor: active ? 'var(--diamond)' : 'var(--border-r)',
        borderRadius: 'var(--radius-sm)', padding: '3px 10px',
      } as React.CSSProperties}>
        {active ? `MC ${value}` : t.content.allVersions}
        <span style={{ fontSize: 9, opacity: .7, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-floating)',
          width: 140, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          <Button variant="ghost" onClick={() => { onChange(null); setOpen(false) }} style={{
            width: '100%', justifyContent: 'flex-start', borderRadius: 0,
            padding: '7px 12px', fontSize: 12, fontWeight: 500,
            color: value === null ? 'var(--accent)' : 'var(--ink-3)',
            background: value === null ? 'var(--accent-tint)' : 'transparent',
            borderBottom: '1px solid var(--line)',
          }}>{t.content.allVersions}</Button>
          {loading
            ? <div style={{ padding: 12, fontSize: 11, color: 'var(--ink-4)', textAlign: 'center' }}>{t.content.loading}</div>
            : versions.map(ver => (
                <Button key={ver} variant="ghost" onClick={() => { onChange(ver); setOpen(false) }} style={{
                  width: '100%', justifyContent: 'flex-start', borderRadius: 0,
                  padding: '6px 12px', fontWeight: 500,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, letterSpacing: '.04em',
                  color: value === ver ? 'var(--diamond)' : 'var(--ink-2)',
                  background: value === ver ? 'rgba(79,184,232,.12)' : 'transparent',
                }}>{ver}</Button>
              ))
          }
        </div>
      )}
    </div>
  )
}

// ─── Sort dropdown ────────────────────────────────────────────────────────────

function SortDropdown({ value, onChange }: { value: ModrinthSortIndex; onChange: (v: ModrinthSortIndex) => void }) {
  const t = useT()
  const sortLabels: Record<string, string> = {
    downloads: t.content.sortDownloads,
    follows: t.content.sortFollows,
    newest: t.content.sortNewest,
    updated: t.content.sortUpdated,
    relevance: t.content.sortRelevance,
  }
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
      <Button variant="outline" onClick={() => setOpen(o => !o)} style={{
        gap: 6,
        fontSize: 12, fontWeight: 600, color: 'var(--ink)',
        background: 'var(--surface)', borderColor: 'var(--border-r)',
        borderRadius: 'var(--radius-sm)', padding: '4px 10px',
      }}>
        {sortLabels[current.value]}
        <span style={{ fontSize: 9, opacity: .7 }}>{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-floating)',
          minWidth: 180, display: 'flex', flexDirection: 'column',
        }}>
          {SORT_OPTIONS.map(opt => (
            <Button key={opt.value} variant="ghost" onClick={() => { onChange(opt.value); setOpen(false) }} style={{
              width: '100%', justifyContent: 'flex-start', borderRadius: 0,
              padding: '8px 14px',
              fontSize: 12, fontWeight: 500,
              color: value === opt.value ? 'var(--accent)' : 'var(--ink-2)',
              background: value === opt.value ? 'var(--accent-tint)' : 'transparent',
            }}>{sortLabels[opt.value]}</Button>
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
  const t = useT()
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
            style={{ width: 64, height: 64, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }}
          />
        ) : (
          <div style={{ width: 64, height: 64, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }}>
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
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, letterSpacing: '.04em', color: 'var(--diamond)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
        <Button
          variant="primary"
          onClick={e => { e.stopPropagation(); onInstall() }}
          disabled={installing}
          style={{
            fontSize: 14, fontWeight: 700,
            color: '#fff', background: 'var(--ender)',
            padding: '0 32px', height: 36, borderRadius: 'var(--radius-sm)', flexShrink: 0,
          }}
        >
          {installing ? '…' : isModpack ? t.content.install : t.content.add}
        </Button>
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
  const t = useT()
  const tabLabelMap: Record<ContentTab, string> = {
    modpack: t.content.tabModpack,
    resourcepack: t.content.tabResourcepack,
    shader: t.content.tabShader,
    datapack: t.content.tabDatapack,
  }
  const [detail, setDetail]         = useState<ModrinthProjectDetail | null>(null)
  const [loading, setLoading]       = useState(true)
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)

  const isModpack = tab === 'modpack'
  const accent    = tabColor(tab)
  const tabInfo   = TABS.find(ti => ti.type === tab)!

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

  const btnLabel = isModpack ? t.content.installAsInstance : t.content.addToInstance

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '86vw', maxWidth: 960, maxHeight: '90vh', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
          {project.icon_url ? (
            <img src={project.icon_url} alt="" style={{ width: 72, height: 72, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }} />
          ) : (
            <div style={{ width: 72, height: 72, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }} />
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
            <Button
              variant="outline"
              onClick={() => window.open(modrinthUrl)}
              style={{ height: 32, padding: '0 14px', fontSize: 12, fontWeight: 600, color: accent, borderColor: accent, borderRadius: 'var(--radius-sm)' }}
            >
              {t.content.modrinth}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 20, lineHeight: 1, padding: 4 }}>✕</Button>
          </div>
        </div>

        {/* Gallery */}
        {gallery.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 22px', overflowX: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
            {gallery.map((img, i) => (
              <div
                key={i}
                onClick={() => setGalleryIndex(i)}
                style={{ flexShrink: 0, cursor: 'pointer', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-r)', height: 130 }}
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
              <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>{t.content.loading}</div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap' }}>
                {bodyText}
              </p>
            )}
          </div>

          {/* Sidebar */}
          <div style={{ width: 210, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Categories */}
            {project.categories.length > 0 && (
              <div>
                <SideLabel>{t.browse.categories}</SideLabel>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                  {project.categories.map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
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
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>{fmtDate(detail.published)}</div>
                {detail.updated && <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{t.browse.updatedOn(fmtDate(detail.updated))}</div>}
              </div>
            )}

            {/* Links */}
            {detail && (detail.issues_url || detail.source_url || detail.discord_url) && (
              <div>
                <SideLabel>{t.browse.links}</SideLabel>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {detail.issues_url && (
                    <Button variant="ghost" onClick={() => window.open(detail.issues_url!)} style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent)', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>
                      🐛 Issues ↗
                    </Button>
                  )}
                  {detail.source_url && (
                    <Button variant="ghost" onClick={() => window.open(detail.source_url!)} style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent)', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>
                      {'</>'} Source ↗
                    </Button>
                  )}
                  {detail.discord_url && (
                    <Button variant="ghost" onClick={() => window.open(detail.discord_url!)} style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent)', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>
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
                style={{ width: '100%', height: 36, fontSize: 14, fontWeight: 700, color: '#fff', background: accent }}
              >
                {btnLabel}
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
            style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-r)' }}
            onClick={e => e.stopPropagation()}
          />
          {gallery.length > 1 && (
            <>
              <Button
                variant="ghost"
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i - 1 + gallery.length) % gallery.length : 0) }}
                style={{ position: 'absolute', left: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44, padding: 0 }}
              >
                ‹
              </Button>
              <Button
                variant="ghost"
                onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i + 1) % gallery.length : 0) }}
                style={{ position: 'absolute', right: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44, padding: 0 }}
              >
                ›
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={e => { e.stopPropagation(); setGalleryIndex(null) }}
            style={{ position: 'absolute', top: 16, right: 20, fontSize: 22, color: '#fff' }}
          >
            ✕
          </Button>
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
  const t = useT()
  const tabLabelMap: Record<ContentTab, string> = {
    modpack: t.content.tabModpack,
    resourcepack: t.content.tabResourcepack,
    shader: t.content.tabShader,
    datapack: t.content.tabDatapack,
  }
  const [versions, setVersions]    = useState<ModrinthVersion[]>([])
  const [loading, setLoading]      = useState(true)
  const [selectedInst, setSelInst] = useState<Instance | null>(null)
  const [selectedVer, setSelVer]   = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    api.modrinth.versions(project.project_id)
      .then(v => { setVersions(v); setLoading(false) })
      .catch(() => setLoading(false))
  }, [project.project_id])

  const canInstall = selectedInst !== null && selectedVer !== null
  const tabInfo    = TABS.find(t => t.type === tab)!

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 660, maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {project.icon_url && <img src={project.icon_url} alt="" style={{ width: 28, height: 28, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.04em' }}>
              {t.content.addLabel(tabLabelMap[tab])}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{project.title}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>

        {tab === 'datapack' && (
          <div style={{ margin: '10px 18px 0', padding: '8px 12px', background: 'rgba(255,165,0,.1)', border: '1px solid rgba(255,165,0,.4)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--gold)', lineHeight: 1.45 }}>
            {t.content.datapackNote}
          </div>
        )}

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Instance picker */}
          <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>{t.content.selectInstance}</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {instances.length === 0
                ? <div style={{ padding: 16, fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>{t.content.noInstances}</div>
                : instances.map(inst => {
                    const active = selectedInst?.id === inst.id
                    return (
                      <Button key={inst.id} variant="secondary" onClick={() => setSelInst(inst)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: active ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', height: 'auto' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst.name}</div>
                        <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--ink-4)', marginTop: 1 }}>{inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}</div>
                      </Button>
                    )
                  })
              }
            </div>
          </div>

          {/* Version picker */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>{t.content.selectVersion}</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {loading
                ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.content.loading}</div>
                : versions.length === 0
                  ? <div style={{ padding: 30, textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>{t.content.noVersions}</div>
                  : versions.map(v => {
                      const isSel  = selectedVer === v.id
                      const mcOk   = selectedInst ? v.game_versions.includes(selectedInst.minecraftVersion) : true
                      return (
                        <Button key={v.id} variant="secondary" onClick={() => setSelVer(v.id)} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '7px 8px', marginBottom: 3, background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', height: 'auto', opacity: (!mcOk && !isSel) ? .45 : 1 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{v.version_number}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{v.game_versions.slice(0, 3).join(', ')}</div>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--ink-4)', flexShrink: 0, marginLeft: 8 }}>↓ {fmtNum(v.downloads)}</div>
                        </Button>
                      )
                    })
              }
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            {!selectedInst ? t.content.pickInstance : !selectedVer ? t.content.pickVersion : t.content.installingTo(selectedInst.name)}
          </div>
          <Button variant="primary" disabled={!canInstall} onClick={() => canInstall && onInstall(selectedInst!.id, selectedVer!)} style={{ fontSize: 14, fontWeight: 700, padding: '0 24px', height: 34, borderRadius: 'var(--radius-sm)' }}>
            {t.content.install}
          </Button>
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
  const t = useT()
  const [versions, setVersions]  = useState<ModrinthVersion[]>([])
  const [loading, setLoading]    = useState(true)
  const [name, setName]          = useState(project.title)
  const [selectedVer, setSelVer] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 520, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {project.icon_url && <img src={project.icon_url} alt="" style={{ width: 32, height: 32, imageRendering: 'pixelated', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ender)', letterSpacing: '.04em' }}>{t.content.installModpackTitle}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{project.title}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Instance name */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.instanceName}</div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              style={{ width: '100%', height: 34, background: 'var(--bg)', border: '1px solid var(--border-r)', color: 'var(--ink)', padding: '0 10px', outline: 'none', fontSize: 13, borderRadius: 'var(--radius-md)' }}
            />
          </div>

          {/* Version picker */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.version}</div>
            {loading
              ? <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.content.loadingVersions}</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {versions.map(v => {
                    const isSel     = selectedVer === v.id
                    const loaderName = v.loaders.find(l => l !== 'mrpack')
                    return (
                      <Button key={v.id} variant="secondary" onClick={() => setSelVer(v.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', textAlign: 'left', background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', height: 'auto' }}>
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
                      </Button>
                    )
                  })}
                </div>
            }
          </div>

          {/* Detected info */}
          {ver && (
            <div style={{ display: 'flex', gap: 8 }}>
              {mcVer && (
                <span style={{ fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.04em', color: 'var(--diamond)', background: 'rgba(79,184,232,.1)', border: '1px solid rgba(79,184,232,.3)', borderRadius: 'var(--radius-sm)', padding: '2px 8px' }}>
                  MC {mcVer}
                </span>
              )}
              {loader && (
                <span style={{ fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.04em', color: 'var(--accent)', background: 'var(--accent-tint)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', padding: '2px 8px' }}>
                  {loaderLabel(loader)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} style={{ flex: 1, height: 36, background: 'var(--surface-2)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}>{t.content.cancel}</Button>
          <Button variant="primary" disabled={!canInstall} onClick={() => canInstall && onInstall(name.trim(), selectedVer!)} style={{ flex: 2, height: 36, fontSize: 14, fontWeight: 700, color: '#fff', background: 'var(--ender)', borderRadius: 'var(--radius-sm)' }}>
            {t.content.createInstance}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Progress overlay ─────────────────────────────────────────────────────────

function ProgressOverlay({ title, step, percent }: { projectId: string; title: string; step: string; percent: number }) {
  const t = useT()
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 95,
      width: 320, pointerEvents: 'none',
    }}>
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius-lg)', padding: '14px 16px',
        display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: 'var(--shadow-floating)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', color: 'var(--ender)' }}>
            {t.content.installingModpack}
          </div>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'var(--ender)' }}>{Math.round(percent)}%</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ height: 6, background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${percent}%`, background: 'var(--ender)', transition: 'width .2s', borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step}</div>
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
  const [cfSource, setCfSource]           = useState<'modrinth' | 'curseforge' | 'ftb'>('modrinth')
  const [cfResults, setCfResults]         = useState<CFProject[]>([])
  const [cfTotal, setCfTotal]             = useState(0)
  const [cfHasKey, setCfHasKey]           = useState(true)
  const [cfInstallTarget, setCfInstall]   = useState<CFProject | null>(null)
  const [cfDetailTarget, setCfDetail]     = useState<CFProject | null>(null)
  const [ftbResults, setFtbResults]       = useState<FtbModpack[]>([])
  const [ftbInstallTarget, setFtbInstall] = useState<FtbModpack | null>(null)

  const t = useT()
  const tabLabels: Record<ContentTab, string> = {
    modpack:      t.content.tabModpack,
    resourcepack: t.content.tabResourcepack,
    shader:       t.content.tabShader,
    datapack:     t.content.tabDatapack,
  }

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabInfo   = TABS.find(ti => ti.type === tab)!

  useEffect(() => {
    api.instance.list().then(setInstances).catch(() => {})
    api.config.get().then(c => setCfHasKey(!!c.curseforgeApiKey)).catch(() => {})
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

  useEffect(() => { setOffset(0) }, [tab, sort, gameVersion, loader, cfSource])

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => doSearch(0), query ? 400 : 0)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  }, [query, tab, sort, gameVersion, loader, cfSource])

  const doSearch = useCallback(async (newOffset: number) => {
    setLoading(true)
    setOffset(newOffset)

    if (tab === 'modpack' && cfSource === 'curseforge') {
      try {
        const res = await api.curseforge.searchModpacks(query || undefined, gameVersion ?? undefined, LIMIT, newOffset)
        setCfResults(res.data as CFProject[])
        setCfTotal(res.pagination.totalCount)
      } catch { setCfResults([]); setCfTotal(0) }
      finally { setLoading(false) }
      return
    }

    if (tab === 'modpack' && cfSource === 'ftb') {
      try {
        setFtbResults(await api.ftb.search(query || undefined, LIMIT))
      } catch { setFtbResults([]) }
      finally { setLoading(false) }
      return
    }

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
  }, [query, tab, sort, gameVersion, loader, cfSource])

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
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: '0 0 3px' }}>{t.content.title}</h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>{t.content.subtitle}</p>
      </div>

      {/* Type tabs + source toggle */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: 4 }}>
        {TABS.map(tabItem => (
          <Button key={tabItem.type} variant="ghost" onClick={() => { setTab(tabItem.type as ContentTab); setQuery(''); setLoader(null) }} style={{
            flex: 1, height: 32, gap: 6,
            fontSize: 12, fontWeight: 700, letterSpacing: '.1em',
            color: tab === tabItem.type ? '#fff' : 'var(--ink-3)',
            background: tab === tabItem.type ? (tabItem.type === 'modpack' ? 'var(--ender)' : 'var(--accent)') : 'transparent',
            borderRadius: 'var(--radius-sm)',
          }}>
            {tabLabels[tabItem.type as ContentTab].toUpperCase()}
          </Button>
        ))}
        </div>
        {tab === 'modpack' && (
          <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: 4, gap: 3, flexShrink: 0 }}>
            {(['modrinth', 'curseforge', 'ftb'] as const).map(src => (
              <Button key={src} variant="ghost" onClick={() => { setCfSource(src); setQuery('') }} style={{
                height: 28, padding: '0 12px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
                color: cfSource === src ? '#fff' : 'var(--ink-3)',
                background: cfSource === src ? (src === 'curseforge' ? '#f16436' : src === 'ftb' ? '#1f9ed1' : 'var(--accent)') : 'transparent',
                borderRadius: 'var(--radius-sm)',
              }}>
                {src === 'modrinth' ? 'Modrinth' : src === 'curseforge' ? 'CurseForge' : 'FTB'}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 240px', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: '0 10px', height: 36 }}>
          <div style={{ color: 'var(--ink-4)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><SearchIcon /></div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t.content.searchPlaceholder(tabLabels[tab])}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: 'var(--ink)' }}
          />
          {query && <Button variant="ghost" size="icon" onClick={() => setQuery('')} style={{ color: 'var(--ink-4)', fontSize: 12, padding: 2 }}>✕</Button>}
        </div>
        <SortDropdown value={sort} onChange={s => setSort(s)} />
        <VersionDropdown value={gameVersion} onChange={v => { setVersion(v); setOffset(0) }} />
        {tabInfo.showLoader && (
          <div style={{ display: 'flex', gap: 4 }}>
            <Button variant="outline" onClick={() => setLoader(null)} style={{ fontSize: 11, fontWeight: 500, color: loader === null ? 'var(--accent)' : 'var(--ink-4)', background: loader === null ? 'var(--accent-tint)' : 'var(--surface)', borderColor: loader === null ? 'var(--accent)' : 'var(--border-r)', borderRadius: 'var(--radius-sm)', padding: '3px 8px' }}>
              {t.content.allLoaders}
            </Button>
            {LOADERS.map(l => (
              <Button key={l} variant="outline" onClick={() => setLoader(loader === l ? null : l)} style={{ fontSize: 11, fontWeight: 500, color: loader === l ? 'var(--accent)' : 'var(--ink-4)', background: loader === l ? 'var(--accent-tint)' : 'var(--surface)', borderColor: loader === l ? 'var(--accent)' : 'var(--border-r)', borderRadius: 'var(--radius-sm)', padding: '3px 8px' }}>
                {loaderLabel(l)}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Results count */}
      <div style={{ fontSize: 11, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
        {loading ? t.content.searching : (tab === 'modpack' && cfSource === 'curseforge')
          ? t.content.cfModpacksFound.replace('{{n}}', cfTotal.toLocaleString())
          : (tab === 'modpack' && cfSource === 'ftb')
          ? t.content.cfModpacksFound.replace('{{n}}', ftbResults.length.toLocaleString())
          : t.content.found(total, tabLabels[tab])}
      </div>

      {/* CurseForge — no key warning */}
      {tab === 'modpack' && cfSource === 'curseforge' && !cfHasKey && !loading && (
        <div style={{ padding: '40px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-4)', letterSpacing: '.04em' }}>{t.browse.noApiKey}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.browse.noApiKeyDesc}</div>
          <a href="/settings" onClick={e => { e.preventDefault(); window.location.hash = '/settings' }} style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t.browse.goToSettings}</a>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.content.loading}</div>
      ) : tab === 'modpack' && cfSource === 'curseforge' ? (
        cfHasKey && (cfResults.length === 0
          ? <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.content.cfNoModpacks}</div>
          : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {cfResults.map(p => (
                <CFModpackCard
                  key={p.id}
                  project={p}
                  installing={installingId === `cf:${p.id}`}
                  onDetail={() => setCfDetail(p)}
                  onInstall={() => setCfInstall(p)}
                />
              ))}
            </div>)
      ) : tab === 'modpack' && cfSource === 'ftb' ? (
        ftbResults.length === 0
          ? <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>{t.content.cfNoModpacks}</div>
          : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {ftbResults.map(p => (
                <FTBModpackCard
                  key={p.id}
                  pack={p}
                  installing={installingId === `ftb:${p.id}`}
                  onInstall={() => setFtbInstall(p)}
                />
              ))}
            </div>
      ) : results.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
          {t.content.noContent(tabLabels[tab])}
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

      {/* Pagination (FTB search returns a flat list — no paging) */}
      {!(tab === 'modpack' && cfSource === 'ftb') && (tab === 'modpack' && cfSource === 'curseforge'
        ? Math.ceil(cfTotal / LIMIT)
        : totalPages) > 1 && (() => {
          const pages = tab === 'modpack' && cfSource === 'curseforge' ? Math.ceil(cfTotal / LIMIT) : totalPages
          return (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', paddingTop: 4 }}>
              <PageBtn disabled={currentPage === 0} onClick={() => doSearch((currentPage - 1) * LIMIT)}>←</PageBtn>
              <PageJumper current={currentPage} total={pages} onGo={p => doSearch(p * LIMIT)} />
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, color: 'var(--ink-3)', letterSpacing: '.06em' }}>
                / {pages}
              </span>
              <PageBtn disabled={currentPage >= pages - 1} onClick={() => doSearch((currentPage + 1) * LIMIT)}>→</PageBtn>
            </div>
          )
        })()}

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

      {/* CurseForge modpack detail modal */}
      {cfDetailTarget && (
        <CFModpackDetailModal
          project={cfDetailTarget}
          onClose={() => setCfDetail(null)}
          onInstall={() => { setCfDetail(null); setCfInstall(cfDetailTarget) }}
        />
      )}

      {/* CurseForge modpack install modal */}
      {cfInstallTarget && (
        <CFModpackInstallModal
          project={cfInstallTarget}
          onClose={() => setCfInstall(null)}
          onInstall={(name, fileId) => {
            const projectId = `cf:${cfInstallTarget.id}`
            setCfInstall(null)
            setInstallingId(projectId)
            setProgress({ projectId, title: cfInstallTarget.name, step: 'Starting…', percent: 0 })
            api.curseforge.installModpack(name, cfInstallTarget.id, fileId).catch(e => {
              setProgress(null)
              setInstallingId(null)
              showToast(e instanceof Error ? e.message : 'Install failed', false)
            })
          }}
        />
      )}

      {/* FTB modpack install modal */}
      {ftbInstallTarget && (
        <FTBInstallModal
          pack={ftbInstallTarget}
          onClose={() => setFtbInstall(null)}
          onInstall={(name, versionId) => {
            const projectId = `ftb:${ftbInstallTarget.id}`
            const packId = ftbInstallTarget.id
            setFtbInstall(null)
            setInstallingId(projectId)
            setProgress({ projectId, title: ftbInstallTarget.name, step: 'Starting…', percent: 0 })
            api.ftb.installModpack(name, packId, versionId).catch(e => {
              setProgress(null)
              setInstallingId(null)
              showToast(e instanceof Error ? e.message : 'Install failed', false)
            })
          }}
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
        <div style={{ position: 'fixed', bottom: 44, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-floating)', fontSize: 13, color: 'var(--ink)', zIndex: 100 }}>
          <div style={{ width: 8, height: 8, background: toast.ok ? 'var(--grass)' : 'var(--lava)', flexShrink: 0 }} />
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── CurseForge modpack card ──────────────────────────────────────────────────

function CFModpackCard({ project, installing, onDetail, onInstall }: { project: CFProject; installing: boolean; onDetail: () => void; onInstall: () => void }) {
  const t = useT()
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onDetail}
      style={{
        background: 'var(--surface)', border: `1px solid ${hover ? '#f16436' : 'var(--border-r)'}`,
        borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        transition: 'border-color 120ms', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', gap: 10, padding: '12px 12px 8px', alignItems: 'flex-start' }}>
        <div style={{ width: 48, height: 48, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {project.logo?.thumbnailUrl
            ? <img src={project.logo.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>📦</div>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', letterSpacing: '.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>by {project.authors[0]?.name ?? 'Unknown'}</div>
          <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>↓ {fmtNum(project.downloadCount)}  ·  {fmtDate(project.dateModified)}</div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 12px 10px', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {project.summary}
      </p>
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {project.categories.slice(0, 2).map(c => <Tag key={c.id} color="var(--ink-4)">{c.name}</Tag>)}
        </div>
        <Button variant="primary" onClick={e => { e.stopPropagation(); onInstall() }} disabled={installing} style={{ fontSize: 14, fontWeight: 700, color: '#fff', background: '#f16436', padding: '0 28px', height: 36, borderRadius: 'var(--radius-sm)', flexShrink: 0 }}>
          {installing ? '…' : t.content.install}
        </Button>
      </div>
    </div>
  )
}

// ─── FTB modpack card ────────────────────────────────────────────────────────

function FTBModpackCard({ pack, installing, onInstall }: { pack: FtbModpack; installing: boolean; onInstall: () => void }) {
  const t = useT()
  const [hover, setHover] = useState(false)
  const icon = ftbIconUrl(pack)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onInstall}
      style={{
        background: 'var(--surface)', border: `1px solid ${hover ? '#1f9ed1' : 'var(--border-r)'}`,
        borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        transition: 'border-color 120ms', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', gap: 10, padding: '12px 12px 8px', alignItems: 'flex-start' }}>
        <div style={{ width: 48, height: 48, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {icon
            ? <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>📦</div>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', letterSpacing: '.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pack.name}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>by {pack.authors[0]?.name ?? 'FTB'}</div>
          {typeof pack.installs === 'number' && <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>↓ {fmtNum(pack.installs)}</div>}
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 12px 10px', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {pack.synopsis}
      </p>
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {pack.tags.slice(0, 2).map(c => <Tag key={c.id} color="var(--ink-4)">{c.name}</Tag>)}
        </div>
        <Button variant="primary" onClick={e => { e.stopPropagation(); onInstall() }} disabled={installing} style={{ fontSize: 14, fontWeight: 700, color: '#fff', background: '#1f9ed1', padding: '0 28px', height: 36, borderRadius: 'var(--radius-sm)', flexShrink: 0 }}>
          {installing ? '…' : t.content.install}
        </Button>
      </div>
    </div>
  )
}

// ─── FTB modpack install modal ───────────────────────────────────────────────

function FTBInstallModal({ pack, onClose, onInstall }: {
  pack: FtbModpack
  onClose: () => void
  onInstall: (name: string, versionId: number) => void
}) {
  const t = useT()
  const [name, setName] = useState(pack.name)
  // Versions come oldest-first from the API — show newest at the top.
  const versions = [...(pack.versions ?? [])].reverse()
  const [selVer, setSelVer] = useState<number | null>(versions[0]?.id ?? null)
  const icon = ftbIconUrl(pack)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const canInstall = name.trim().length > 0 && selVer !== null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 480, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {icon && <img src={icon} alt="" style={{ width: 32, height: 32, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#1f9ed1', letterSpacing: '.04em' }}>FTB · {t.content.cfInstallTitle}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{pack.name}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.instanceName}</div>
            <input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', height: 34, background: 'var(--bg)', border: '1px solid var(--border-r)', color: 'var(--ink)', padding: '0 10px', outline: 'none', fontSize: 13, borderRadius: 'var(--radius-md)' }} />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.version}</div>
            {versions.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.content.cfNoModpacks}</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {versions.map(v => {
                    const isSel = selVer === v.id
                    const tg = ftbTargets(v.targets)
                    const meta = [tg.minecraft, tg.modLoader].filter(Boolean).join(' · ')
                    return (
                      <Button key={v.id} variant="secondary" onClick={() => setSelVer(v.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', textAlign: 'left', background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', height: 'auto' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{meta}</div>
                        </div>
                        {v.type && v.type !== 'release' && <div style={{ flexShrink: 0, fontSize: 10, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{v.type}</div>}
                      </Button>
                    )
                  })}
                </div>
            }
          </div>
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} style={{ height: 34, padding: '0 14px', background: 'var(--surface-2)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>{t.content.cancel}</Button>
          <Button variant="primary" disabled={!canInstall} onClick={() => canInstall && onInstall(name.trim(), selVer!)} style={{ height: 34, padding: '0 20px', fontSize: 14, fontWeight: 700, color: '#fff', background: '#1f9ed1', borderRadius: 'var(--radius-sm)' }}>
            {t.content.install}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── CurseForge modpack install modal ────────────────────────────────────────

function CFModpackInstallModal({ project, onClose, onInstall }: {
  project: CFProject
  onClose: () => void
  onInstall: (name: string, fileId: number) => void
}) {
  const t = useT()
  const [name, setName]       = useState(project.name)
  const [files, setFiles]     = useState<CFFile[]>([])
  const [loading, setLoading] = useState(true)
  const [selFile, setSelFile] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    api.curseforge.files(project.id)
      .then(f => { setFiles(f); setSelFile(f[0]?.id ?? null); setLoading(false) })
      .catch(() => setLoading(false))
  }, [project.id])

  const canInstall = name.trim().length > 0 && selFile !== null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', width: 480, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {project.logo?.thumbnailUrl && <img src={project.logo.thumbnailUrl} alt="" style={{ width: 32, height: 32, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f16436', letterSpacing: '.04em' }}>{t.content.cfInstallTitle}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{project.name}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 16 }}>✕</Button>
        </div>
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.instanceName}</div>
            <input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', height: 34, background: 'var(--bg)', border: '1px solid var(--border-r)', color: 'var(--ink)', padding: '0 10px', outline: 'none', fontSize: 13, borderRadius: 'var(--radius-md)' }} />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{t.content.version}</div>
            {loading
              ? <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{t.content.loadingVersions}</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {files.map(f => {
                    const isSel = selFile === f.id
                    const mcVer = f.gameVersions.find(v => /^\d+\.\d+/.test(v))
                    return (
                      <Button key={f.id} variant="secondary" onClick={() => setSelFile(f.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', textAlign: 'left', background: isSel ? 'var(--accent-tint)' : 'var(--surface-2)', border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border-r)'}`, borderRadius: 'var(--radius-sm)', height: 'auto' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.displayName}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 1 }}>{mcVer ?? ''}</div>
                        </div>
                        <div style={{ flexShrink: 0, fontSize: 11, color: 'var(--ink-4)' }}>↓ {fmtNum(f.downloadCount)}</div>
                      </Button>
                    )
                  })}
                </div>
            }
          </div>
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} style={{ height: 34, padding: '0 14px', background: 'var(--surface-2)', color: 'var(--ink-3)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>{t.content.cancel}</Button>
          <Button variant="primary" disabled={!canInstall} onClick={() => canInstall && onInstall(name.trim(), selFile!)} style={{ height: 34, padding: '0 20px', fontSize: 14, fontWeight: 700, color: '#fff', background: '#f16436', borderRadius: 'var(--radius-sm)' }}>
            {t.content.install}
          </Button>
        </div>
      </div>
    </div>
  )
}


// ─── CurseForge modpack detail modal ─────────────────────────────────────────

function CFModpackDetailModal({ project, onClose, onInstall }: {
  project: CFProject
  onClose: () => void
  onInstall: () => void
}) {
  const t = useT()
  const [detail, setDetail]           = useState<CFProjectDetail | null>(null)
  const [loading, setLoading]         = useState(true)
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
    api.curseforge.projectDetail(project.id)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [project.id])

  const screenshots = detail?.screenshots ?? []
  const bodyText    = detail?.description ? stripMarkdown(detail.description) : project.summary
  const cfUrl       = project.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/modpacks/${project.slug}`
  const mcVersions  = [...new Set((project.latestFilesIndexes ?? []).map(f => f.gameVersion).filter(Boolean))].slice(0, 3)

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '86vw', maxWidth: 960, maxHeight: '90vh', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
          <div style={{ width: 72, height: 72, flexShrink: 0, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-2)' }}>
            {project.logo?.thumbnailUrl ? <img src={project.logo.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>📦</div>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>{project.name}</div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--ink-3)', flexWrap: 'wrap', marginBottom: 5 }}>
              <span>↓ {fmtNum(project.downloadCount)} downloads</span>
              {project.authors[0] && <span>by {project.authors[0].name}</span>}
              <span>Updated {fmtDate(project.dateModified)}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {project.categories.slice(0, 4).map(c => <Tag key={c.id} color="#f16436">{c.name}</Tag>)}
              {mcVersions.length > 0 && <Tag color="var(--diamond)">MC {mcVersions[0]}{mcVersions.length > 1 ? ` – ${mcVersions[mcVersions.length - 1]}` : ''}</Tag>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-start' }}>
            <Button variant="outline" onClick={() => window.open(cfUrl)} style={{ height: 32, padding: '0 14px', fontSize: 12, fontWeight: 600, color: '#f16436', borderColor: '#f16436', borderRadius: 'var(--radius-sm)' }}>CurseForge ↗</Button>
            <Button variant="ghost" size="icon" onClick={onClose} style={{ color: 'var(--ink-4)', fontSize: 20, lineHeight: 1, padding: 4 }}>✕</Button>
          </div>
        </div>

        {screenshots.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 22px', overflowX: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
            {screenshots.map((s, i) => (
              <div key={s.id} onClick={() => setGalleryIndex(i)} style={{ flexShrink: 0, cursor: 'pointer', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-r)', height: 130 }}>
                <img src={s.thumbnailUrl} alt={s.title} style={{ height: '100%', width: 'auto', display: 'block', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
            {loading ? (
              <div style={{ color: 'var(--ink-4)', fontSize: 13 }}>{t.content.loading}</div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{bodyText}</div>
            )}
          </div>
          <div style={{ width: 200, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <SideLabel>Categories</SideLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {project.categories.map(c => <div key={c.id} style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.name}</div>)}
              </div>
            </div>
            {(project.links?.websiteUrl || project.links?.issuesUrl || project.links?.sourceUrl) && (
              <div>
                <SideLabel>Links</SideLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  {project.links.websiteUrl && <Button variant="ghost" onClick={() => window.open(project.links.websiteUrl!)} style={{ fontSize: 11, fontWeight: 500, color: '#f16436', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>CurseForge ↗</Button>}
                  {project.links.issuesUrl  && <Button variant="ghost" onClick={() => window.open(project.links.issuesUrl!)}  style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent)', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>Issues ↗</Button>}
                  {project.links.sourceUrl  && <Button variant="ghost" onClick={() => window.open(project.links.sourceUrl!)}  style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent)', textAlign: 'left', justifyContent: 'flex-start', padding: 0, height: 'auto' }}>Source ↗</Button>}
                </div>
              </div>
            )}
            <div>
              <SideLabel>Created</SideLabel>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>{fmtDate(project.dateCreated)}</div>
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 10 }}>
              <Button variant="primary" onClick={onInstall} style={{ width: '100%', height: 36, fontSize: 14, fontWeight: 700, color: '#fff', background: '#f16436', borderRadius: 'var(--radius-md)' }}>
                {t.content.install}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {galleryIndex !== null && screenshots[galleryIndex] && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { e.stopPropagation(); setGalleryIndex(null) }}>
          <img src={screenshots[galleryIndex].url} alt="" style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 'var(--radius-md)' }} onClick={e => e.stopPropagation()} />
          {screenshots.length > 1 && (
            <>
              <Button variant="ghost" onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i - 1 + screenshots.length) % screenshots.length : 0) }} style={{ position: 'absolute', left: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44, padding: 0 }}>&#x2039;</Button>
              <Button variant="ghost" onClick={e => { e.stopPropagation(); setGalleryIndex(i => i !== null ? (i + 1) % screenshots.length : 0) }} style={{ position: 'absolute', right: 24, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,.5)', borderRadius: '50%', width: 44, height: 44, padding: 0 }}>&#x203A;</Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={e => { e.stopPropagation(); setGalleryIndex(null) }} style={{ position: 'absolute', top: 16, right: 20, fontSize: 22, color: '#fff' }}>&#x2715;</Button>
        </div>
      )}
    </div>
  )
}
