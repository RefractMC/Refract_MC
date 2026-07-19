import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'

export type Lang = 'en' | 'uk' | 'zh-CN'
export type LanguagePreference = 'system' | Lang

interface LanguageStore {
  languagePreference: LanguagePreference
  lang: Lang
  setLanguagePreference: (preference: LanguagePreference) => void
  setLang: (lang: Lang) => void
  initialize: () => void
}

function matchSupportedLanguage(tag: string): Lang | null {
  const normalized = tag.trim().split(/[.@]/, 1)[0].replace(/_/g, '-').toLowerCase()
  if (normalized === 'uk' || normalized.startsWith('uk-')) return 'uk'
  if (
    normalized === 'zh-cn'
    || normalized.startsWith('zh-cn-')
    || normalized === 'zh-sg'
    || normalized.startsWith('zh-sg-')
    || normalized === 'zh-hans'
    || normalized.startsWith('zh-hans-')
  ) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return null
}

export function detectSystemLanguage(languages?: readonly string[]): Lang {
  const candidates = languages
    ?? (typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language])

  for (const tag of candidates) {
    const match = matchSupportedLanguage(tag)
    if (match) return match
  }
  return 'en'
}

function resolveLanguage(preference: LanguagePreference): Lang {
  return preference === 'system' ? detectSystemLanguage() : preference
}

function applyDocumentLanguage(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang
}

let languageListenerInstalled = false
let systemLanguageRequest = 0

function applyResolvedLanguage(lang: Lang): void {
  applyDocumentLanguage(lang)
  useLanguageStore.setState({ lang })
}

function refreshSystemLanguage(): void {
  const request = ++systemLanguageRequest
  void api.system.localeTags().then((languages) => {
    const state = useLanguageStore.getState()
    if (request !== systemLanguageRequest || state.languagePreference !== 'system') return
    applyResolvedLanguage(detectSystemLanguage(languages.length ? languages : undefined))
  }).catch(() => {})
}

function installLanguageListener(): void {
  if (languageListenerInstalled || typeof window === 'undefined') return
  languageListenerInstalled = true
  const refresh = () => {
    const state = useLanguageStore.getState()
    if (state.languagePreference === 'system') refreshSystemLanguage()
  }
  window.addEventListener('languagechange', refresh)
  window.addEventListener('focus', refresh)
}

export const useLanguageStore = create<LanguageStore>()(
  persist(
    (set) => ({
      languagePreference: 'system',
      lang: detectSystemLanguage(),
      setLanguagePreference: (preference) => {
        systemLanguageRequest++
        const lang = resolveLanguage(preference)
        applyDocumentLanguage(lang)
        set({ languagePreference: preference, lang })
        if (preference === 'system') refreshSystemLanguage()
      },
      setLang: (lang) => {
        systemLanguageRequest++
        applyDocumentLanguage(lang)
        set({ languagePreference: lang, lang })
      },
      initialize: () => {
        installLanguageListener()
        set((state) => {
          const lang = resolveLanguage(state.languagePreference)
          applyDocumentLanguage(lang)
          return { lang }
        })
        if (useLanguageStore.getState().languagePreference === 'system') refreshSystemLanguage()
      },
    }),
    {
      name: 'refract-language',
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Partial<LanguageStore>
        if (version < 1) {
          return {
            ...state,
            // Preserve the old stored language as an explicit preference.
            languagePreference: state.lang ?? 'en',
          } as LanguageStore
        }
        return state as LanguageStore
      },
      partialize: (state) => ({ languagePreference: state.languagePreference }),
      onRehydrateStorage: () => (state) => state?.initialize(),
    }
  )
)
