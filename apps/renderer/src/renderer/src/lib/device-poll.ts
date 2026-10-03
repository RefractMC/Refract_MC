import { authErrorCode } from './auth-errors.js'

type Clock = {
  now: () => number
  schedule: (callback: () => void, delay: number) => () => void
}

/** One poll owner for both automatic and manual checks, including provider backoff. */
export function startDevicePolling<T>(
  options: {
    interval: number
    expiresAt: number
    complete: () => Promise<T>
    success: (result: T) => void
    pending: (slowDown: boolean) => void
    failure: (error: unknown) => void
  },
  clock: Clock = {
    now: Date.now,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  }
) {
  let stopped = false
  let inFlight = false
  let interval = Math.max(5, options.interval) * 1000
  let nextCheck = clock.now() + interval
  let clearTimer = () => {}

  function schedule() {
    clearTimer()
    if (!stopped)
      clearTimer = clock.schedule(
        () => {
          void check()
        },
        Math.max(0, Math.min(nextCheck, options.expiresAt) - clock.now())
      )
  }

  async function check() {
    if (stopped || inFlight) return
    if (clock.now() >= options.expiresAt) {
      stopped = true
      clearTimer()
      options.failure({ code: 'AUTH_DEVICE_EXPIRED' })
      return
    }
    if (clock.now() < nextCheck) return
    clearTimer()
    inFlight = true
    try {
      const result = await options.complete()
      if (stopped) return
      stopped = true
      options.success(result)
    } catch (error) {
      if (stopped) return
      const code = authErrorCode(error)
      if (code === 'AUTH_PENDING' || code === 'AUTH_SLOW_DOWN') {
        if (code === 'AUTH_SLOW_DOWN') interval += 5000
        nextCheck = clock.now() + interval
        options.pending(code === 'AUTH_SLOW_DOWN')
      } else {
        stopped = true
        options.failure(error)
      }
    } finally {
      inFlight = false
      schedule()
    }
  }

  schedule()
  return {
    check,
    dispose: () => {
      stopped = true
      clearTimer()
    },
  }
}
