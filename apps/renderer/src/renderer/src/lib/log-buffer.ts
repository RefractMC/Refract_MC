// Limit both line length and retained characters: a line-count limit alone
// permits a single noisy mod to retain arbitrarily large output.
export const MAX_LOG_LINE = 16 * 1024
export const MAX_CONSOLE_CHARACTERS = 256 * 1024
export const MAX_CONSOLE_INSTANCES = 10
const OMITTED = '[Refract: older or excessive console output omitted]'

export function boundedLines(
  lines: readonly string[],
  maxCharacters = MAX_CONSOLE_CHARACTERS
): string[] {
  const result: string[] = []
  let characters = 0
  let omitted = false
  for (let index = lines.length - 1; index >= 0; index--) {
    const line =
      lines[index].length <= MAX_LOG_LINE ? lines[index] : '[Refract: oversized log line omitted]'
    if (
      characters + line.length + 1 > maxCharacters - OMITTED.length - 1 ||
      result.length >= 1999
    ) {
      omitted = true
      break
    }
    result.push(line)
    characters += line.length + 1
  }
  if (omitted) result.push(OMITTED)
  return result.reverse()
}

export function appendConsoleLines(
  cache: Map<string, string[]>,
  instanceId: string,
  incoming: readonly string[],
  maxCharacters = MAX_CONSOLE_CHARACTERS
): void {
  const lines = boundedLines([...(cache.get(instanceId) ?? []), ...incoming], maxCharacters)
  cache.delete(instanceId)
  cache.set(instanceId, lines)
  while (cache.size > MAX_CONSOLE_INSTANCES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}
