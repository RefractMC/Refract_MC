import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateLifecycle } from '../src/renderer/src/lib/update-lifecycle.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const calls: string[] = []
  let update: { install: (id?: string) => Promise<void> } | null = {
    install: async (id) => {
      calls.push(`install:${id ?? 'manual'}`)
    },
  }
  const deps = {
    downloadedUpdate: () => update,
    acknowledge: async (id: string) => {
      calls.push(`ack:${id}`)
    },
    finish: async (id: string) => {
      calls.push(`finish:${id}`)
    },
    cancel: async (id: string) => {
      calls.push(`cancel:${id}`)
    },
    cleanupFailed: () => {
      calls.push('cleanup-error')
    },
  }
  return {
    calls,
    deps,
    update: update!,
    clearUpdate: () => {
      update = null
    },
  }
}

test('manual installation uses one native call and repeated clicks share its completion', async () => {
  const f = fixture()
  const installer = deferred()
  f.update.install = async () => {
    f.calls.push('install')
    await installer.promise
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  const first = lifecycle.install()
  assert.equal(lifecycle.install(), first)
  assert.equal(lifecycle.busy, true)
  await tick()
  assert.deepEqual(f.calls, ['install'])
  installer.resolve()
  await first
  assert.deepEqual(f.calls, ['install'])
  assert.equal(lifecycle.busy, false)
})

test('a reported quit installer failure never finishes quit and permits retry', async () => {
  const f = fixture()
  let attempts = 0
  f.update.install = async (id) => {
    f.calls.push(`install:${id}`)
    if (++attempts === 1) throw new Error('fixture extraction failed')
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  const first = lifecycle.quit('quit-1')
  assert.equal(lifecycle.quit('quit-1'), first)
  assert.equal(lifecycle.install(), first)
  await assert.rejects(first, /extraction failed/)
  assert.equal(lifecycle.busy, false)
  assert.deepEqual(f.calls, ['ack:quit-1', 'install:quit-1', 'cancel:quit-1'])
  await lifecycle.quit('quit-2')
  assert.deepEqual(f.calls.slice(3), ['ack:quit-2', 'install:quit-2'])
})

test('a rejected manual install does not try to cancel an unknown native owner', async () => {
  const f = fixture()
  f.update.install = async () => {
    throw new Error('game is running')
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  await assert.rejects(lifecycle.install(), /game is running/)
  assert.deepEqual(f.calls, [])
  assert.equal(lifecycle.busy, false)
})

test('an expired acknowledgement only attempts cleanup for its own ID and cannot install', async () => {
  const f = fixture()
  f.deps.acknowledge = async () => {
    throw new Error('fallback already claimed exit')
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  await assert.rejects(lifecycle.quit('stale'), /fallback already claimed/)
  assert.deepEqual(f.calls, ['cancel:stale'])
})

test('ordinary quit and explicit quit without updating acknowledge before finishing', async () => {
  const f = fixture()
  const lifecycle = createUpdateLifecycle(f.deps)
  await lifecycle.quit('skip', true)
  f.clearUpdate()
  await lifecycle.quit('empty')
  assert.deepEqual(f.calls, ['ack:skip', 'finish:skip', 'ack:empty', 'finish:empty'])
  await assert.rejects(lifecycle.install(), /Download the app update/)
})

test('an unsettled installer stays busy and never sends finish or cancellation', async () => {
  const f = fixture()
  const installer = deferred()
  f.update.install = () => installer.promise
  const lifecycle = createUpdateLifecycle(f.deps)
  const task = lifecycle.quit('pending')
  const failure = assert.rejects(task, /installer settled with failure/)
  await tick()
  await tick()
  assert.equal(lifecycle.busy, true)
  assert.equal(lifecycle.install(), task)
  assert.deepEqual(f.calls, ['ack:pending'])
  installer.reject(new Error('installer settled with failure'))
  await failure
  assert.deepEqual(f.calls, ['ack:pending', 'cancel:pending'])
  assert.equal(lifecycle.busy, false)
})

test('a quit event racing manual native acquisition is handled after that attempt settles', async () => {
  const f = fixture()
  const acquisition = deferred()
  f.update.install = async (id) => {
    if (!id) await acquisition.promise
    f.calls.push(`install:${id}`)
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  const manual = lifecycle.install()
  const failed = assert.rejects(manual, /quit already owns maintenance/)
  const quit = lifecycle.quit('native-quit')
  acquisition.reject(new Error('quit already owns maintenance'))
  await failed
  await quit
  assert.deepEqual(f.calls, ['ack:native-quit', 'install:native-quit'])
})

test('failed handshake cleanup preserves the original error and retries only the known ID', async () => {
  const f = fixture()
  f.update.install = async () => {
    throw new Error('original install failure')
  }
  f.deps.cancel = async () => {
    throw new Error('IPC unavailable')
  }
  const lifecycle = createUpdateLifecycle(f.deps)
  await assert.rejects(lifecycle.quit('failed-quit'), /original install failure/)
  assert.deepEqual(f.calls, ['ack:failed-quit', 'cleanup-error'])
  f.deps.cancel = async (id) => {
    f.calls.push(`cancel:${id}`)
  }
  f.update.install = async () => {
    f.calls.push('install')
  }
  await lifecycle.install()
  assert.deepEqual(f.calls.slice(2), ['cancel:failed-quit', 'install'])
})

test('observed native failure permits retry when a reply is lost; a late reply cannot clear the retry', async () => {
  const f = fixture()
  const lostReply = deferred()
  const retryReply = deferred()
  let attempts = 0
  f.update.install = () => (++attempts === 1 ? lostReply.promise : retryReply.promise)
  const lifecycle = createUpdateLifecycle(f.deps)
  const old = lifecycle.install()
  const oldFailure = assert.rejects(old, /late failure reply/)
  await tick()
  lifecycle.observedFailure() // comes only from a newer native error/install snapshot
  const retry = lifecycle.install()
  assert.notEqual(retry, old)
  await tick()
  lostReply.reject(new Error('late failure reply'))
  await oldFailure
  assert.equal(lifecycle.busy, true)
  assert.equal(lifecycle.install(), retry)
  retryReply.resolve()
  await retry
  assert.equal(attempts, 2)
  assert.equal(lifecycle.busy, false)
})

test('quit reads native downloaded state after acknowledgement so reloads do not skip a ready update', async () => {
  const f = fixture()
  const lookup = deferred()
  const lifecycle = createUpdateLifecycle({
    ...f.deps,
    downloadedUpdate: async () => {
      await lookup.promise
      return f.update
    },
  })
  const quit = lifecycle.quit('restored')
  await tick()
  assert.deepEqual(f.calls, ['ack:restored'])
  lookup.resolve()
  await quit
  assert.deepEqual(f.calls, ['ack:restored', 'install:restored'])
})
