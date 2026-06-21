import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { themeEngine } from '@/lib/theme-engine'
import type { ThemeDefinition, LayoutConfig } from '@/lib/theme-types'
import darkTheme from '@/lib/themes/dark.json'
import lightTheme from '@/lib/themes/light.json'

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function adj(hex: string, d: number): string {
  const [r, g, b] = hexToRgb(hex)
  const c = (v: number) => Math.max(0, Math.min(255, v + d))
  return `rgb(${c(r)},${c(g)},${c(b)})`
}
export function applyAccentColor(hex: string | null): void {
  const root = document.documentElement
  if (!hex) {
    ;['--accent','--accent-hi','--accent-lo','--accent-tint'].forEach(v => root.style.removeProperty(v))
    return
  }
  const [r, g, b] = hexToRgb(hex)
  root.style.setProperty('--accent',      hex)
  root.style.setProperty('--accent-hi',   adj(hex, 30))
  root.style.setProperty('--accent-lo',   adj(hex, -25))
  root.style.setProperty('--accent-tint', `rgba(${r},${g},${b},.15)`)
}

const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  dark: darkTheme as ThemeDefinition,
  light: lightTheme as ThemeDefinition,
}

function isBuiltinTheme(id: string): boolean {
  return Boolean(BUILTIN_THEMES[id])
}

interface ThemeStore {
  activeThemeId: string
  activeTheme: ThemeDefinition
  customThemes: ThemeDefinition[]
  layoutOverrides: Partial<LayoutConfig>
  sidebarCollapsed: boolean
  accentColor: string | null

  applyTheme: (theme: ThemeDefinition) => void
  applyBuiltin: (id: 'dark' | 'light') => void
  addCustomTheme: (theme: ThemeDefinition) => void
  removeCustomTheme: (id: string) => void
  setLayoutOverride: (override: Partial<LayoutConfig>) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setAccentColor: (color: string | null) => void
  initialize: () => void
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      activeThemeId: 'dark',
      activeTheme: darkTheme as ThemeDefinition,
      customThemes: [],
      layoutOverrides: {},
      sidebarCollapsed: false,
      accentColor: null,

      applyTheme: (theme) => {
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...get().layoutOverrides } })
        set({ activeThemeId: theme.id, activeTheme: theme })
        if (isBuiltinTheme(theme.id)) applyAccentColor(get().accentColor)
      },

      applyBuiltin: (id) => {
        const theme = BUILTIN_THEMES[id]
        if (theme) get().applyTheme(theme)
      },

      addCustomTheme: (theme) => {
        set((s) => ({
          customThemes: [...s.customThemes.filter((t) => t.id !== theme.id), theme],
        }))
        get().applyTheme(theme)
      },

      removeCustomTheme: (id) => {
        set((s) => ({ customThemes: s.customThemes.filter((t) => t.id !== id) }))
        // If the deleted theme was active, fall back to the dark built-in.
        if (get().activeThemeId === id) get().applyBuiltin('dark')
      },

      setLayoutOverride: (override) => {
        const merged = { ...get().layoutOverrides, ...override }
        set({ layoutOverrides: merged })
        themeEngine.apply({ ...get().activeTheme, layout: merged })
        if (isBuiltinTheme(get().activeThemeId)) applyAccentColor(get().accentColor)
      },

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setAccentColor: (color) => {
        set({ accentColor: color })
        applyAccentColor(color)
      },

      initialize: () => {
        const { activeThemeId, customThemes, layoutOverrides, activeTheme, accentColor } = get()
        const theme =
          BUILTIN_THEMES[activeThemeId] ??
          customThemes.find((t) => t.id === activeThemeId) ??
          activeTheme
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...layoutOverrides } })
        if (accentColor && isBuiltinTheme(theme.id)) applyAccentColor(accentColor)
      },
    }),
    {
      name: 'refract-theme',
      partialize: (s) => ({
        activeThemeId: s.activeThemeId,
        customThemes: s.customThemes,
        layoutOverrides: s.layoutOverrides,
        sidebarCollapsed: s.sidebarCollapsed,
        accentColor: s.accentColor,
      }),
    }
  )
)
