import { useLanguageStore } from '@/stores/language'
import enJson from '@locales/en.json'
import ukJson from '@locales/uk.json'
import zhCNJson from '@locales/zh-CN.json'

type Locale = typeof enJson

function mergeLocale<T>(fallback: T, overrides: unknown): T {
  if (Array.isArray(fallback)) {
    return (Array.isArray(overrides) ? overrides : fallback) as T
  }

  if (fallback !== null && typeof fallback === 'object') {
    const source = overrides !== null && typeof overrides === 'object'
      ? overrides as Record<string, unknown>
      : {}

    return Object.fromEntries(
      Object.entries(fallback).map(([key, value]) => [key, mergeLocale(value, source[key])]),
    ) as T
  }

  return (typeof overrides === typeof fallback ? overrides : fallback) as T
}

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
      licenseBody:   (name: string) => i(l.home.licenseBody, { name }),
      importFailed:  (e: string)    => i(l.home.importFailed, { e }),
      javaWarning:   (v: number)    => i(l.home.javaWarning, { v }),
      consoleTitle:  (name: string) => i(l.home.consoleTitle, { name }),
      selectedCount: (n: number)    => i(l.home.selectedCount, { n }),
      bulkDeleteBody:(n: number)    => i(l.home.bulkDeleteBody, { n }),
      moveDesc:      (n: number)    => i(l.home.moveDesc, { n }),
      modCount:      (n: number)    => i(l.home.modCount, { n }),
      ramWarnBody:   (need: string, avail: string) => i(l.home.ramWarnBody, { need, avail }),
      offlineBody:   (name: string) => i(l.home.offlineBody, { name }),
      exitCode:            (code: string | number) => i(l.home.exitCode, { code }),
      errorLine:           (error: string)         => i(l.home.errorLine, { error }),
      reportLine:          (file: string)          => i(l.home.reportLine, { file }),
      updateFailed:        (error: string)         => i(l.home.updateFailed, { error }),
      mcVersionNotFound:   (v: string)             => i(l.home.mcVersionNotFound, { v }),
      installFailedWith:   (message: string)       => i(l.home.installFailedWith, { message }),
      launchFailed:        (message: string)       => i(l.home.launchFailed, { message }),
      crashedWith:         (error: string)         => i(l.home.crashedWith, { error }),
      exitedWith:          (code: string | number) => i(l.home.exitedWith, { code }),
      modInstalledTo:      (name: string)          => i(l.home.modInstalledTo, { name }),
      repairFailed:        (message: string)       => i(l.home.repairFailed, { message }),
      activeDays:          (n: number)             => i(l.home.activeDays, { n }),
      ledBy:               (name: string)          => i(l.home.ledBy, { name }),
      activityLaunched:    (name: string)          => i(l.home.activityLaunched, { name }),
      activityCreated:     (name: string)          => i(l.home.activityCreated, { name }),
      activityImportedMmc: (name: string)          => i(l.home.activityImportedMmc, { name }),
      activityEdited:      (name: string)          => i(l.home.activityEdited, { name }),
      activityDeleted:     (name: string)          => i(l.home.activityDeleted, { name }),
      activityDuplicated:  (name: string)          => i(l.home.activityDuplicated, { name }),
      activityInstalledMc: (name: string)          => i(l.home.activityInstalledMc, { name }),
      activityLinked:      (name: string, source: string) => i(l.home.activityLinked, { name, source }),
      activityImportedExt: (name: string, source: string) => i(l.home.activityImportedExt, { name, source }),
    },

    browse: {
      ...l.browse,
      modsFound:    (n: number)                          => i(l.browse.modsFound, { n: n.toLocaleString() }),
      forInstance:  (mcVer: string, loader: string)      => i(l.browse.forInstance, { mcVer, loader }),
      installingTo: (name: string)                       => i(l.browse.installingTo, { name }),
      updatedOn:    (d: string)                          => i(l.browse.updatedOn, { d }),
      depsInstalling:  (name: string)   => i(l.browse.depsInstalling, { name }),
      depsRequired:    (n: number)      => i(l.browse.depsRequired, { n }),
      depsOptional:    (n: number)      => i(l.browse.depsOptional, { n }),
      depsAlready:     (n: number)      => i(l.browse.depsAlready, { n }),
      depsInstallPlus: (n: number)      => i(l.browse.depsInstallPlus, { n }),
      searchFailed:    (message: string) => i(l.browse.searchFailed, { message }),
      installedOk:      (name: string)                => i(l.browse.installedOk, { name }),
      installedOkStats: (name: string, stats: string) => i(l.browse.installedOkStats, { name, stats }),
      blockedBody:      (name: string)                => i(l.browse.blockedBody, { name }),
      blockedWaiting:   (s: number)                   => i(l.browse.blockedWaiting, { s }),
      depsInstalledOk: (name: string, n: number) =>
        i(n === 1 ? l.browse.depsInstalledOkOne : l.browse.depsInstalledOk, { name, n }),
      cfUnavailable:   (error: string)  => i(l.browse.cfUnavailable, { error }),
      inInstances:     (n: number)      => i(n === 1 ? l.browse.inInstancesOne : l.browse.inInstances, { n }),
      incompatibleTip: (v: string)      => i(l.browse.incompatibleTip, { v }),
      byAuthor:        (name: string)   => i(l.browse.byAuthor, { name }),
    },

    content: {
      ...l.content,
      found:            (n: number, label: string) => i(l.content.found, { n: n.toLocaleString(), label: label.toLowerCase() }),
      noContent:        (label: string)            => i(l.content.noContent, { label }),
      installingTo:     (name: string)             => i(l.content.installingTo, { name }),
      addLabel:         (label: string)            => i(l.content.addLabel, { label: label.toUpperCase() }),
      searchPlaceholder:(label: string)            => i(l.content.searchPlaceholder, { label: label.toLowerCase() }),
      mcTag:              (v: string)       => i(l.content.mcTag, { v }),
      alreadyInstalledAs: (name: string)    => i(l.content.alreadyInstalledAs, { name }),
      installFailedWith:  (error: string)   => i(l.content.installFailedWith, { error }),
      searchFailed:       (message: string) => i(l.content.searchFailed, { message }),
      installedToInstance:(name: string)    => i(l.content.installedToInstance, { name }),
      modpackInstalledStats:(stats: string) => i(l.content.modpackInstalledStats, { stats }),
      byAuthor:           (name: string)    => i(l.content.byAuthor, { name }),
      updatedDate:        (date: string)    => i(l.content.updatedDate, { date }),
      cfUnavailable:      (error: string)   => i(l.content.cfUnavailable, { error }),
    },

    themes: {
      ...l.themes,
      imageOpacity:  (p: number)  => i(l.themes.imageOpacity, { p }),
      backgroundDim: (p: number)  => i(l.themes.backgroundDim, { p }),
      blur:          (px: number) => i(l.themes.blur, { px }),
    },

    news: { ...l.news },

    settings: {
      ...l.settings,
      javaDetected:    (n: number)              => i(n !== 1 ? l.settings.javaDetected : l.settings.javaDetectedSingle, { n }),
      recentEntries:   (n: number)              => i(l.settings.recentEntries, { n }),
      javaInstalled:   (n: number)              => i(l.settings.javaInstalled, { n }),
      javaFailed:      (n: number, e: string)   => i(l.settings.javaFailed, { n, e }),
      javaManagedRemoved: (major: number)       => i(l.settings.javaManagedRemoved, { major }),
      javaManagedRemoveTitle: (version: string | number) => i(l.settings.javaManagedRemoveTitle, { version }),
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
      nameSuffix:    (label: string)  => i(l.createInst.nameSuffix, { label }),
      mcVersionLine: (v: string)      => i(l.createInst.mcVersionLine, { v }),
      gbChip:        (gb: number)     => i(l.createInst.gbChip, { gb }),
      loaderVersion: (loader: string) => i(l.createInst.loaderVersion, { loader }),
      memAllocated:  (gb: number)     => i(l.createInst.memAllocated, { gb }),
      gigShort:      (g: number)      => i(l.createInst.gigShort, { g }),
      previewHelp:   (name: string)   => i(l.createInst.previewHelp, { name }),
    },

    editInst: {
      ...l.editInst,
      memory:      (gb: string)               => i(l.editInst.memory, { gb }),
      ram:         (mb: number)               => mb >= 1024
        ? i(l.editInst.ramGb, { gb: String(mb / 1024) })
        : i(l.editInst.ramMb, { mb }),
      javaVersion: (v: number, vendor: string) => i(l.editInst.javaVersion, { v, vendor }),
      optionsSyncDone: (files: string) => i(l.editInst.optionsSyncDone, { files }),
      mcVersionLine: (v: string)      => i(l.editInst.mcVersionLine, { v }),
      gbChip:        (gb: number)     => i(l.editInst.gbChip, { gb }),
      loaderVersion: (loader: string) => i(l.editInst.loaderVersion, { loader }),
      memAllocated:  (gb: number)     => i(l.editInst.memAllocated, { gb }),
      gigShort:      (g: number)      => i(l.editInst.gigShort, { g }),
    },

    instanceDetail: {
      ...l.instanceDetail,
      selected:  (n: number) => i(l.instanceDetail.selected, { n }),
      updateAll: (n: number) => i(l.instanceDetail.updateAll, { n }),
      players:   (online: number, max: number) => i(l.instanceDetail.players, { online, max }),
      verifyAllOk:    (n: number) => i(l.instanceDetail.verifyAllOk, { n }),
      verifyIssues:   (n: number) => i(l.instanceDetail.verifyIssues, { n }),
      verifyRepaired: (n: number, total: number) => i(l.instanceDetail.verifyRepaired, { n, total }),
    },

    skins: {
      ...l.skins,
      addedOn:    (date: string)     => i(l.skins.addedOn, { date }),
      useSkinAs:  (username: string) => i(l.skins.useSkinAs, { username }),
      skinApplied:(username: string) => i(l.skins.skinApplied, { username }),
    },

    sync: {
      ...l.sync,
      instances: (n: number) => i(n !== 1 ? l.sync.instanceCountPlural : l.sync.instanceCount, { n }),
    },

    sharing: { ...l.sharing },
    migration: { ...l.migration },
    privacy: { ...l.privacy },
  }
}

export type T = ReturnType<typeof build>

const locales: Record<string, Locale> = {
  en: enJson,
  uk: mergeLocale(enJson, ukJson),
  'zh-CN': mergeLocale(enJson, zhCNJson),
}

export const translations: Record<string, T> = {
  en: build(locales.en),
  uk: build(locales.uk),
  'zh-CN': build(locales['zh-CN']),
}

export function useT(): T {
  const lang = useLanguageStore((s) => s.lang)
  return translations[lang] ?? translations.en
}

/** Register a new locale at runtime (for community translation bundles). */
export function registerLocale(code: string, data: Locale): void {
  const locale = mergeLocale(enJson, data)
  locales[code] = locale
  translations[code] = build(locale)
}
