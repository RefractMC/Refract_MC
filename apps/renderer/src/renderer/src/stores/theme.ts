import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { themeEngine } from '@/lib/theme-engine'
import type { ThemeDefinition, LayoutConfig } from '@/lib/theme-types'
import darkTheme from '@/lib/themes/dark.json'
import lightTheme from '@/lib/themes/light.json'

export type ThemePreference = 'system' | 'dark' | 'light' | string

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

function resolveTheme(id: string, customThemes: ThemeDefinition[], fallback: ThemeDefinition): ThemeDefinition {
  return BUILTIN_THEMES[id] ?? customThemes.find((t) => t.id === id) ?? fallback
}

interface ThemeStore {
  themePreference: ThemePreference
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
  setThemePreference: (preference: ThemePreference) => void
  initialize: () => void
}

function systemThemeId(): 'dark' | 'light' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function resolvedThemeId(preference: ThemePreference): string {
  return preference === 'system' ? systemThemeId() : preference
}

let systemThemeListenerInstalled = false

function installSystemThemeListener(): void {
  if (
    systemThemeListenerInstalled
    || typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
  ) return
  systemThemeListenerInstalled = true
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    const state = useThemeStore.getState()
    if (state.themePreference === 'system') state.initialize()
  })
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      themePreference: 'system',
      activeThemeId: 'dark',
      activeTheme: darkTheme as ThemeDefinition,
      customThemes: [],
      layoutOverrides: {},
      sidebarCollapsed: false,
      accentColor: null,

      applyTheme: (theme) => {
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...get().layoutOverrides } })
        set({ themePreference: theme.id, activeThemeId: theme.id, activeTheme: theme })
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
        const theme = resolveTheme(get().activeThemeId, get().customThemes, get().activeTheme)
        set({ layoutOverrides: merged, activeTheme: theme })
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...merged } })
        if (isBuiltinTheme(theme.id)) applyAccentColor(get().accentColor)
      },

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setAccentColor: (color) => {
        set({ accentColor: color })
        applyAccentColor(color)
      },

      setThemePreference: (preference) => {
        const id = resolvedThemeId(preference)
        const theme = resolveTheme(id, get().customThemes, darkTheme as ThemeDefinition)
        set({ themePreference: preference, activeThemeId: theme.id, activeTheme: theme })
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...get().layoutOverrides } })
        if (isBuiltinTheme(theme.id)) applyAccentColor(get().accentColor)
      },

      initialize: () => {
        installSystemThemeListener()
        const { themePreference, customThemes, layoutOverrides, activeTheme, accentColor } = get()
        const theme = resolveTheme(resolvedThemeId(themePreference), customThemes, activeTheme)
        set({ activeThemeId: theme.id, activeTheme: theme })
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...layoutOverrides } })
        if (accentColor && isBuiltinTheme(theme.id)) applyAccentColor(accentColor)
      },
    }),
    {
      name: 'refract-theme',
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Partial<ThemeStore>
        if (version < 1) {
          return {
            ...state,
            // A pre-existing stored theme was an explicit user choice. Fresh
            // profiles have no persisted state and keep the new `system` default.
            themePreference: state.activeThemeId ?? 'dark',
          } as ThemeStore
        }
        return state as ThemeStore
      },
      partialize: (s) => ({
        themePreference: s.themePreference,
        customThemes: s.customThemes,
        layoutOverrides: s.layoutOverrides,
        sidebarCollapsed: s.sidebarCollapsed,
        accentColor: s.accentColor,
      }),
      onRehydrateStorage: () => (state) => {
        state?.initialize()
      },
    }
  )
)
