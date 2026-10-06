import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addPreviewActivity,
  readPreviewActivity,
} from '../src/renderer/src/lib/activity-storage.js'

test('damaged preview activity is preserved and prevents replacing history', () => {
  for (const raw of ['{', '{}', '[{"id":"bad","label":3,"ts":1}]']) {
    let writes = 0
    const storage = {
      getItem: () => raw,
      setItem: () => {
        writes += 1
      },
    }
    assert.throws(() => readPreviewActivity(storage))
    assert.throws(() => addPreviewActivity(storage, { id: 'new', label: 'New', ts: 2 }))
    assert.equal(writes, 0)
  }
})

test('preview storage read and quota failures cannot report a saved activity entry', () => {
  const entry = { id: 'new', label: 'New', ts: 2 }
  assert.throws(
    () =>
      addPreviewActivity(
        {
          getItem: () => {
            throw Error('denied')
          },
          setItem: () => {},
        },
        entry
      ),
    /denied/
  )
  const raw = '[{"id":"old","label":"Keep","ts":1}]'
  const storage = {
    getItem: () => raw,
    setItem: () => {
      throw Error('quota')
    },
  }
  assert.throws(() => addPreviewActivity(storage, entry), /quota/)
  assert.equal(readPreviewActivity(storage)[0].label, 'Keep')
})

test('preview activity commits newest first with the same fifty-entry limit', () => {
  let raw: string | null = null
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value
    },
  }
  for (let index = 0; index < 60; index++)
    addPreviewActivity(storage, { id: `${index}`, label: `${index}`, ts: index })
  const records = readPreviewActivity(storage)
  assert.equal(records.length, 50)
  assert.equal(records[0].label, '59')
  assert.equal(records[49].label, '10')
})
