const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function parseHexAlpha(value: string): { hex: string; alpha: number } | null {
  const color = value.trim()
  if (!HEX_COLOR.test(color)) return null
  let digits = color.slice(1)
  if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('')
  return {
    hex: `#${digits.slice(0, 6).toLowerCase()}`,
    alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1,
  }
}

// Opaque colors keep the 6-digit form so themes without alpha save exactly as before.
export function formatHexAlpha(hex: string, alpha: number): string {
  const byte = Math.round(alpha * 255)
  return byte >= 255 ? hex : `${hex}${byte.toString(16).padStart(2, '0')}`
}

// Hand-written themes may use other CSS color syntax; treat it as opaque.
export function colorAlpha(value: string | undefined): number {
  if (!value) return 1
  return parseHexAlpha(value)?.alpha ?? 1
}

export function opaqueColor(value: string): string {
  return parseHexAlpha(value)?.hex ?? value
}

// Colors in other CSS syntax count as dark, like the default theme.
export function isDarkColor(value: string | undefined): boolean {
  const hex = value ? parseHexAlpha(value)?.hex : undefined
  if (!hex) return true
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}
