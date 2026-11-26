import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
import { LOCALE_IDS, isLocaleId } from '@/i18n/locales'
import { detectLocale } from '@/lib/locale-match'

/** A BCP 47 tag with a matching file in /locales. */
export type Lang = string
export type LanguagePreference = 'system' | Lang

interface LanguageStore {
  languagePreference: LanguagePreference
  lang: Lang
  setLanguagePreference: (preference: LanguagePreference) => void
  setLang: (lang: Lang) => void
  initialize: () => void
}

export function detectSystemLanguage(languages?: readonly string[]): Lang {
  const candidates = languages
    ?? (typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language])

  return detectLocale(candidates, LOCALE_IDS)
}

/**
 * Whether a stored preference can still be honoured. A language whose file was removed
 * keeps its stored value, in case a later version brings it back, but behaves as System.
 */
export function effectivePreference(preference: LanguagePreference): LanguagePreference {
  return preference === 'system' || isLocaleId(preference) ? preference : 'system'
}

function resolveLanguage(preference: LanguagePreference): Lang {
  const effective = effectivePreference(preference)
  return effective === 'system' ? detectSystemLanguage() : effective
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
    if (request !== systemLanguageRequest || effectivePreference(state.languagePreference) !== 'system') return
    applyResolvedLanguage(detectSystemLanguage(languages.length ? languages : undefined))
  }).catch(() => {})
}

function installLanguageListener(): void {
  if (languageListenerInstalled || typeof window === 'undefined') return
  languageListenerInstalled = true
  const refresh = () => {
    const state = useLanguageStore.getState()
    if (effectivePreference(state.languagePreference) === 'system') refreshSystemLanguage()
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
        if (effectivePreference(preference) === 'system') refreshSystemLanguage()
      },
      setLang: (preference) => {
        systemLanguageRequest++
        const lang = resolveLanguage(preference)
        applyDocumentLanguage(lang)
        set({ languagePreference: preference, lang })
      },
      initialize: () => {
        installLanguageListener()
        set((state) => {
          const lang = resolveLanguage(state.languagePreference)
          applyDocumentLanguage(lang)
          return { lang }
        })
        if (effectivePreference(useLanguageStore.getState().languagePreference) === 'system') refreshSystemLanguage()
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
