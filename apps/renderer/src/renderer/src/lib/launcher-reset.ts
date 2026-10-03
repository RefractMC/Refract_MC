type ResetStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>

export function clearLauncherStorage(storage: ResetStorage): void {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && (key.startsWith('refract.') || key.startsWith('refract-'))) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

// Called only after native success. A storage failure leaves the review open;
// retrying completion must not run native deletion for a second time.
export async function finishLauncherReset(deps: {
  cancelQueries: () => Promise<unknown>
  clearQueries: () => void
  local: ResetStorage
  session: ResetStorage
  reload: () => void
}): Promise<void> {
  await deps.cancelQueries()
  clearLauncherStorage(deps.local)
  clearLauncherStorage(deps.session)
  deps.clearQueries()
  deps.reload()
}
