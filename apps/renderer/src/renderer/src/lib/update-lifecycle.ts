type Installer = { install: (requestId?: string) => Promise<void> }

type Dependencies = {
  downloadedUpdate: () => Installer | null | Promise<Installer | null>
  acknowledge: (requestId: string) => Promise<void>
  finish: (requestId: string) => Promise<void>
  cancel: (requestId: string) => Promise<void>
  cleanupFailed: (error: unknown) => void
}

// All manual and quit-driven installs share a renderer job. The single native
// install call owns preparation, installation, cleanup and restart, including
// when this renderer or its command response is lost.
export function createUpdateLifecycle(deps: Dependencies) {
  let active: { requestId?: string; promise: Promise<void> } | null = null
  let unreleasedOwner: string | undefined

  async function run(requestId?: string, skipUpdate = false) {
    let owner: string | undefined
    try {
      if (unreleasedOwner !== undefined) {
        await deps.cancel(unreleasedOwner)
        unreleasedOwner = undefined
      }
      if (requestId !== undefined) {
        owner = requestId
        await deps.acknowledge(requestId)
      }
      const update = skipUpdate ? null : await deps.downloadedUpdate()
      if (!update) {
        if (requestId === undefined)
          throw new Error('Download the app update before installing it.')
        await deps.finish(requestId)
        return
      }
      await update.install(requestId)
    } catch (error) {
      // Cleanup is native and ID-checked, including when an acknowledgement's
      // reply was lost. It cannot cancel a native installer, a newer request or
      // an exit already claimed. Manual installation needs no renderer cleanup.
      if (owner !== undefined) {
        unreleasedOwner = owner
        try {
          await deps.cancel(owner)
          unreleasedOwner = undefined
        } catch (cleanupError) {
          deps.cleanupFailed(cleanupError)
        }
      }
      throw error
    }
  }

  function start(requestId?: string, skipUpdate = false): Promise<void> {
    if (active) {
      if (requestId === undefined || active.requestId === requestId) return active.promise
      // A native quit event can arrive while a manual install call is in flight.
      // Let that call settle before acknowledging the event's distinct owner.
      return active.promise.catch(() => {}).then(() => start(requestId, skipUpdate))
    }
    const promise = Promise.resolve()
      .then(() => run(requestId, skipUpdate))
      .finally(() => {
        if (active?.promise === promise) active = null
      })
    active = { requestId, promise }
    return promise
  }

  return {
    get busy() {
      return active !== null
    },
    install: () => start(),
    quit: (requestId: string, skipUpdate = false) => start(requestId, skipUpdate),
    // Only a newer native install-failure snapshot may free this renderer job.
    // This never cancels or releases native ownership.
    observedFailure: () => {
      active = null
    },
  }
}
