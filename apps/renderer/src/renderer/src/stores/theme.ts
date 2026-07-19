import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { themeEngine } from '@/lib/theme-engine'
import { api } from '@/lib/api'
import type { ThemeDefinition, LayoutConfig } from '@/lib/theme-types'
import darkTheme from '@/lib/themes/dark.json'
import lightTheme from '@/lib/themes/light.json'

export type ThemePreference = 'system' | 'dark' | 'light' | string
export type AccentPreference = 'refract' | 'system' | 'custom'
export type FontPreference = 'default' | 'system' | 'custom'

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function foregroundForHex(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.48 ? '#111827' : '#ffffff'
}

export function applyAccentColor(color: string, foreground: string): void {
  const root = document.documentElement
  root.style.setProperty('--accent', color)
  root.style.setProperty('--accent-hi', `color-mix(in srgb, ${color} 76%, white)`)
  root.style.setProperty('--accent-lo', `color-mix(in srgb, ${color} 78%, black)`)
  root.style.setProperty('--accent-fg', foreground)
  root.style.setProperty('--accent-tint', `color-mix(in srgb, ${color} 15%, transparent)`)
  root.style.accentColor = color
}

const BUILTIN_THEMES: Record<string, ThemeDefinition> = {
  dark: darkTheme as ThemeDefinition,
  light: lightTheme as ThemeDefinition,
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
  accentPreference: AccentPreference
  accentColor: string | null
  fontPreference: FontPreference
  fontFamily: string | null

  applyTheme: (theme: ThemeDefinition) => void
  applyBuiltin: (id: 'dark' | 'light') => void
  addCustomTheme: (theme: ThemeDefinition) => void
  removeCustomTheme: (id: string) => void
  setLayoutOverride: (override: Partial<LayoutConfig>) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setAccentColor: (color: string | null) => void
  setAccentPreference: (preference: AccentPreference) => void
  setFontFamily: (family: string | null) => void
  setFontPreference: (preference: FontPreference) => void
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
let systemAccentListenerInstalled = false
let systemAccentRequest = 0

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

function applyAccentPreference(preference: AccentPreference, customColor: string | null): void {
  if (preference === 'system') {
    const request = ++systemAccentRequest
    // CSS system colors are only a fallback. WebView2 commonly reports its
    // default blue instead of the Windows personalization accent.
    applyAccentColor('AccentColor', 'AccentColorText')
    void api.system.accentColor().then((color) => {
      if (
        request === systemAccentRequest
        && useThemeStore.getState().accentPreference === 'system'
        && color
      ) {
        applyAccentColor(color, foregroundForHex(color))
      }
    }).catch(() => {})
  } else if (preference === 'custom' && customColor) {
    systemAccentRequest++
    applyAccentColor(customColor, foregroundForHex(customColor))
  } else {
    systemAccentRequest++
  }
}

function installSystemAccentListener(): void {
  if (systemAccentListenerInstalled || typeof window === 'undefined') return
  systemAccentListenerInstalled = true
  // Windows applies personalization changes while Refract is in the
  // background. Refresh when the user returns from Settings.
  window.addEventListener('focus', () => {
    const state = useThemeStore.getState()
    if (state.accentPreference === 'system') {
      applyAccentPreference(state.accentPreference, state.accentColor)
    }
  })
}

function cleanFontFamily(family: string): string {
  return family.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
}

function applyFontPreference(preference: FontPreference, customFamily: string | null): void {
  const root = document.documentElement
  if (preference === 'custom' && customFamily) {
    root.style.setProperty('--font-ui', `${JSON.stringify(customFamily)}, system-ui, sans-serif`)
  } else if (preference === 'system') {
    root.style.setProperty('--font-ui', 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif')
  } else {
    root.style.removeProperty('--font-ui')
  }
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
      accentPreference: 'refract',
      accentColor: null,
      fontPreference: 'system',
      fontFamily: null,

      applyTheme: (theme) => {
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...get().layoutOverrides } })
        set({ themePreference: theme.id, activeThemeId: theme.id, activeTheme: theme })
        applyAccentPreference(get().accentPreference, get().accentColor)
        applyFontPreference(get().fontPreference, get().fontFamily)
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
        applyAccentPreference(get().accentPreference, get().accentColor)
        applyFontPreference(get().fontPreference, get().fontFamily)
      },

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setAccentColor: (color) => {
        const preference: AccentPreference = color ? 'custom' : 'refract'
        set({ accentPreference: preference, accentColor: color })
        get().initialize()
      },

      setAccentPreference: (preference) => {
        set({ accentPreference: preference })
        get().initialize()
      },

      setFontFamily: (family) => {
        const cleaned = family ? cleanFontFamily(family) : ''
        set({ fontPreference: 'custom', fontFamily: cleaned || null })
        get().initialize()
      },

      setFontPreference: (preference) => {
        set({ fontPreference: preference })
        get().initialize()
      },

      setThemePreference: (preference) => {
        const id = resolvedThemeId(preference)
        const theme = resolveTheme(id, get().customThemes, darkTheme as ThemeDefinition)
        set({ themePreference: preference, activeThemeId: theme.id, activeTheme: theme })
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...get().layoutOverrides } })
        applyAccentPreference(get().accentPreference, get().accentColor)
        applyFontPreference(get().fontPreference, get().fontFamily)
      },

      initialize: () => {
        installSystemThemeListener()
        installSystemAccentListener()
        const {
          themePreference,
          customThemes,
          layoutOverrides,
          activeTheme,
          accentPreference,
          accentColor,
          fontPreference,
          fontFamily,
        } = get()
        const theme = resolveTheme(resolvedThemeId(themePreference), customThemes, activeTheme)
        set({ activeThemeId: theme.id, activeTheme: theme })
        themeEngine.apply({ ...theme, layout: { ...theme.layout, ...layoutOverrides } })
        applyAccentPreference(accentPreference, accentColor)
        applyFontPreference(fontPreference, fontFamily)
      },
    }),
    {
      name: 'refract-theme',
      version: 3,
      migrate: (persisted, version) => {
        let state = persisted as Partial<ThemeStore>
        if (version < 1) {
          state = {
            ...state,
            // A pre-existing stored theme was an explicit user choice. Fresh
            // profiles have no persisted state and keep the new `system` default.
            themePreference: state.activeThemeId ?? 'dark',
          }
        }
        if (version < 2) {
          state = {
            ...state,
            accentPreference: state.accentColor ? 'custom' : 'refract',
          }
        }
        if (version < 3) {
          state = {
            ...state,
            fontPreference: 'system',
            fontFamily: null,
          }
        }
        return state as ThemeStore
      },
      partialize: (s) => ({
        themePreference: s.themePreference,
        customThemes: s.customThemes,
        layoutOverrides: s.layoutOverrides,
        sidebarCollapsed: s.sidebarCollapsed,
        accentPreference: s.accentPreference,
        accentColor: s.accentColor,
        fontPreference: s.fontPreference,
        fontFamily: s.fontFamily,
      }),
      onRehydrateStorage: () => (state) => {
        state?.initialize()
      },
    }
  )
)
