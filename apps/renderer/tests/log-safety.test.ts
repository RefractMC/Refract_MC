import assert from 'node:assert/strict'
import test from 'node:test'
import { describeLogError, safeLogText } from '../src/renderer/src/lib/log-safety.js'

test('renderer diagnostics filter credentials and private paths', () => {
  for (const input of [
    'Authorization: Bearer fixture-private-secret useful error',
    'access_token=fixture-private-secret useful error',
    'refresh_token="fixture-private-secret" useful error',
    '(Session ID is fixture-private-secret) useful error',
    '{"message":"refresh_token=\\"fixture-private-secret\\" useful error"}',
    'C:\\Users\\FixturePerson\\Games\\mod.jar useful error',
    '/home/FixturePerson/Games/mod.jar useful error',
  ]) {
    const output = safeLogText(input)
    assert.ok(!output.includes('fixture-private-secret'))
    assert.ok(!output.includes('FixturePerson'))
    assert.ok(output.includes('useful error'))
  }
  assert.equal(safeLogText('java.lang.OutOfMemoryError'), 'java.lang.OutOfMemoryError')
})

test('error logging does not walk hostile object graphs or serialize oversized strings', () => {
  const error = {
    toJSON() {
      throw Error('must not execute')
    },
    get message() {
      throw Error('must not execute')
    },
  }
  assert.equal(describeLogError(error).message, '[Non-Error object]')
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error('must not escape logging')
      },
    }
  )
  assert.equal(describeLogError(proxy).message, '[Unreadable error object]')
  assert.match(describeLogError('x'.repeat(1024 * 1024)).message, /omitted/)
  const cyclic: Record<string, unknown> = { message: 'useful failure' }
  cyclic.self = cyclic
  assert.equal(describeLogError(cyclic).message, 'useful failure')
})
