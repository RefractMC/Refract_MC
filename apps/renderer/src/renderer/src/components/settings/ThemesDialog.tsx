import { useMemo, useRef, useState, type CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/Button'
import { useThemeStore } from '@/stores/theme'
import { api, supportsFilePicker } from '@/lib/api'
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

function cssUrl(value: string): string {
  return `url(${JSON.stringify(value)})`
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${base || 'theme'}-${rand}`
}

function sliderStyle(value: number, min: number, max: number): CSSProperties {
  const fill = Math.round(((value - min) / (max - min)) * 100)
  return { '--fill': `${Math.max(0, Math.min(100, fill))}%` } as CSSProperties
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
  const [draftDisableGradients, setDraftDisableGradients] = useState(activeTheme.disableGradients ?? false)

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
    setDraftDisableGradients(theme.disableGradients ?? false)
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

  async function chooseBackgroundImage() {
    if (!supportsFilePicker) {
      backgroundInputRef.current?.click()
      return
    }
    const image = await api.theme.browseBackgroundImage()
    if (image) setDraftBackgroundImage(image)
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
      disableGradients: draftDisableGradients,
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
        className="theme-card"
        data-active={active ? 'true' : 'false'}
      >
        <div className="theme-card-head">
          <span className="theme-card-title">{theme.name}</span>
          <span className="theme-card-controls">
            {active && <span className="theme-active-pill">ACTIVE</span>}
            {!builtin && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); startEdit(theme) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); startEdit(theme) } }}
                title="Edit theme"
                className="theme-card-action theme-card-edit"
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
                className="theme-card-action theme-card-delete"
              >
                ×
              </span>
            )}
          </span>
        </div>
        <div className="theme-swatch-row">
          {SWATCH_KEYS.map((k) => (
            <span key={k} className="theme-swatch" style={{ background: theme.colors[k] }} />
          ))}
        </div>
        {theme.backgroundImage && (
          <div
            aria-hidden
            className="theme-bg-thumb"
            style={{ backgroundImage: `linear-gradient(rgba(0,0,0,.20), rgba(0,0,0,.20)), ${cssUrl(theme.backgroundImage)}` }}
          />
        )}
        {!builtin && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); removeCustomTheme(theme.id) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); removeCustomTheme(theme.id) } }}
            title="Delete theme"
            className="theme-card-action theme-card-delete"
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
        <Dialog.Overlay className="theme-overlay" />
        <Dialog.Content aria-label="Themes" className="ni-dialog theme-dialog">
          <div className="theme-dialog-scroll">
            <div className="theme-dialog-header">
              <div>
                <Dialog.Title className="theme-dialog-title">Themes</Dialog.Title>
                <Dialog.Description className="theme-dialog-subtitle">
                  Pick a built-in style or build a custom launcher theme.
                </Dialog.Description>
              </div>
              {!creating && <Button size="sm" onClick={startCreate}>Create theme</Button>}
            </div>

            {!creating ? (
              <div className="theme-card-grid">
                {builtins.map((t) => <ThemeCard key={t.id} theme={t} builtin />)}
                {customThemes.map((t) => <ThemeCard key={t.id} theme={t} builtin={false} />)}
              </div>
            ) : (
              <div className="theme-editor">
                <label className="theme-field">
                  <span className="theme-field-label">Theme name</span>
                  <input
                    className="ni-input"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </label>

                <div className="theme-color-grid">
                  {COLOR_FIELDS.map(({ key, label }) => (
                    <label key={key} className="theme-color-field">
                      <input
                        className="theme-color-input"
                        type="color"
                        value={draftColors[key]}
                        onChange={(e) => setDraftColors((c) => ({ ...c, [key]: e.target.value }))}
                      />
                      <span className="theme-color-chip" style={{ background: draftColors[key] }} />
                      <span className="theme-color-name">{label}</span>
                      <span className="theme-color-value">{draftColors[key]}</span>
                    </label>
                  ))}
                  <label className="theme-radius-field">
                    <span className="theme-field-label">Corner radius</span>
                    <input
                      className="ni-input"
                      type="number"
                      min={0}
                      max={24}
                      value={parseInt(draftColors.radius) || 0}
                      onChange={(e) => setDraftColors((c) => ({ ...c, radius: `${e.target.value}px` }))}
                    />
                  </label>
                </div>

                <label className="theme-option-row">
                  <input
                    type="checkbox"
                    checked={draftDisableGradients}
                    onChange={(e) => setDraftDisableGradients(e.target.checked)}
                  />
                  <span>
                    <b>Disable gradients</b>
                    <small>Use flat theme colors across panels, buttons, sidebar, and page backgrounds.</small>
                  </span>
                </label>

                <div className="theme-bg-panel">
                  <div className="theme-bg-header">
                    <div>
                      <div className="theme-section-title">Background image</div>
                      <div className="theme-section-note">Use a local image or paste an image URL.</div>
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
                    className="ni-input"
                    value={draftBackgroundImage}
                    onChange={(e) => setDraftBackgroundImage(e.target.value)}
                    placeholder="https://example.com/background.jpg"
                  />

                  {draftBackgroundImage && (
                    <div
                      className="theme-bg-preview"
                      style={{
                        '--theme-preview-image': cssUrl(draftBackgroundImage),
                        '--theme-preview-opacity': draftBackgroundOpacity,
                        '--theme-preview-blur': `${draftBackgroundBlur}px`,
                        '--theme-preview-dim': draftBackgroundDim,
                      } as CSSProperties}
                    >
                      <div className="theme-bg-preview-card">
                        <div className="theme-bg-preview-title">Preview</div>
                        <div className="theme-bg-preview-note">Text stays readable over image.</div>
                      </div>
                    </div>
                  )}

                  <div className="theme-slider-grid">
                    <label className="theme-slider-field">
                      <span>Image opacity <b>{Math.round(draftBackgroundOpacity * 100)}%</b></span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundOpacity, 0.1, 0.8)} type="range" min={0.1} max={0.8} step={0.05} value={draftBackgroundOpacity} onChange={(e) => setDraftBackgroundOpacity(Number(e.target.value))} />
                    </label>
                    <label className="theme-slider-field">
                      <span>Background dim <b>{Math.round(draftBackgroundDim * 100)}%</b></span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundDim, 0.15, 0.75)} type="range" min={0.15} max={0.75} step={0.05} value={draftBackgroundDim} onChange={(e) => setDraftBackgroundDim(Number(e.target.value))} />
                    </label>
                    <label className="theme-slider-field">
                      <span>Blur <b>{draftBackgroundBlur}px</b></span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundBlur, 0, 16)} type="range" min={0} max={16} step={1} value={draftBackgroundBlur} onChange={(e) => setDraftBackgroundBlur(Number(e.target.value))} />
                    </label>
                  </div>

                  {draftBackgroundImage && (
                    <div className="theme-bg-remove">
                      <Button variant="ghost" size="sm" onClick={() => setDraftBackgroundImage('')}>Remove image</Button>
                    </div>
                  )}
                </div>

                <div className="theme-footer-actions">
                  <Button variant="outline" size="sm" onClick={() => { setCreating(false); setEditingThemeId(null) }}>Cancel</Button>
                  <Button size="sm" onClick={saveDraft}>{editingThemeId ? 'Save changes' : 'Create & apply'}</Button>
                </div>
              </div>
            )}

            {!creating && (
              <div className="theme-footer-actions">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
