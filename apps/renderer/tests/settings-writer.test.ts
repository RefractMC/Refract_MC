import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsWriter } from '../src/renderer/src/lib/settings-writer.js'

test('setting writes preserve rapid user intent and publish only committed values', async () => {
  let release: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: unknown[] = []
  const published: unknown[] = []
  const write = createSettingsWriter(async (_key, value) => {
    calls.push(value)
    if (value === true) await waiting
    return { minimizeToTray: value }
  })
  const enabled = write('minimizeToTray', true).then((saved) => published.push(saved))
  const disabled = write('minimizeToTray', false).then((saved) => published.push(saved))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [true])
  assert.deepEqual(published, [])
  release!()
  await Promise.all([enabled, disabled])
  assert.deepEqual(calls, [true, false])
  assert.deepEqual(published, [{ minimizeToTray: true }, { minimizeToTray: false }])
})

test('a denied write preserves the selected state and does not poison retry', async () => {
  let selected = false
  let attempts = 0
  const write = createSettingsWriter(async (_key, value) => {
    if (++attempts === 1) throw new Error('fixture denied write')
    return value as boolean
  })
  await assert.rejects(
    write('minimizeToTray', true).then((value) => {
      selected = value
    })
  )
  assert.equal(selected, false)
  selected = await write('minimizeToTray', true)
  assert.equal(selected, true)
})
