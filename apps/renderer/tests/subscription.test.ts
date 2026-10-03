import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownSubscription } from '../src/renderer/src/lib/subscription'

const unexpected = (value: unknown) => assert.fail(String(value))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

test('unmount before native registration detaches the late listener and ignores queued events', async () => {
  const registration = deferred<() => void>()
  let emit!: (value: number) => void
  let detached = 0
  const received: number[] = []
  const off = ownSubscription<number>(
    (callback) => {
      emit = callback
      return registration.promise
    },
    (value) => received.push(value),
    unexpected
  )
  emit(1)
  off()
  emit(2)
  registration.resolve(() => {
    detached += 1
  })
  await registration.promise
  emit(3)
  off()
  assert.deepEqual(received, [1])
  assert.equal(detached, 1)
})

test('an active listener detaches once and cannot deliver an in-flight query after cleanup', async () => {
  const query = deferred<boolean>()
  let detached = 0
  const received: boolean[] = []
  const off = ownSubscription<boolean>(
    async (emit) => {
      void query.promise.then(emit)
      emit(false)
      return () => {
        detached += 1
      }
    },
    (value) => received.push(value),
    unexpected
  )
  await Promise.resolve()
  off()
  off()
  query.resolve(true)
  await query.promise
  assert.deepEqual(received, [false])
  assert.equal(detached, 1)
})

test('StrictMode setup-cleanup-setup keeps only the current subscription active', async () => {
  const registrations = [deferred<() => void>(), deferred<() => void>()]
  const emitters: ((value: number) => void)[] = []
  const detached = [0, 0]
  const received: number[] = []
  const mount = () =>
    ownSubscription<number>(
      (emit) => {
        const index = emitters.push(emit) - 1
        return registrations[index].promise
      },
      (value) => received.push(value),
      unexpected
    )
  const first = mount()
  first()
  const second = mount()
  registrations[1].resolve(() => {
    detached[1] += 1
  })
  registrations[0].resolve(() => {
    detached[0] += 1
  })
  await Promise.all(registrations.map(({ promise }) => promise))
  emitters.forEach((emit) => emit(42))
  assert.deepEqual(received, [42])
  assert.deepEqual(detached, [1, 0])
  second()
  assert.deepEqual(detached, [1, 1])
})

test('registration rejection and synchronous native errors are reported without unhandled rejections', async () => {
  const registration = deferred<() => void>()
  const failure = new Error('native registration failed')
  const errors: unknown[] = []
  const onError = (error: unknown) => errors.push(error)
  const off = ownSubscription(() => registration.promise, unexpected, onError)
  off()
  registration.reject(failure)
  await registration.promise.catch(() => {})
  ownSubscription(
    () => {
      throw failure
    },
    unexpected,
    onError
  )()
  assert.deepEqual(errors, [failure, failure])
})

test('failed detach is reported once and further queued callbacks stay suppressed', async () => {
  const failure = new Error('native detach failed')
  const errors: unknown[] = []
  let emit!: (value: number) => void
  const off = ownSubscription<number>(
    async (callback) => {
      emit = callback
      return () => {
        throw failure
      }
    },
    unexpected,
    (error) => errors.push(error)
  )
  await Promise.resolve()
  off()
  off()
  emit(1)
  assert.deepEqual(errors, [failure])
})
