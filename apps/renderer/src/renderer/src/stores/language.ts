import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Lang = 'en' | 'uk'

interface LanguageStore {
  lang: Lang
  setLang: (lang: Lang) => void
}

export const useLanguageStore = create<LanguageStore>()(
  persist(
    (set) => ({
      lang: 'en' as Lang,
      setLang: (lang) => set({ lang }),
    }),
    { name: 'refract-language' }
  )
)
