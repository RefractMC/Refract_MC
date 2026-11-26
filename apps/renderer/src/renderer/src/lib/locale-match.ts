// Locale tag matching for the language picker and system-language detection. Kept free of
// Vite and lexmit imports so the renderer regression tests can load it directly.

// OS locale strings can arrive in POSIX form (uk_UA.UTF-8, sr_RS@latin) or as BCP 47 tags.
function canonicalTag(tag: string): string | null {
  const normalized = tag.trim().split(/[.@]/, 1)[0].replace(/_/g, '-')
  if (!normalized) return null
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? null
  } catch {
    return null
  }
}

function maximized(tag: string): Intl.Locale | null {
  try {
    return new Intl.Locale(tag).maximize()
  } catch {
    return null
  }
}

/**
 * Picks the available locale that best serves a requested tag, or null when none does.
 *
 * An exact match wins. Otherwise the language and its script must agree, so zh-SG and
 * zh-Hans choose zh-CN, while zh-TW and zh-HK (Traditional script) do not. Among candidates
 * with the same script, one with the same region is preferred.
 */
export function matchLocale(tag: string, available: readonly string[]): string | null {
  const requested = canonicalTag(tag)
  if (!requested) return null

  const lower = requested.toLowerCase()
  const exact = available.find((id) => id.toLowerCase() === lower)
  if (exact) return exact

  const wanted = maximized(requested)
  if (!wanted) return null

  let best: string | null = null
  let bestScore = 0
  for (const id of available) {
    const candidate = maximized(id)
    if (!candidate) continue
    if (candidate.language !== wanted.language || candidate.script !== wanted.script) continue
    const score = candidate.region === wanted.region ? 2 : 1
    if (score > bestScore) {
      best = id
      bestScore = score
    }
  }
  return best
}

/** The first preferred tag that an available locale can serve, falling back to English. */
export function detectLocale(preferred: readonly string[], available: readonly string[]): string {
  for (const tag of preferred) {
    const match = matchLocale(tag, available)
    if (match) return match
  }
  return 'en'
}

/** A locale file name is accepted as a language only when it is a canonical BCP 47 tag. */
export function isCanonicalLocaleTag(id: string): boolean {
  return canonicalTag(id) === id
}
