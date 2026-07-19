import { useMemo, useRef, useState, type CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
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
// (it's a length, not a colour). Labels are locale keys resolved at render time.
type ColorLabelKey =
  | 'colorAccent'
  | 'colorAccentHover'
  | 'colorAccentText'
  | 'colorBackground'
  | 'colorSurface'
  | 'colorOverlay'
  | 'colorHover'
  | 'colorText'
  | 'colorTextMuted'
  | 'colorTextFaint'
  | 'colorBorder'
  | 'colorSuccess'
  | 'colorWarning'
  | 'colorError'

const COLOR_FIELDS: Array<{ key: keyof ThemeColors; labelKey: ColorLabelKey }> = [
  { key: 'accent', labelKey: 'colorAccent' },
  { key: 'accent-hover', labelKey: 'colorAccentHover' },
  { key: 'accent-fg', labelKey: 'colorAccentText' },
  { key: 'bg-base', labelKey: 'colorBackground' },
  { key: 'bg-surface', labelKey: 'colorSurface' },
  { key: 'bg-overlay', labelKey: 'colorOverlay' },
  { key: 'bg-hover', labelKey: 'colorHover' },
  { key: 'text-primary', labelKey: 'colorText' },
  { key: 'text-secondary', labelKey: 'colorTextMuted' },
  { key: 'text-muted', labelKey: 'colorTextFaint' },
  { key: 'border', labelKey: 'colorBorder' },
  { key: 'success', labelKey: 'colorSuccess' },
  { key: 'warning', labelKey: 'colorWarning' },
  { key: 'error', labelKey: 'colorError' },
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
  const t = useT()
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
  const [draftName, setDraftName] = useState(t.themes.defaultName)
  const [draftColors, setDraftColors] = useState<ThemeColors>(() => ({ ...activeTheme.colors }))
  const [draftBackgroundImage, setDraftBackgroundImage] = useState(activeTheme.backgroundImage ?? '')
  const [draftBackgroundOpacity, setDraftBackgroundOpacity] = useState(activeTheme.backgroundOpacity ?? 0.34)
  const [draftBackgroundBlur, setDraftBackgroundBlur] = useState(activeTheme.backgroundBlur ?? 0)
  const [draftBackgroundDim, setDraftBackgroundDim] = useState(activeTheme.backgroundDim ?? 0.42)
  const [draftDisableGradients, setDraftDisableGradients] = useState(activeTheme.disableGradients ?? false)

  function selectBuiltin(id: 'dark' | 'light') {
    applyBuiltin(id)
  }

  function selectCustom(theme: ThemeDefinition) {
    applyTheme(theme)
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
    loadDraft(activeTheme, t.themes.defaultName)
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
      name: draftName.trim() || t.themes.defaultName,
      author: t.themes.authorYou,
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
            {active && <span className="theme-active-pill">{t.themes.active}</span>}
            {!builtin && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); startEdit(theme) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); startEdit(theme) } }}
                title={t.themes.editTip}
                className="theme-card-action theme-card-edit"
              >
                {t.themes.edit}
              </span>
            )}
            {!builtin && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); removeCustomTheme(theme.id) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); removeCustomTheme(theme.id) } }}
                title={t.themes.deleteTip}
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
            title={t.themes.deleteTip}
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
        <Dialog.Content aria-label={t.themes.title} className="ni-dialog theme-dialog">
          <div className="theme-dialog-scroll">
            <div className="theme-dialog-header">
              <div>
                <Dialog.Title className="theme-dialog-title">{t.themes.title}</Dialog.Title>
                <Dialog.Description className="theme-dialog-subtitle">
                  {t.themes.subtitle}
                </Dialog.Description>
              </div>
              {!creating && <Button size="sm" onClick={startCreate}>{t.themes.create}</Button>}
            </div>

            {!creating ? (
              <div className="theme-card-grid">
                {builtins.map((t) => <ThemeCard key={t.id} theme={t} builtin />)}
                {customThemes.map((t) => <ThemeCard key={t.id} theme={t} builtin={false} />)}
              </div>
            ) : (
              <div className="theme-editor">
                <label className="theme-field">
                  <span className="theme-field-label">{t.themes.name}</span>
                  <input
                    className="ni-input"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </label>

                <div className="theme-color-grid">
                  {COLOR_FIELDS.map(({ key, labelKey }) => (
                    <label key={key} className="theme-color-field">
                      <input
                        className="theme-color-input"
                        type="color"
                        value={draftColors[key]}
                        onChange={(e) => setDraftColors((c) => ({ ...c, [key]: e.target.value }))}
                      />
                      <span className="theme-color-chip" style={{ background: draftColors[key] }} />
                      <span className="theme-color-name">{t.themes[labelKey]}</span>
                      <span className="theme-color-value">{draftColors[key]}</span>
                    </label>
                  ))}
                  <label className="theme-radius-field">
                    <span className="theme-field-label">{t.themes.cornerRadius}</span>
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
                    <b>{t.themes.disableGradients}</b>
                    <small>{t.themes.disableGradientsDesc}</small>
                  </span>
                </label>

                <div className="theme-bg-panel">
                  <div className="theme-bg-header">
                    <div>
                      <div className="theme-section-title">{t.themes.bgImage}</div>
                      <div className="theme-section-note">{t.themes.bgImageDesc}</div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={chooseBackgroundImage}>{t.themes.chooseImage}</Button>
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
                    placeholder={t.themes.urlPlaceholder}
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
                        <div className="theme-bg-preview-title">{t.themes.preview}</div>
                        <div className="theme-bg-preview-note">{t.themes.previewNote}</div>
                      </div>
                    </div>
                  )}

                  <div className="theme-slider-grid">
                    <label className="theme-slider-field">
                      <span>{t.themes.imageOpacity(Math.round(draftBackgroundOpacity * 100))}</span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundOpacity, 0.1, 0.8)} type="range" min={0.1} max={0.8} step={0.05} value={draftBackgroundOpacity} onChange={(e) => setDraftBackgroundOpacity(Number(e.target.value))} />
                    </label>
                    <label className="theme-slider-field">
                      <span>{t.themes.backgroundDim(Math.round(draftBackgroundDim * 100))}</span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundDim, 0.15, 0.75)} type="range" min={0.15} max={0.75} step={0.05} value={draftBackgroundDim} onChange={(e) => setDraftBackgroundDim(Number(e.target.value))} />
                    </label>
                    <label className="theme-slider-field">
                      <span>{t.themes.blur(draftBackgroundBlur)}</span>
                      <input className="ni-slider" style={sliderStyle(draftBackgroundBlur, 0, 16)} type="range" min={0} max={16} step={1} value={draftBackgroundBlur} onChange={(e) => setDraftBackgroundBlur(Number(e.target.value))} />
                    </label>
                  </div>

                  {draftBackgroundImage && (
                    <div className="theme-bg-remove">
                      <Button variant="ghost" size="sm" onClick={() => setDraftBackgroundImage('')}>{t.themes.removeImage}</Button>
                    </div>
                  )}
                </div>

                <div className="theme-footer-actions">
                  <Button variant="outline" size="sm" onClick={() => { setCreating(false); setEditingThemeId(null) }}>{t.themes.cancel}</Button>
                  <Button size="sm" onClick={saveDraft}>{editingThemeId ? t.themes.saveChanges : t.themes.createApply}</Button>
                </div>
              </div>
            )}

            {!creating && (
              <div className="theme-footer-actions">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t.themes.done}</Button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
