const MAX_FIELD = 16 * 1024
const OMITTED = '[Refract: oversized log entry omitted]'

// Defense in depth for renderer-originated diagnostics. Native filtering owns
// real authentication values and process output; those never belong in JS.
export function safeLogText(value: string): string {
  if (value.length > MAX_FIELD) return OMITTED
  if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      const visit = (input: unknown, depth: number): unknown => {
        if (depth > 20) return '[Nested value omitted]'
        if (typeof input === 'string') return safeLogText(input)
        if (Array.isArray(input)) return input.map((entry) => visit(entry, depth + 1))
        if (input && typeof input === 'object')
          return Object.fromEntries(
            Object.entries(input).map(([key, entry]) => [
              safeLogText(key),
              /^(?:access.?token|refresh.?token|client.?token|id.?token|device.?code|password|passwd|api.?key|authorization|session.?id|uuid|xuid|user.?name|user.?id)$/i.test(
                key
              )
                ? '<PRIVATE VALUE>'
                : visit(entry, depth + 1),
            ])
          )
        return input
      }
      const result = JSON.stringify(visit(parsed, 0))
      return result.length <= MAX_FIELD ? result : OMITTED
    } catch {
      /* Plain log text may start with a bracket. */
    }
  }
  return value
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '<AUTHORIZATION>')
    .replace(/\(session id is [^)]*\)/gi, '(session id redacted)')
    .replace(
      /(?:--)?(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?token|device[_ -]?code|password|passwd|api[_ -]?key|authorization|session[_ -]?id)(?:["']?\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;})]+)/gi,
      '<CREDENTIAL>'
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<TOKEN>')
    .replace(/[a-z]:[\\/]+Users[\\/]+[^\\/\r\n]+/gi, '<HOME>')
    .replace(/\/(?:home|Users)\/[^/\r\n]+/gi, '<HOME>')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://<CREDENTIALS>@')
}

export function safeLogDocument(value: string): string {
  if (value.length > 2 * 1024 * 1024) return OMITTED
  return value.split('\n').map(safeLogText).join('\n')
}

export function describeLogError(error: unknown): { message: string; stack?: string } {
  // Do not JSON.stringify an unbounded object graph or invoke its toJSON hook.
  // Expected IPC errors have a message/code; other objects get a safe type label.
  try {
    if (error instanceof Error)
      return {
        message: safeLogText(error.message),
        stack: error.stack ? safeLogText(error.stack) : undefined,
      }
    if (typeof error === 'string') return { message: safeLogText(error) }
    if (error === null || error === undefined || typeof error !== 'object')
      return { message: safeLogText(String(error)) }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
    const message = descriptor && 'value' in descriptor ? descriptor.value : undefined
    return { message: typeof message === 'string' ? safeLogText(message) : '[Non-Error object]' }
  } catch {
    return { message: '[Unreadable error object]' }
  }
}
