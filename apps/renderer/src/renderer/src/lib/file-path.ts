/**
 * Resolve the absolute filesystem path of a File obtained from a drag-drop or
 * an `<input type="file">`.
 *
 * Tauri native drop handling resolves paths separately. This helper only keeps
 * the browser preview fallback for environments that expose a non-standard
 * `File.path` property.
 */
export function getFilePath(file: File): string | null {
  return (file as File & { path?: string }).path ?? null
}
