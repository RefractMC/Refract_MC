import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendConsoleLines,
  boundedLines,
  MAX_CONSOLE_CHARACTERS,
  MAX_CONSOLE_INSTANCES,
  MAX_LOG_LINE,
} from '../src/renderer/src/lib/log-buffer.js'

test('console history bounds characters, lines, and retained instances while keeping recent output', () => {
  const lines = boundedLines(
    Array.from({ length: 4000 }, (_, index) => `${index} ${'x'.repeat(1000)}`)
  )
  assert.ok(lines.join('\n').length <= MAX_CONSOLE_CHARACTERS)
  assert.ok(lines.length <= 2000)
  assert.ok(lines.at(-1)?.startsWith('3999'))
  assert.match(lines[0], /omitted/)
  const cache = new Map<string, string[]>()
  for (let index = 0; index < 100; index++)
    appendConsoleLines(cache, `instance-${index}`, ['latest'])
  assert.equal(cache.size, MAX_CONSOLE_INSTANCES)
  assert.equal(cache.has('instance-0'), false)
  assert.equal(cache.has('instance-99'), true)
})

test('an oversized line is discarded whole and pending output obeys the smaller budget', () => {
  const cache = new Map<string, string[]>()
  appendConsoleLines(cache, 'fixture', ['x'.repeat(MAX_LOG_LINE + 1), 'useful diagnostic'], 1000)
  assert.match(cache.get('fixture')?.[0] ?? '', /oversized/)
  for (let index = 0; index < 500; index++)
    appendConsoleLines(cache, 'fixture', [`line ${index}`], 1000)
  assert.ok((cache.get('fixture') ?? []).join('\n').length <= 1000)
  assert.equal(cache.get('fixture')?.at(-1), 'line 499')
})
