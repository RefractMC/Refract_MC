import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUpdateStatusReader,
  createUpdateStatusStore,
  parseUpdateStatus,
} from '../src/renderer/src/lib/update-status.js'

function snapshot(revision = 1, phase = 'available') {
  return {
    revision,
    phase,
    update: { rid: 3, currentVersion: '1.4.0', version: '1.4.1' },
    percent: null,
    error: null,
    retry: null,
    slow: false,
  }
}

test('reconnected native state contains only validated display and resource fields', () => {
  const state = parseUpdateStatus({
    ...snapshot(8, 'ready'),
    percent: 100,
    private: 'omit',
    update: { ...snapshot().update, downloadUrl: 'https://example.invalid/private' },
  })
  assert.equal(state.phase, 'ready')
  assert.equal(state.version, '1.4.1')
  assert.equal(state.percent, 100)
  assert.equal('private' in state, false)
  assert.equal('downloadUrl' in state.update!, false)
})

test('malformed and contradictory status cannot expose update actions', () => {
  for (const patch of [
    { revision: -1 },
    { revision: NaN },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { phase: 'complete-ish' },
    { percent: 101 },
    { percent: '20' },
    { error: {} },
    { retry: 'delete' },
    { slow: 'yes' },
    { phase: 'installing', update: null },
    { phase: 'error' },
    { slow: true },
  ])
    assert.throws(() => parseUpdateStatus({ ...snapshot(), ...patch }))
  assert.equal(parseUpdateStatus({ ...snapshot(1, 'idle'), update: null }).update, null)
})

test('late replies never replace a newer native phase and new routes replay that phase', () => {
  const store = createUpdateStatusStore()
  const phases: string[] = []
  const off = store.subscribe((state) => phases.push(state.phase))
  store.accept(snapshot(4, 'installing'))
  store.accept(snapshot(3, 'ready'))
  store.accept(snapshot(4, 'installing'))
  assert.deepEqual(phases, ['installing'])
  off()
  store.accept({ ...snapshot(5, 'error'), error: 'installer failed', retry: 'install' })
  assert.deepEqual(phases, ['installing'])
  const remounted: string[] = []
  store.subscribe((state) => remounted.push(state.phase))()
  assert.deepEqual(remounted, ['error'])
})

test('a renewed WebView resource binding can replace its ID at the same state revision', () => {
  const store = createUpdateStatusStore()
  store.accept(snapshot(7, 'ready'))
  const renewed = store.accept({
    ...snapshot(7, 'ready'),
    update: { ...snapshot().update, rid: 9 },
  })
  assert.equal(renewed.update?.rid, 9)
  assert.equal(store.get()?.phase, 'ready')
})

test('a lost status reply permits another read without accepting its late result', async () => {
  const store = createUpdateStatusStore()
  let release!: (value: unknown) => void
  let calls = 0
  const missing = new Promise((resolve) => {
    release = resolve
  })
  const read = createUpdateStatusReader(
    async () => (++calls === 1 ? missing : snapshot(10, 'installing')),
    (value) => store.accept(value),
    20
  )
  const first = read()
  assert.equal(read(), first)
  await assert.rejects(first, /did not respond/)
  assert.equal((await read()).phase, 'installing')
  release(snapshot(1, 'available'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(store.get()?.revision, 10)
  assert.equal(calls, 2)
})

test('slow native state stays installing and offers no fabricated terminal failure', () => {
  const state = parseUpdateStatus({ ...snapshot(11, 'installing'), slow: true })
  assert.equal(state.phase, 'installing')
  assert.equal(state.retry, undefined)
  assert.equal(state.error, undefined)
})
