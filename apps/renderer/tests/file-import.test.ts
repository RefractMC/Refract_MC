import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyFileImportResult,
  parseFileImportResult,
  type FileImportState,
} from '../src/renderer/src/lib/file-import.js'

const pending: FileImportState = {
  importId: 'attempt-1',
  status: 'importing',
  name: 'Archive',
  filePath: 'fixture.zip',
  step: 'Extracting',
  percent: 2,
}

test('an import requiring a version never becomes a completed instance', () => {
  const result = parseFileImportResult({ status: 'needsVersion' })
  const state = applyFileImportResult(pending, pending.importId, result, 'Choose version', 'Done')
  assert.equal(state?.status, 'needsVersion')
  assert.equal(state?.minecraftVersion, undefined)
  assert.equal(state?.instanceId, undefined)
  assert.equal(state?.percent, 2)
})

test('invalid or contradictory native results cannot report import success', () => {
  for (const value of [
    null,
    {},
    { id: 'old-untyped-result' },
    { status: 'installed' },
    { status: 'installed', id: '../outside' },
    { status: 'needsVersion', id: 'unexpected-instance' },
  ]) {
    assert.throws(() => parseFileImportResult(value), /Invalid import result/)
  }
  assert.deepEqual(
    parseFileImportResult({ status: 'installed', id: 'fixture-id', extra: 'ignored' }),
    { status: 'installed', id: 'fixture-id' }
  )
})

test('late replies cannot replace a newer attempt, user choice, or terminal state', () => {
  const result = parseFileImportResult({ status: 'installed', id: 'fixture-id' })
  assert.equal(applyFileImportResult(pending, 'old-attempt', result, 'Choose', 'Done'), pending)
  for (const status of ['needsVersion', 'done', 'error'] as const) {
    const current = { ...pending, status, minecraftVersion: '1.7.10' }
    assert.equal(
      applyFileImportResult(current, current.importId, result, 'Choose', 'Done'),
      current
    )
  }
  assert.equal(applyFileImportResult(null, pending.importId, result, 'Choose', 'Done'), null)
})

test('the command reply completes a matching import even if its event was lost', () => {
  const result = parseFileImportResult({ status: 'installed', id: 'fixture-id' })
  const state = applyFileImportResult(
    { ...pending, minecraftVersion: '1.7.10' },
    pending.importId,
    result,
    'Choose',
    'Done'
  )
  assert.equal(state?.status, 'done')
  assert.equal(state?.instanceId, 'fixture-id')
  assert.equal(state?.percent, 100)
  assert.equal(state?.minecraftVersion, '1.7.10')
})
