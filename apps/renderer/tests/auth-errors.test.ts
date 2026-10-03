import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authErrorCode,
  authErrorMessage,
  authRecoveryAction,
} from '../src/renderer/src/lib/auth-errors.js'
import { startDevicePolling } from '../src/renderer/src/lib/device-poll.js'

test('auth recovery depends on codes, never error prose', () => {
  for (const message of ['AUTH_EXPIRED', 'network connection timed out', 'expired_token']) {
    assert.equal(authRecoveryAction(new Error(message)), 'none')
  }
  assert.equal(authRecoveryAction({ code: 'AUTH_EXPIRED', message: '网络' }), 'signIn')
  assert.equal(authRecoveryAction({ code: 'NETWORK_UNAVAILABLE', message: 'expired' }), 'offline')
  assert.equal(authRecoveryAction({ code: 'AUTH_SERVICE_UNAVAILABLE' }), 'offline')
  assert.equal(authRecoveryAction({ code: 'VAULT_LOCKED' }), 'retry')
  assert.equal(authRecoveryAction({ code: 'AUTH_ACCOUNT_NOT_FOUND' }), 'accounts')
  assert.equal(authRecoveryAction({ code: 'VAULT_KEY_MISSING' }), 'none')
  assert.equal(authErrorCode(null), undefined)
  assert.equal(authErrorCode({ code: 42 }), undefined)
})

test('known auth failures use local messages without reflecting provider text', () => {
  const messages = { expired: 'локальне повідомлення' } as Parameters<typeof authErrorMessage>[1]
  assert.equal(
    authErrorMessage({ code: 'AUTH_EXPIRED', message: 'fake-secret' }, messages, 'fallback'),
    messages.expired
  )
  assert.equal(authErrorMessage({ code: '__proto__' }, messages, 'fallback'), 'fallback')
  assert.equal(
    authErrorMessage(new Error('unrelated failure'), messages, 'fallback'),
    'unrelated failure'
  )
})

function fakeClock() {
  let time = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  return {
    now: () => time,
    schedule: (callback: () => void, delay: number) => {
      const timer = { at: time + delay, callback }
      timers.add(timer)
      return () => {
        timers.delete(timer)
      }
    },
    advance: async (milliseconds: number) => {
      time += milliseconds
      for (const timer of [...timers]) {
        if (timer.at <= time) {
          timers.delete(timer)
          timer.callback()
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    timerCount: () => timers.size,
  }
}

test('manual and automatic device checks share ownership and respect slowdown', async () => {
  const clock = fakeClock()
  let calls = 0
  let resolve: ((value: string) => void) | undefined
  const pending: boolean[] = []
  const success: string[] = []
  const polling = startDevicePolling(
    {
      interval: 5,
      expiresAt: 900_000,
      complete: async () => {
        calls++
        if (calls <= 2) throw { code: 'AUTH_SLOW_DOWN' }
        return await new Promise<string>((done) => {
          resolve = done
        })
      },
      pending: (value) => {
        pending.push(value)
      },
      success: (value) => {
        success.push(value)
      },
      failure: () => assert.fail('unexpected terminal error'),
    },
    clock
  )
  await polling.check()
  assert.equal(calls, 0)
  await clock.advance(5000)
  assert.equal(calls, 1)
  await clock.advance(9999)
  await polling.check()
  assert.equal(calls, 1)
  await clock.advance(1)
  assert.equal(calls, 2)
  await clock.advance(14999)
  await polling.check()
  assert.equal(calls, 2)
  await clock.advance(1)
  await polling.check()
  await clock.advance(30_000)
  assert.equal(calls, 3)
  assert.deepEqual(pending, [true, true])
  resolve!('signed-in')
  await clock.advance(0)
  assert.deepEqual(success, ['signed-in'])
  assert.equal(clock.timerCount(), 0)
  polling.dispose()
})

test('device poll cleanup suppresses late completion and further timers', async () => {
  for (const fail of [false, true]) {
    const clock = fakeClock()
    let settle: (() => void) | undefined
    const polling = startDevicePolling(
      {
        interval: 5,
        expiresAt: 900_000,
        complete: () =>
          new Promise<string>((resolve, reject) => {
            settle = () => {
              if (fail) reject({ code: 'AUTH_PENDING' })
              else resolve('late')
            }
          }),
        pending: () => assert.fail('late pending'),
        success: () => assert.fail('late success'),
        failure: () => assert.fail('late failure'),
      },
      clock
    )
    await clock.advance(5000)
    polling.dispose()
    settle!()
    await clock.advance(0)
    assert.equal(clock.timerCount(), 0)
  }
})

test('device expiry stops polling and only protocol pending errors retry', async () => {
  const clock = fakeClock()
  const failures: unknown[] = []
  let calls = 0
  startDevicePolling(
    {
      interval: 5,
      expiresAt: 6000,
      complete: async () => {
        calls++
        throw { code: 'AUTH_PENDING' }
      },
      pending: () => {},
      success: () => assert.fail('unexpected success'),
      failure: (error) => {
        failures.push(error)
      },
    },
    clock
  )
  await clock.advance(5000)
  await clock.advance(1000)
  assert.equal(calls, 1)
  assert.equal(authErrorCode(failures[0]), 'AUTH_DEVICE_EXPIRED')
  assert.equal(clock.timerCount(), 0)

  const terminal = new Error('authorization_pending network expired')
  startDevicePolling(
    {
      interval: 5,
      expiresAt: 60_000,
      complete: async () => {
        throw terminal
      },
      pending: () => assert.fail('must not interpret error prose'),
      success: () => assert.fail('unexpected success'),
      failure: (error) => {
        failures.push(error)
      },
    },
    clock
  )
  await clock.advance(5000)
  assert.equal(failures[1], terminal)
  assert.equal(clock.timerCount(), 0)
})
