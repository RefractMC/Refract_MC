import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearLauncherStorage,
  finishLauncherReset,
} from '../src/renderer/src/lib/launcher-reset.js'

function storage(initial: string[]) {
  const values = new Map(initial.map((key) => [key, 'saved']))
  return {
    values,
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

test('reset removes launcher persistence without skipping keys or clearing unrelated data', () => {
  const data = storage([
    'refract-theme',
    'refract-avatars',
    'refract-language',
    'refract.creator.drafts.v1',
    'refract.skin-face.v1.player',
    'unrelated',
    'refractory',
  ])
  clearLauncherStorage(data)
  assert.deepEqual([...data.values.keys()], ['unrelated', 'refractory'])
})

test('failed local cleanup does not reload or clear queries; completion can be retried', async () => {
  const local = storage(['refract-theme'])
  const session = storage(['refract.session'])
  const events: string[] = []
  let locked = true
  const deps = {
    cancelQueries: async () => {
      events.push('cancel')
    },
    clearQueries: () => {
      events.push('clear')
    },
    local: {
      ...local,
      removeItem: (key: string) => {
        if (locked) throw new Error('storage denied')
        local.removeItem(key)
      },
    },
    session,
    reload: () => {
      events.push('reload')
    },
  }
  await assert.rejects(finishLauncherReset(deps), /storage denied/)
  assert.deepEqual(events, ['cancel'])
  assert.equal(session.length, 1)
  locked = false
  await finishLauncherReset(deps)
  assert.deepEqual(events, ['cancel', 'cancel', 'clear', 'reload'])
  assert.equal(local.length, 0)
  assert.equal(session.length, 0)
})
