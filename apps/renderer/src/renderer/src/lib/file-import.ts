export type FileImportResult = { status: 'installed'; id: string } | { status: 'needsVersion' }

export class FileImportResultError extends Error {
  constructor() {
    super('Invalid import result.')
    this.name = 'FileImportResultError'
  }
}

export type FileImportState = {
  importId: string
  step: string
  percent: number
  name: string
  filePath: string
  status: 'importing' | 'needsVersion' | 'done' | 'error'
  minecraftVersion?: string
  instanceId?: string
  error?: string
}

export function parseFileImportResult(value: unknown): FileImportResult {
  if (typeof value !== 'object' || value === null) throw new FileImportResultError()
  const result = value as Record<string, unknown>
  if (result.status === 'needsVersion' && result.id === undefined) {
    return { status: 'needsVersion' }
  }
  if (
    result.status === 'installed' &&
    typeof result.id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(result.id)
  ) {
    return { status: 'installed', id: result.id }
  }
  throw new FileImportResultError()
}

export function applyFileImportResult(
  state: FileImportState | null,
  importId: string,
  result: FileImportResult,
  versionStep: string,
  doneStep: string
): FileImportState | null {
  if (state?.importId !== importId || state.status !== 'importing') return state
  return result.status === 'needsVersion'
    ? { ...state, status: 'needsVersion', step: versionStep, minecraftVersion: undefined }
    : { ...state, status: 'done', step: doneStep, percent: 100, instanceId: result.id }
}
