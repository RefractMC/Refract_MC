import { useLanguageStore } from '@/stores/language'
import enJson from '@locales/en.json'
import ukJson from '@locales/uk.json'

type Locale = typeof enJson

/** Replace {{param}} placeholders with values from a params map. */
function i(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? k))
}

function build(l: Locale) {
  return {
    nav: { ...l.nav },

    sidebar: {
      ...l.sidebar,
      addedDaysAgo: (n: number) => i(l.sidebar.addedDaysAgo, { n }),
    },

    home: {
      ...l.home,
      licenseBody:  (name: string) => i(l.home.licenseBody, { name }),
      importFailed: (e: string)    => i(l.home.importFailed, { e }),
      javaWarning:  (v: number)    => i(l.home.javaWarning, { v }),
      consoleTitle: (name: string) => i(l.home.consoleTitle, { name }),
    },

    browse: {
      ...l.browse,
      modsFound:    (n: number)                          => i(l.browse.modsFound, { n: n.toLocaleString() }),
      forInstance:  (mcVer: string, loader: string)      => i(l.browse.forInstance, { mcVer, loader }),
      installingTo: (name: string)                       => i(l.browse.installingTo, { name }),
      updatedOn:    (d: string)                          => i(l.browse.updatedOn, { d }),
    },

    content: {
      ...l.content,
      found:            (n: number, label: string) => i(l.content.found, { n: n.toLocaleString(), label: label.toLowerCase() }),
      noContent:        (label: string)            => i(l.content.noContent, { label }),
      installingTo:     (name: string)             => i(l.content.installingTo, { name }),
      addLabel:         (label: string)            => i(l.content.addLabel, { label: label.toUpperCase() }),
      searchPlaceholder:(label: string)            => i(l.content.searchPlaceholder, { label: label.toLowerCase() }),
    },

    settings: {
      ...l.settings,
      javaDetected:    (n: number)              => i(n !== 1 ? l.settings.javaDetected : l.settings.javaDetectedSingle, { n }),
      recentEntries:   (n: number)              => i(l.settings.recentEntries, { n }),
      javaInstalled:   (n: number)              => i(l.settings.javaInstalled, { n }),
      javaFailed:      (n: number, e: string)   => i(l.settings.javaFailed, { n, e }),
      javaVersionLabel:(v: number): string => {
        if (v >= 21) return l.settings.javaVersionLabel.v21plus
        if (v >= 17) return l.settings.javaVersionLabel.v17to20
        if (v === 16) return l.settings.javaVersionLabel.v16
        return l.settings.javaVersionLabel.legacy
      },
    },

    account: {
      ...l.account,
      activeHeader: (name: string) => i(l.account.activeHeader, { name }),
    },

    createInst: {
      ...l.createInst,
      memory: (gb: string)  => i(l.createInst.memory, { gb }),
      ram:    (mb: number)  => mb >= 1024
        ? i(l.createInst.ramGb, { gb: String(mb / 1024) })
        : i(l.createInst.ramMb, { mb }),
    },

    editInst: {
      ...l.editInst,
      memory:      (gb: string)               => i(l.editInst.memory, { gb }),
      ram:         (mb: number)               => mb >= 1024
        ? i(l.editInst.ramGb, { gb: String(mb / 1024) })
        : i(l.editInst.ramMb, { mb }),
      javaVersion: (v: number, vendor: string) => i(l.editInst.javaVersion, { v, vendor }),
    },

    instanceDetail: {
      ...l.instanceDetail,
      selected:  (n: number) => i(l.instanceDetail.selected, { n }),
      updateAll: (n: number) => i(l.instanceDetail.updateAll, { n }),
      players:   (online: number, max: number) => i(l.instanceDetail.players, { online, max }),
    },

    skins: {
      ...l.skins,
      addedOn:    (date: string)     => i(l.skins.addedOn, { date }),
      useSkinAs:  (username: string) => i(l.skins.useSkinAs, { username }),
      skinApplied:(username: string) => i(l.skins.skinApplied, { username }),
    },
  }
}

export type T = ReturnType<typeof build>

const locales: Record<string, Locale> = { en: enJson, uk: ukJson as unknown as Locale }

export const translations: Record<string, T> = {
  en: build(enJson),
  uk: build(ukJson as unknown as Locale),
}

export function useT(): T {
  const lang = useLanguageStore((s) => s.lang)
  return translations[lang] ?? translations.en
}

/** Register a new locale at runtime (for community translation bundles). */
export function registerLocale(code: string, data: Locale): void {
  locales[code] = data
  translations[code] = build(data)
}
