type UpdateMetadata = { rid: number; currentVersion: string; version: string }

// Only the resource identity and display versions cross this boundary. Installer
// URLs, signatures and request configuration remain in the native update resource.
export function parseUpdateMetadata(value: unknown): UpdateMetadata | null {
  if (value === null) return null
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid native update response.')
  const metadata = value as Record<string, unknown>
  if (
    typeof metadata.rid !== 'number' ||
    !Number.isInteger(metadata.rid) ||
    metadata.rid < 0 ||
    metadata.rid > 0xffffffff ||
    typeof metadata.currentVersion !== 'string' ||
    !metadata.currentVersion ||
    typeof metadata.version !== 'string' ||
    !metadata.version
  ) {
    throw new Error('Invalid native update response.')
  }
  return {
    rid: metadata.rid,
    currentVersion: metadata.currentVersion,
    version: metadata.version,
  }
}
