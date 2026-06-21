import type { ThemeDefinition, LayoutConfig } from './theme-types'
import { DEFAULT_LAYOUT } from './theme-types'

function cssUrl(value: string): string {
  return `url(${JSON.stringify(value)})`
}

class ThemeEngine {
  private customStyleTag: HTMLStyleElement | null = null

  apply(theme: ThemeDefinition): void {
    document.documentElement.dataset.theme = theme.id
    document.documentElement.dataset.hasThemeBg = theme.backgroundImage ? 'true' : 'false'
    document.documentElement.dataset.themeGradients = theme.disableGradients ? 'off' : 'on'
    this.applyColors(theme.colors)
    this.applyBackground(theme)
    this.applyLayout({ ...DEFAULT_LAYOUT, ...theme.layout })
    this.applyCustomCSS(theme.customCSS ?? '')
  }

  private applyColors(colors: Record<string, string> | object): void {
    const root = document.documentElement
    for (const [key, value] of Object.entries(colors)) {
      if (key === 'radius') {
        // radius is not a Tailwind color — use --radius directly
        root.style.setProperty('--radius', value)
      } else {
        // Tailwind v4 generates bg-*, text-* utilities from --color-* variables
        root.style.setProperty(`--color-${key}`, value)
      }
    }

    const c = colors as Record<string, string>

    const directVars: Record<string, string> = {
      'bg-base': 'bg',
      'bg-surface': 'surface',
      'bg-overlay': 'surface-2',
      'bg-hover': 'surface-3',
      'text-primary': 'ink',
      'text-secondary': 'ink-2',
      'text-muted': 'ink-3',
      accent: 'accent',
      'accent-hover': 'accent-hi',
      'accent-fg': 'accent-fg',
      success: 'grass',
      warning: 'gold',
      error: 'redstone',
    }

    for (const [themeKey, cssVar] of Object.entries(directVars)) {
      const mappedValue = c[themeKey]
      if (mappedValue) root.style.setProperty(`--${cssVar}`, mappedValue)
    }

    // Extra derived/optional mappings
    if (c['bg-base'])    root.style.setProperty('--sb', c['sb'] ?? c['bg-base'])
    root.style.setProperty('--border-r', 'transparent')
    root.style.setProperty('--border-2', 'transparent')
    root.style.setProperty('--line', 'transparent')
    root.style.setProperty('--sb-line', 'transparent')
    if (c['text-muted']) root.style.setProperty('--ink-4', c['ink-4'] ?? c['text-muted'])
    if (c['checker-1'])  root.style.setProperty('--checker-1', c['checker-1'])
    if (c['checker-2'])  root.style.setProperty('--checker-2', c['checker-2'])

    const accent = c.accent
    if (accent) root.style.setProperty('--accent-tint', `color-mix(in srgb, ${accent} 18%, transparent)`)
    if (c['accent-hover']) root.style.setProperty('--accent-hover', c['accent-hover'])
  }

  private applyBackground(theme: ThemeDefinition): void {
    const root = document.documentElement
    if (!theme.backgroundImage) {
      root.style.removeProperty('--theme-bg-image')
      root.style.removeProperty('--theme-bg-opacity')
      root.style.removeProperty('--theme-bg-blur')
      root.style.removeProperty('--theme-bg-dim')
      return
    }

    root.style.setProperty('--theme-bg-image', cssUrl(theme.backgroundImage))
    root.style.setProperty('--theme-bg-opacity', String(theme.backgroundOpacity ?? 0.34))
    root.style.setProperty('--theme-bg-blur', `${theme.backgroundBlur ?? 0}px`)
    root.style.setProperty('--theme-bg-dim', String(theme.backgroundDim ?? 0.42))
  }

  private applyLayout(layout: LayoutConfig): void {
    const root = document.documentElement
    root.style.setProperty('--sidebar-width', layout.sidebarWidth)
    root.style.setProperty('--sidebar-collapsed-width', layout.sidebarCollapsedWidth)
    root.style.setProperty('--titlebar-height', layout.titlebarHeight)
    root.style.setProperty('--statusbar-height', layout.statusbarHeight)
  }

  private applyCustomCSS(css: string): void {
    if (!this.customStyleTag) {
      this.customStyleTag = document.createElement('style')
      this.customStyleTag.id = 'refract-theme-custom'
      document.head.appendChild(this.customStyleTag)
    }
    this.customStyleTag.textContent = css
  }
}

export const themeEngine = new ThemeEngine()
