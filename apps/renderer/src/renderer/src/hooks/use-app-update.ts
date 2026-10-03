import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { emptyUpdateStatus } from '@/lib/update-status'

export function useAppUpdate() {
  const [status, setStatus] = useState(emptyUpdateStatus)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const alive = useRef(false)
  const attempt = useRef(0)
  const startingRevision = useRef(0)
  const latestRevision = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const current = await api.updater.status()
      if (alive.current) {
        latestRevision.current = Math.max(latestRevision.current, current.revision)
        setStatus((previous) => (current.revision >= previous.revision ? current : previous))
        setConnected(true)
      }
    } catch {
      if (alive.current) setConnected(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (!__APP_UPDATER_ENABLED__)
      return () => {
        alive.current = false
      }
    const unsubscribe = api.updater.onChanged((current) => {
      if (!alive.current) return
      latestRevision.current = Math.max(latestRevision.current, current.revision)
      setStatus((previous) => (current.revision >= previous.revision ? current : previous))
      setConnected(true)
      setActionError(undefined)
    })
    void refresh()
    // Events give immediate progress; polling recovers missed events and lets
    // native elapsed time surface a slow installer without timing it out.
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      alive.current = false
      attempt.current += 1
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [refresh])

  async function run(action: () => Promise<unknown>) {
    const ownedAttempt = ++attempt.current
    startingRevision.current = status.revision
    setBusy(true)
    setActionError(undefined)
    try {
      await action()
    } catch (error) {
      if (
        alive.current &&
        attempt.current === ownedAttempt &&
        latestRevision.current <= startingRevision.current
      )
        setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      await refresh()
      if (alive.current && attempt.current === ownedAttempt) setBusy(false)
    }
  }

  // Once native status advances, its phase controls the buttons even if the
  // command response was lost. A terminal failure can therefore be retried.
  return {
    status,
    connected,
    busy: busy && status.revision <= startingRevision.current,
    actionError,
    refresh,
    run,
  }
}
