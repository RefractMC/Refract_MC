const NEWS_HUB_URL = 'https://www.minecraft.net/en-us/article'
const NEWS_SEARCH_URL =
  'https://net-secondary.web.minecraft-services.net/api/v1.0/en-us/search?category=News&page=1&pageSize=24&sortType=Recent&newsOnly=true&geography=US'
const NEWS_BASE_URL = 'https://www.minecraft.net'

export interface MinecraftNewsItem {
  title: string
  summary: string
  imageUrl: string | null
  url: string
  publishedAt?: string | null
}

interface MinecraftSearchResponse {
  result?: {
    results?: MinecraftSearchItem[]
  }
}

interface MinecraftSearchItem {
  title?: string
  description?: string
  image?: string
  url?: string
  time?: number
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|apos|gt|lt|nbsp|quot));/gi,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (named) return HTML_ENTITIES[named.toLowerCase()] ?? entity

      const numeric = hex ?? decimal
      if (!numeric) return entity

      const codePoint = Number.parseInt(numeric, hex ? 16 : 10)
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity
      return String.fromCodePoint(codePoint)
    }
  )
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function absolutizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('//')) return `https:${url}`
  return new URL(url, NEWS_BASE_URL).toString()
}

function isOfficialArticleUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'www.minecraft.net' && url.pathname.startsWith('/en-us/article')
  } catch {
    return false
  }
}

function trustedImageUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(absolutizeUrl(value))
    if (url.protocol !== 'https:' || url.hostname !== 'www.minecraft.net') return null
    return url.toString()
  } catch {
    return null
  }
}

function formatUnixDate(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null
  const date = new Date((value ?? 0) * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function firstMatch(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (match?.[1]) return match[1]
  }
  return null
}

export function parseMinecraftNewsHtml(html: string): MinecraftNewsItem[] {
  const items: MinecraftNewsItem[] = []
  const seen = new Set<string>()
  const cardRe = /<div\b[^>]*class="[^"]*\bMC_tiledHeroA_card\b[^"]*"[^>]*>(?<body>[\s\S]*?)<\/div>\s*<\/div>/gi
  const titleRe = /<h2\b[^>]*class="[^"]*\bMC_Heading_3\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i
  const summaryRe = /<div\b[^>]*class="[^"]*\bMC_tiledHeroA_blurb\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>[\s\S]*?<\/div>/i
  const imageRe = /<img\b[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/i
  const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*>(?:\s*<span>)?[\s\S]*?(?:Discover more|Brave the unknown|Explore more|Learn more)[\s\S]*?<\/a>/i

  for (const match of html.matchAll(cardRe)) {
    const body = match.groups?.body ?? ''
    const title = firstMatch(body, [titleRe])
    if (!title) continue
    const summary = firstMatch(body, [summaryRe]) ?? ''
    const image = firstMatch(body, [imageRe])
    const href = firstMatch(body, [linkRe])
    if (!href || seen.has(href)) continue

    let imageUrl: string | null = null
    if (image) {
      const candidate = image.split(',')[0]?.trim().split(/\s+/)[0]
      if (candidate) imageUrl = absolutizeUrl(candidate)
    }

    seen.add(href)
    items.push({
      title: stripTags(title),
      summary: stripTags(summary),
      imageUrl,
      url: absolutizeUrl(href),
      publishedAt: null,
    })
  }

  return items
}

function parseMinecraftNewsSearch(data: MinecraftSearchResponse): MinecraftNewsItem[] {
  const items: MinecraftNewsItem[] = []
  const seen = new Set<string>()

  for (const result of data.result?.results ?? []) {
    if (!result.title || !result.url || !isOfficialArticleUrl(result.url) || seen.has(result.url)) continue
    seen.add(result.url)

    items.push({
      title: stripTags(result.title),
      summary: stripTags(result.description ?? ''),
      imageUrl: trustedImageUrl(result.image),
      url: result.url,
      publishedAt: formatUnixDate(result.time),
    })
  }

  return items
}

async function fetchFeaturedNewsFallback(): Promise<MinecraftNewsItem[]> {
  const response = await fetch(NEWS_HUB_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  })
  if (!response.ok) return []
  const html = await response.text()
  return parseMinecraftNewsHtml(html)
}

export async function fetchMinecraftNews(): Promise<MinecraftNewsItem[]> {
  try {
    const response = await fetch(NEWS_SEARCH_URL, {
      headers: { Accept: 'application/json' },
    })
    if (response.ok) {
      const items = parseMinecraftNewsSearch((await response.json()) as MinecraftSearchResponse)
      if (items.length > 0) return items
    }
  } catch {
    // Fall through to the static featured cards below.
  }

  try {
    return await fetchFeaturedNewsFallback()
  } catch {
    return []
  }
}
