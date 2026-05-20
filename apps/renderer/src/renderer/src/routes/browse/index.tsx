import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { SearchIcon } from '@/components/ui/BlockIcons'
import { api } from '@/lib/api'
import type { ModrinthProject, ModrinthVersion, Instance } from '@refract/core'

export const Route = createFileRoute('/browse/')({
  component: Browse,
})

const CATEGORIES = ['All', 'Performance', 'Utility', 'Magic', 'Technology', 'Adventure', 'Decoration']
const LOADERS = ['All', 'fabric', 'forge', 'quilt', 'neoforge']
const LOADER_COLOR: Record<string, string> = {
  fabric: '#b8a892', forge: '#4b8fc4', quilt: '#b070b0', neoforge: '#e8883c',
}

// ─── MC Version Dropdown ─────────────────────────────────────────────────────

function VersionDropdown({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
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
      <button
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontWeight: 500,
          fontSize: active ? 13 : 11,
          fontFamily: active ? "'VT323',monospace" : 'inherit',
          letterSpacing: active ? '.04em' : 'inherit',
          color: active ? 'var(--diamond)' : 'var(--ink-4)',
          background: active ? 'rgba(79,184,232,.12)' : 'var(--surface)',
          border: `1px solid ${active ? 'var(--diamond)' : 'var(--border-r)'}`,
          borderRadius: 3, padding: '3px 10px', cursor: 'pointer',
        } as React.CSSProperties}
      >
        {active ? `MC ${value}` : 'All versions'}
        <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          width: 140, maxHeight: 260, overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Clear */}
          <button
            onClick={() => { onChange(null); setOpen(false) }}
            style={{
              padding: '7px 12px', textAlign: 'left', fontSize: 12,
              color: value === null ? 'var(--accent)' : 'var(--ink-3)',
              background: value === null ? 'var(--accent-tint)' : 'transparent',
              border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer',
            }}
          >
            All versions
          </button>

          {loading ? (
            <div style={{ padding: '12px', fontSize: 11, color: 'var(--ink-4)', textAlign: 'center' }}>Loading…</div>
          ) : (
            versions.map(ver => (
              <button
                key={ver}
                onClick={() => { onChange(ver); setOpen(false) }}
                style={{
                  padding: '6px 12px', textAlign: 'left',
                  fontFamily: "'VT323',monospace", fontSize: 14, letterSpacing: '.04em',
                  color: value === ver ? 'var(--diamond)' : 'var(--ink-2)',
                  background: value === ver ? 'rgba(79,184,232,.12)' : 'transparent',
                  border: 'none', cursor: 'pointer',
                }}
              >
                {ver}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

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

  // Exact match: right MC version AND right loader
  const exact = versions.filter(v =>
    v.game_versions.includes(mcVer) &&
    (!loader || v.loaders.some(l => l.toLowerCase() === loader))
  )
  if (exact.length > 0) return exact[0]

  // Fallback: at least right MC version
  const mcOnly = versions.filter(v => v.game_versions.includes(mcVer))
  if (mcOnly.length > 0) return mcOnly[0]

  return null
}

function versionCompatibility(v: ModrinthVersion, instance: Instance | null): 'best' | 'compatible' | 'partial' | 'incompatible' {
  if (!instance) return 'compatible'
  const mcOk = v.game_versions.includes(instance.minecraftVersion)
  const loader = instance.modLoader?.toLowerCase()
  const loaderOk = !loader || v.loaders.some(l => l.toLowerCase() === loader)

  if (mcOk && loaderOk) return 'compatible'
  if (mcOk && !loaderOk) return 'partial'
  return 'incompatible'
}

// ─── Install modal ──────────────────────────────────────────────────────────

interface InstallModalProps {
  mod: ModrinthProject
  instances: Instance[]
  onClose: () => void
  onInstall: (instanceId: string, versionId: string) => void
}

function InstallModal({ mod, instances, onClose, onInstall }: InstallModalProps) {
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  useEffect(() => {
    setLoadingVersions(true)
    api.modrinth.versions(mod.project_id)
      .then(v => {
        setVersions(v)
        setLoadingVersions(false)
      })
      .catch(() => setLoadingVersions(false))
  }, [mod.project_id])

  // Auto-select best version when instance changes
  useEffect(() => {
    if (!selectedInstance || versions.length === 0) return
    const best = bestVersionForInstance(versions, selectedInstance)
    if (best) setSelectedVersionId(best.id)
  }, [selectedInstance, versions])

  const canInstall = selectedInstance !== null && selectedVersionId !== null

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)', width: 680, maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {mod.icon_url && (
            <img src={mod.icon_url} alt="" style={{ width: 32, height: 32, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'VT323',monospace", fontSize: 18, color: 'var(--accent)', letterSpacing: '.1em' }}>INSTALL MOD</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{mod.title}</div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left: Instance picker */}
          <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>
              1. Select Instance
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {instances.length === 0 ? (
                <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--ink-4)', textAlign: 'center' }}>No instances yet.</div>
              ) : instances.map(inst => {
                const active = selectedInstance?.id === inst.id
                const alreadyHas = inst.mods?.some(m => m.projectId === mod.project_id)
                return (
                  <button
                    key={inst.id}
                    onClick={() => setSelectedInstance(inst)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 10px', marginBottom: 4,
                      background: active ? 'var(--accent-tint)' : 'var(--surface-2)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border-r)'}`,
                      borderRadius: 3, cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{inst.name}</span>
                      {alreadyHas && <span style={{ fontSize: 9, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 2, padding: '0 3px', flexShrink: 0 }}>✓</span>}
                    </div>
                    <div style={{ fontFamily: "'VT323',monospace", fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
                      {inst.minecraftVersion} · {inst.modLoader?.toUpperCase() ?? 'VANILLA'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right: Version picker */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px 6px', fontSize: 10, fontWeight: 600, letterSpacing: '.12em', color: 'var(--ink-4)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
              2. Select Version
              {selectedInstance && (
                <span style={{ fontFamily: "'VT323',monospace", fontSize: 12, color: 'var(--ink-3)', letterSpacing: '.04em', textTransform: 'none', fontWeight: 400 }}>
                  — for {selectedInstance.minecraftVersion} {selectedInstance.modLoader?.toUpperCase() ?? 'VANILLA'}
                </span>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
              {loadingVersions ? (
                <div style={{ padding: '30px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>Loading versions…</div>
              ) : versions.length === 0 ? (
                <div style={{ padding: '30px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-4)' }}>No versions found.</div>
              ) : versions.map(v => {
                const compat = versionCompatibility(v, selectedInstance)
                const isBest = selectedInstance
                  ? bestVersionForInstance(versions, selectedInstance)?.id === v.id
                  : false
                const isSelected = selectedVersionId === v.id
                const dimmed = compat === 'incompatible' && !isSelected

                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVersionId(v.id)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                      width: '100%', textAlign: 'left',
                      padding: '8px 10px', marginBottom: 4,
                      background: isBest ? 'rgba(91,156,58,.12)' : isSelected ? 'var(--accent-tint)' : 'var(--surface-2)',
                      border: `1px solid ${isBest ? 'var(--grass)' : isSelected ? 'var(--accent)' : 'var(--border-r)'}`,
                      borderRadius: 3, cursor: 'pointer',
                      opacity: dimmed ? 0.45 : 1,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{v.version_number}</span>
                        {isBest && (
                          <span style={{
                            fontFamily: "'VT323',monospace", fontSize: 11, letterSpacing: '.06em',
                            color: '#fff', background: 'var(--grass)',
                            padding: '0 5px', borderRadius: 2,
                          }}>
                            RECOMMENDED
                          </span>
                        )}
                        {compat === 'partial' && !isBest && (
                          <span style={{ fontSize: 10, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 2, padding: '0 4px' }}>
                            loader mismatch
                          </span>
                        )}
                        {compat === 'incompatible' && (
                          <span style={{ fontSize: 10, color: 'var(--redstone)', border: '1px solid var(--redstone)', borderRadius: 2, padding: '0 4px' }}>
                            incompatible
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span>{v.game_versions.slice(0, 3).join(', ')}{v.game_versions.length > 3 ? '…' : ''}</span>
                        <span>·</span>
                        <span>{v.loaders.join(', ')}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                      <div style={{ fontFamily: "'VT323',monospace", fontSize: 12, color: 'var(--ink-4)' }}>↓ {formatDownloads(v.downloads)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>{formatDate(v.date_published)}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>
            {!selectedInstance && 'Select an instance'}
            {selectedInstance && !selectedVersionId && 'Select a version'}
            {canInstall && `Installing to "${selectedInstance!.name}"`}
          </div>
          <button
            disabled={!canInstall}
            onClick={() => canInstall && onInstall(selectedInstance!.id, selectedVersionId!)}
            style={{
              fontFamily: "'VT323',monospace", fontSize: 18, letterSpacing: '.1em',
              color: canInstall ? '#fff' : 'var(--ink-4)',
              background: canInstall ? 'var(--accent)' : 'var(--surface-3)',
              border: 'none', cursor: canInstall ? 'pointer' : 'not-allowed',
              padding: '0 28px', height: 36,
              boxShadow: canInstall ? 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)' : 'none',
            }}
          >
            INSTALL
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Browse ──────────────────────────────────────────────────────────────────

function Browse() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [loader, setLoader] = useState('All')
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const LIMIT = 18

  const [instances, setInstances] = useState<Instance[]>([])
  const [installTarget, setInstallTarget] = useState<ModrinthProject | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.instance.list().then(setInstances).catch(() => setInstances([]))
  }, [])

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => doSearch(0), query ? 400 : 0)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  }, [query, category, loader, gameVersion])

  async function doSearch(newOffset: number) {
    setLoading(true)
    setOffset(newOffset)
    try {
      const gameLoader = loader !== 'All' ? loader : undefined
      const facetCat = category !== 'All' ? category.toLowerCase() : undefined
      const res = await api.modrinth.search(query, gameVersion ?? undefined, gameLoader, facetCat, LIMIT, newOffset)
      setResults(res.hits)
      setTotal(res.total_hits)
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

  async function handleInstall(instanceId: string, versionId: string) {
    if (!installTarget) return
    const modName = installTarget.title
    setInstallTarget(null)
    setInstallingId(installTarget.project_id)
    try {
      await api.modrinth.install(instanceId, installTarget.project_id, modName, versionId)
      showToast(`${modName} installed successfully!`, true)
      api.instance.list().then(setInstances).catch(() => {})
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Install failed', false)
    } finally {
      setInstallingId(null)
    }
  }

  const totalPages = Math.ceil(total / LIMIT)
  const currentPage = Math.floor(offset / LIMIT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: '0 0 3px' }}>Browse Mods</h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>Discover and install mods from Modrinth</p>
      </div>

      {/* Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: '0 12px', height: 38 }}>
        <div style={{ color: 'var(--ink-4)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><SearchIcon /></div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search mods, authors…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: 'var(--ink)' }}
        />
        {query && <button onClick={() => setQuery('')} style={{ color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>✕</button>}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {CATEGORIES.map(cat => (
            <FilterChip key={cat} active={category === cat} onClick={() => setCategory(cat)}>{cat}</FilterChip>
          ))}
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--border-r)' }} />
        <VersionDropdown value={gameVersion} onChange={v => { setGameVersion(v); setOffset(0) }} />
        <div style={{ width: 1, height: 18, background: 'var(--border-r)' }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {LOADERS.map(l => (
            <FilterChip key={l} active={loader === l} onClick={() => setLoader(l)} color={LOADER_COLOR[l]}>
              {l === 'All' ? 'All loaders' : l}
            </FilterChip>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
        {loading ? 'Searching…' : `${total.toLocaleString()} mods found`}
      </div>

      {loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>Loading…</div>
      ) : results.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>No mods found. Try a different search.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {results.map(mod => (
            <ModTile
              key={mod.project_id}
              mod={mod}
              installing={installingId === mod.project_id}
              installedInInstances={instances.filter(i => i.mods?.some(m => m.projectId === mod.project_id)).length}
              onInstall={() => setInstallTarget(mod)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', paddingTop: 4 }}>
          <PageBtn disabled={currentPage === 0} onClick={() => doSearch((currentPage - 1) * LIMIT)}>←</PageBtn>
          <span style={{ fontFamily: "'VT323',monospace", fontSize: 16, color: 'var(--ink-3)', alignSelf: 'center', letterSpacing: '.06em' }}>
            {currentPage + 1} / {totalPages}
          </span>
          <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => doSearch((currentPage + 1) * LIMIT)}>→</PageBtn>
        </div>
      )}

      {installTarget && (
        <InstallModal
          mod={installTarget}
          instances={instances}
          onClose={() => setInstallTarget(null)}
          onInstall={handleInstall}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 44, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px', background: 'var(--surface-2)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          fontSize: 13, color: 'var(--ink)', zIndex: 70,
        }}>
          <div style={{ width: 8, height: 8, background: toast.ok ? 'var(--grass)' : 'var(--lava)', flexShrink: 0 }} />
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ─── ModTile ──────────────────────────────────────────────────────────────────

function ModTile({ mod, installing, installedInInstances, onInstall }: {
  mod: ModrinthProject
  installing: boolean
  installedInInstances: number
  onInstall: () => void
}) {
  const loaders = mod.loaders ?? []

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {mod.icon_url ? (
          <img src={mod.icon_url} alt="" style={{ width: 36, height: 36, flexShrink: 0, imageRendering: 'pixelated', border: '1px solid var(--border-r)' }} />
        ) : (
          <div style={{ width: 36, height: 36, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-r)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'var(--ink-4)' }}>
            {mod.title[0]}
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mod.title}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{loaders.slice(0, 3).join(' · ') || 'unknown'}</div>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {mod.description}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {mod.categories.slice(0, 2).map(cat => <Tag key={cat} color="var(--ink-4)">{cat}</Tag>)}
          {installedInInstances > 0 && (
            <Tag color="var(--grass)">✓ {installedInInstances} instance{installedInInstances > 1 ? 's' : ''}</Tag>
          )}
        </div>
        <span style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--ink-4)', letterSpacing: '.04em' }}>
          ↓ {formatDownloads(mod.downloads)}
        </span>
      </div>

      <button
        onClick={onInstall}
        disabled={installing}
        style={{
          marginTop: 4, width: '100%', height: 30,
          fontFamily: "'VT323',monospace", fontSize: 16, letterSpacing: '.1em',
          color: installing ? 'var(--ink-4)' : '#fff',
          background: installing ? 'var(--surface-3)' : 'var(--accent)',
          border: 'none', cursor: installing ? 'not-allowed' : 'pointer',
          boxShadow: installing ? 'inset 0 -3px 0 rgba(0,0,0,.28)' : 'inset 0 -3px 0 var(--accent-lo), inset 0 3px 0 var(--accent-hi)',
        }}
      >
        {installing ? 'INSTALLING…' : 'INSTALL'}
      </button>
    </div>
  )
}

function FilterChip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  const c = color ?? 'var(--accent)'
  return (
    <button onClick={onClick} style={{ fontSize: 11, fontWeight: 500, color: active ? c : 'var(--ink-4)', background: active ? 'var(--accent-tint)' : 'var(--surface)', border: `1px solid ${active ? c : 'var(--border-r)'}`, borderRadius: 3, padding: '3px 10px', cursor: 'pointer' }}>
      {children}
    </button>
  )
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 2, padding: '1px 5px', opacity: 0.85 }}>
      {children}
    </span>
  )
}

function PageBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{ width: 32, height: 28, fontFamily: "'VT323',monospace", fontSize: 18, color: disabled ? 'var(--ink-4)' : 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 3, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 }}>
      {children}
    </button>
  )
}
