import { useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/Button'
import { useThemeStore } from '@/stores/theme'
import { api } from '@/lib/api'
import type { ThemeColors, ThemeDefinition } from '@/lib/theme-types'
import darkTheme from '@/lib/themes/dark.json'
import lightTheme from '@/lib/themes/light.json'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Editable colours, in a sensible visual order. `radius` is handled separately
// (it's a length, not a colour).
const COLOR_FIELDS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: 'accent-hover', label: 'Accent hover' },
  { key: 'accent-fg', label: 'Accent text' },
  { key: 'bg-base', label: 'Background' },
  { key: 'bg-surface', label: 'Surface' },
  { key: 'bg-overlay', label: 'Overlay' },
  { key: 'bg-hover', label: 'Hover' },
  { key: 'text-primary', label: 'Text' },
  { key: 'text-secondary', label: 'Text muted' },
  { key: 'text-muted', label: 'Text faint' },
  { key: 'border', label: 'Border' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'error', label: 'Error' },
]

const SWATCH_KEYS: Array<keyof ThemeColors> = ['accent', 'bg-base', 'bg-surface', 'text-primary']

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${base || 'theme'}-${rand}`
}

export function ThemesDialog({ open, onOpenChange }: Props) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const activeTheme = useThemeStore((s) => s.activeTheme)
  const customThemes = useThemeStore((s) => s.customThemes)
  const applyTheme = useThemeStore((s) => s.applyTheme)
  const applyBuiltin = useThemeStore((s) => s.applyBuiltin)
  const addCustomTheme = useThemeStore((s) => s.addCustomTheme)
  const removeCustomTheme = useThemeStore((s) => s.removeCustomTheme)
  const backgroundInputRef = useRef<HTMLInputElement>(null)

  const builtins = useMemo(() => [darkTheme as ThemeDefinition, lightTheme as ThemeDefinition], [])

  const [creating, setCreating] = useState(false)
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('My Theme')
  const [draftColors, setDraftColors] = useState<ThemeColors>(() => ({ ...activeTheme.colors }))
  const [draftBackgroundImage, setDraftBackgroundImage] = useState(activeTheme.backgroundImage ?? '')
  const [draftBackgroundOpacity, setDraftBackgroundOpacity] = useState(activeTheme.backgroundOpacity ?? 0.34)
  const [draftBackgroundBlur, setDraftBackgroundBlur] = useState(activeTheme.backgroundBlur ?? 0)
  const [draftBackgroundDim, setDraftBackgroundDim] = useState(activeTheme.backgroundDim ?? 0.42)

  async function persistActive(id: string) {
    try { await api.config.set('activeThemeId', id) } catch { /* localStorage already holds it */ }
  }

  async function selectBuiltin(id: 'dark' | 'light') {
    applyBuiltin(id)
    await persistActive(id)
  }

  async function selectCustom(theme: ThemeDefinition) {
    applyTheme(theme)
    await persistActive(theme.id)
  }

  function loadDraft(theme: ThemeDefinition, name = theme.name) {
    setDraftColors({ ...theme.colors })
    setDraftName(name)
    setDraftBackgroundImage(theme.backgroundImage ?? '')
    setDraftBackgroundOpacity(theme.backgroundOpacity ?? 0.34)
    setDraftBackgroundBlur(theme.backgroundBlur ?? 0)
    setDraftBackgroundDim(theme.backgroundDim ?? 0.42)
  }

  function startCreate() {
    setEditingThemeId(null)
    loadDraft(activeTheme, 'My Theme')
    setCreating(true)
  }

  function startEdit(theme: ThemeDefinition) {
    setEditingThemeId(theme.id)
    loadDraft(theme)
    setCreating(true)
  }

  function chooseBackgroundImage() {
    backgroundInputRef.current?.click()
  }

  function handleBackgroundFile(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setDraftBackgroundImage(reader.result)
    }
    reader.readAsDataURL(file)
  }

  async function saveDraft() {
    const id = editingThemeId ?? slugify(draftName)
    const theme: ThemeDefinition = {
      id,
      name: draftName.trim() || 'My Theme',
      author: 'You',
      version: '1.0.0',
      colors: draftColors,
      ...(draftBackgroundImage.trim()
        ? {
            backgroundImage: draftBackgroundImage.trim(),
            backgroundOpacity: draftBackgroundOpacity,
            backgroundBlur: draftBackgroundBlur,
            backgroundDim: draftBackgroundDim,
          }
        : {}),
    }
    addCustomTheme(theme)        // also applies it
    await persistActive(theme.id)
    setEditingThemeId(null)
    setCreating(false)
  }

  function ThemeCard({ theme, builtin }: { theme: ThemeDefinition; builtin: boolean }) {
    const active = activeThemeId === theme.id
    return (
      <button
        onClick={() => (builtin ? selectBuiltin(theme.id as 'dark' | 'light') : selectCustom(theme))}
        style={{
          position: 'relative', textAlign: 'left', cursor: 'pointer', padding: 12, borderRadius: 10,
          background: 'var(--surface-2, #1a1a24)',
          border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-r, #2e2e3d)'}`,
          display: 'grid', gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink, #f0f0f5)' }}>{theme.name}</span>
          {active && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>ACTIVE</span>}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {SWATCH_KEYS.map((k) => (
            <span key={k} style={{ width: 22, height: 22, borderRadius: 5, background: theme.colors[k], border: '1px solid rgba(0,0,0,.3)' }} />
          ))}
        </div>
        {theme.backgroundImage && (
          <div
            aria-hidden
            style={{
              height: 54,
              borderRadius: 7,
              backgroundImage: `linear-gradient(rgba(0,0,0,.20), rgba(0,0,0,.20)), url("${theme.backgroundImage.replace(/"/g, '\\"')}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
        )}
        {!builtin && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); startEdit(theme) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); startEdit(theme) } }}
            title="Edit theme"
            style={{ position: 'absolute', top: 6, right: 30, height: 20, padding: '0 6px', display: 'grid', placeItems: 'center', borderRadius: 5, color: 'var(--ink-2, #b1b8c8)', fontSize: 10, fontWeight: 800, letterSpacing: '.05em' }}
          >
            EDIT
          </span>
        )}
        {!builtin && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); removeCustomTheme(theme.id) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); removeCustomTheme(theme.id) } }}
            title="Delete theme"
            style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 5, color: 'var(--ink-3, #8a8a9a)', fontSize: 14 }}
          >
            ×
          </span>
        )}
      </button>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) { setCreating(false); setEditingThemeId(null) } onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 149 }} />
        <Dialog.Content aria-label="Themes" className="ni-dialog">
          <div style={{ padding: 20, display: 'grid', gap: 18, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Dialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--ink, #f0f0f5)' }}>Themes</Dialog.Title>
              {!creating && <Button size="sm" onClick={startCreate}>Create theme</Button>}
            </div>

            {!creating ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                {builtins.map((t) => <ThemeCard key={t.id} theme={t} builtin />)}
                {customThemes.map((t) => <ThemeCard key={t.id} theme={t} builtin={false} />)}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2, #9191a8)' }}>Theme name</span>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2, #1a1a24)', border: '1px solid var(--border-r, #2e2e3d)', color: 'var(--ink, #f0f0f5)', fontSize: 13 }}
                  />
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                  {COLOR_FIELDS.map(({ key, label }) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ink-2, #9191a8)' }}>
                      <input
                        type="color"
                        value={draftColors[key]}
                        onChange={(e) => setDraftColors((c) => ({ ...c, [key]: e.target.value }))}
                        style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                      {label}
                    </label>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ink-2, #9191a8)' }}>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      value={parseInt(draftColors.radius) || 0}
                      onChange={(e) => setDraftColors((c) => ({ ...c, radius: `${e.target.value}px` }))}
                      style={{ width: 56, padding: '6px 8px', borderRadius: 8, background: 'var(--surface-2, #1a1a24)', border: '1px solid var(--border-r, #2e2e3d)', color: 'var(--ink, #f0f0f5)', fontSize: 13 }}
                    />
                    Corner radius
                  </label>
                </div>

                <div style={{ display: 'grid', gap: 10, padding: 12, borderRadius: 10, background: 'var(--surface-2, #1a1a24)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink, #f0f0f5)' }}>Background image</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-3, #8a8a9a)', marginTop: 2 }}>Use a local image or paste an image URL.</div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={chooseBackgroundImage}>Choose image</Button>
                    <input
                      ref={backgroundInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={(e) => {
                        handleBackgroundFile(e.target.files?.[0])
                        e.target.value = ''
                      }}
                      style={{ display: 'none' }}
                    />
                  </div>

                  <input
                    value={draftBackgroundImage}
                    onChange={(e) => setDraftBackgroundImage(e.target.value)}
                    placeholder="https://example.com/background.jpg"
                    style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg, #111)', border: '1px solid var(--border-r, #2e2e3d)', color: 'var(--ink, #f0f0f5)', fontSize: 12 }}
                  />

                  {draftBackgroundImage && (
                    <div style={{
                      minHeight: 120,
                      borderRadius: 10,
                      overflow: 'hidden',
                      backgroundImage: `linear-gradient(rgba(0,0,0,${draftBackgroundDim}), rgba(0,0,0,${draftBackgroundDim})), url("${draftBackgroundImage.replace(/"/g, '\\"')}")`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      display: 'grid',
                      alignItems: 'end',
                      padding: 12,
                    }}>
                      <div style={{ width: 160, padding: 10, borderRadius: 8, background: `rgba(12,16,24,${Math.min(0.9, 0.38 + draftBackgroundOpacity)})`, color: '#fff' }}>
                        <div style={{ fontSize: 12, fontWeight: 800 }}>Preview</div>
                        <div style={{ fontSize: 11, opacity: .75, marginTop: 2 }}>Text stays readable over image.</div>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                    <label style={{ display: 'grid', gap: 5, fontSize: 11, color: 'var(--ink-3, #8a8a9a)' }}>
                      Image opacity {Math.round(draftBackgroundOpacity * 100)}%
                      <input type="range" min={0.1} max={0.8} step={0.05} value={draftBackgroundOpacity} onChange={(e) => setDraftBackgroundOpacity(Number(e.target.value))} />
                    </label>
                    <label style={{ display: 'grid', gap: 5, fontSize: 11, color: 'var(--ink-3, #8a8a9a)' }}>
                      Background dim {Math.round(draftBackgroundDim * 100)}%
                      <input type="range" min={0.15} max={0.75} step={0.05} value={draftBackgroundDim} onChange={(e) => setDraftBackgroundDim(Number(e.target.value))} />
                    </label>
                    <label style={{ display: 'grid', gap: 5, fontSize: 11, color: 'var(--ink-3, #8a8a9a)' }}>
                      Blur {draftBackgroundBlur}px
                      <input type="range" min={0} max={16} step={1} value={draftBackgroundBlur} onChange={(e) => setDraftBackgroundBlur(Number(e.target.value))} />
                    </label>
                  </div>

                  {draftBackgroundImage && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="ghost" size="sm" onClick={() => setDraftBackgroundImage('')}>Remove image</Button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button variant="outline" size="sm" onClick={() => { setCreating(false); setEditingThemeId(null) }}>Cancel</Button>
                  <Button size="sm" onClick={saveDraft}>{editingThemeId ? 'Save changes' : 'Create & apply'}</Button>
                </div>
              </div>
            )}

            {!creating && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
