import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUpdateMetadata } from '../src/renderer/src/lib/update-metadata.js'

test('native update metadata accepts no update and strips fields outside the resource contract', () => {
  assert.equal(parseUpdateMetadata(null), null)
  assert.deepEqual(
    parseUpdateMetadata({
      rid: 0,
      currentVersion: '1.4.0',
      version: '1.4.1',
      rawJson: { private: 'discarded' },
    }),
    { rid: 0, currentVersion: '1.4.0', version: '1.4.1' }
  )
})

test('malformed native update metadata cannot become an installable resource', () => {
  for (const value of [undefined, false, [], 4, {}, { rid: 2, version: '1.4.1' }]) {
    assert.throws(() => parseUpdateMetadata(value), /Invalid native update response/)
  }
  for (const rid of [-1, 0.5, NaN, Infinity, 0x100000000, '2']) {
    assert.throws(() => parseUpdateMetadata({ rid, currentVersion: '1.4.0', version: '1.4.1' }))
  }
  for (const version of ['', null, 5, {}]) {
    assert.throws(() => parseUpdateMetadata({ rid: 2, currentVersion: '1.4.0', version }))
  }
})
