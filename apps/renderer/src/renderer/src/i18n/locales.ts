import {
  parseSourceValue,
  parseTargetValue,
  resolveTargetValue,
  usableTargetText,
  type TargetValue,
} from '@shulha/lexmit/runtime'
import enJson from '@locales/en.json'
import { isCanonicalLocaleTag } from '@/lib/locale-match'

// Every JSON file in /locales is a language, so adding one needs no registry edit. Each
// file is named by its BCP 47 tag, and English is the source every other file follows.
const modules = import.meta.glob<Record<string, unknown>>('@locales/*.json', {
  eager: true,
  import: 'default',
})

function localeId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
}

export const RAW_LOCALES: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(modules)
    .map(([path, bundle]) => [localeId(path), bundle] as const)
    .filter(([id]) => isCanonicalLocaleTag(id))
)

export const LOCALE_IDS: readonly string[] = Object.keys(RAW_LOCALES).sort((a, b) => {
  if (a === 'en') return -1
  if (b === 'en') return 1
  return a.localeCompare(b)
})

export function isLocaleId(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(RAW_LOCALES, value)
}

export type Locale = typeof enJson

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A value lexmit cannot parse (a non-string, or a marker with nothing after it) is treated
// as missing, so one malformed entry falls back to English instead of breaking the page.
function targetValue(stored: unknown): TargetValue {
  try {
    return parseTargetValue(stored)
  } catch {
    return { kind: 'absent' }
  }
}

function resolveTree(source: Record<string, unknown>, target: unknown): Record<string, unknown> {
  const translated = isRecord(target) ? target : {}
  return Object.fromEntries(
    Object.entries(source).map(([key, sourceValue]) => {
      if (typeof sourceValue === 'string') {
        return [
          key,
          resolveTargetValue(parseSourceValue(sourceValue), targetValue(translated[key])),
        ]
      }
      return [key, resolveTree(sourceValue as Record<string, unknown>, translated[key])]
    })
  )
}

/**
 * The English tree with every string the locale may use replaced by its translation.
 *
 * lexmit's rules decide: a missing key, an untranslated `! ` scaffold or a translation whose
 * placeholders no longer match English shows English, and a `? ` translation still awaiting
 * review shows the translation without its marker.
 */
export function resolveLocale(id: string): Locale {
  if (id === 'en' || !isLocaleId(id)) return enJson
  return resolveTree(enJson, RAW_LOCALES[id]) as Locale
}

function countTree(source: Record<string, unknown>, target: unknown): [number, number] {
  const translated = isRecord(target) ? target : {}
  let usable = 0
  let total = 0
  for (const [key, sourceValue] of Object.entries(source)) {
    if (typeof sourceValue === 'string') {
      total++
      const text = usableTargetText(parseSourceValue(sourceValue), targetValue(translated[key]))
      if (text !== undefined) usable++
    } else {
      const [nestedUsable, nestedTotal] = countTree(
        sourceValue as Record<string, unknown>,
        translated[key]
      )
      usable += nestedUsable
      total += nestedTotal
    }
  }
  return [usable, total]
}

export interface LocaleCoverage {
  translated: number
  total: number
}

/** How many English strings the locale shows in its own language. */
export function localeCoverage(id: string): LocaleCoverage {
  const [translated, total] =
    id === 'en' ? countTree(enJson, enJson) : countTree(enJson, RAW_LOCALES[id])
  return { translated, total }
}

/** The language's name in that language, for the picker and the status dialog. */
export { localeNativeName } from '@shulha/lexmit/runtime'
