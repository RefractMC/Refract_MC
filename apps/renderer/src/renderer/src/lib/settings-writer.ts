/** Preserve user intent order across native writes; a failed write never poisons the queue. */
export function createSettingsWriter<T>(write: (key: string, value: unknown) => Promise<T>) {
  let tail: Promise<unknown> = Promise.resolve()
  return (key: string, value: unknown): Promise<T> => {
    const result = tail.then(() => write(key, value))
    tail = result.catch(() => {})
    return result
  }
}
