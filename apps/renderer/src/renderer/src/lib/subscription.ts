type Unsubscribe = () => void

// Native registrations resolve asynchronously; React cleanup must take effect immediately.
export function ownSubscription<T>(
  register: (emit: (value: T) => void) => Promise<Unsubscribe>,
  callback: (value: T) => void,
  onError: (error: unknown) => void
): Unsubscribe {
  let disposed = false
  let unsubscribe: Unsubscribe | undefined
  const detach = (off: Unsubscribe) => {
    try {
      off()
    } catch (error) {
      onError(error)
    }
  }

  try {
    void register((value) => {
      if (!disposed) callback(value)
    }).then((off) => {
      if (disposed) detach(off)
      else unsubscribe = off
    }, onError)
  } catch (error) {
    onError(error)
  }

  return () => {
    if (disposed) return
    disposed = true
    if (unsubscribe) {
      const off = unsubscribe
      unsubscribe = undefined
      detach(off)
    }
  }
}
