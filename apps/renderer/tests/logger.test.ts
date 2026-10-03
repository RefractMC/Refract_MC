import assert from 'node:assert/strict'
import test from 'node:test'
import { logger, setNativeLogWriter } from '../src/renderer/src/lib/logger.js'

test('logger forwards sanitized entries without window.api and bounds storage and pending native writes', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalInfo = console.info
  let stored = 'x'.repeat(2 * 1024 * 1024)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    },
  })
  console.info = () => {}
  const received: string[] = []
  const releases: (() => void)[] = []
  setNativeLogWriter((entry) => {
    received.push(entry.message)
    return new Promise<void>((resolve) => releases.push(resolve))
  })
  try {
    for (let index = 0; index < 500; index++)
      logger.info(
        'fixture',
        `access_token=fixture-private-secret diagnostic ${index} ${'x'.repeat(1000)}`
      )
    assert.equal(received.length, 8)
    assert.ok(received.every((line) => !line.includes('fixture-private-secret')))
    assert.ok(stored.length <= 256 * 1024)
    assert.ok(!stored.includes('fixture-private-secret'))
    assert.ok(JSON.parse(stored).length <= 200)
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setImmediate(resolve))
    logger.info('fixture', 'after flood')
    assert.match(received.at(-1) ?? '', /omitted/)
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setImmediate(resolve))
    setNativeLogWriter(() => Promise.reject(new Error('logging failure')))
    logger.info('fixture', 'failed persistence does not throw or recurse')
    await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    releases.forEach((release) => release())
    setNativeLogWriter(async () => {})
    console.info = originalInfo
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
