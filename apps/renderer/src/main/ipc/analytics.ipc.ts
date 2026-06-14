import { ipcMain } from 'electron'
import { trackEvent } from '../services/analytics'

// A short allow-list of event names the renderer may emit, so a compromised or
// buggy renderer can't flood arbitrary events. Main-process events (app_open,
// instance_launch, install, app_error) are sent directly, not through here.
const RENDERER_EVENTS = new Set(['page_view'])

export function registerAnalyticsIpc(): void {
  ipcMain.on('analytics.track', (_event, name: unknown, params: unknown) => {
    if (typeof name !== 'string' || !RENDERER_EVENTS.has(name)) return
    const safe: Record<string, string | number> = {}
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') safe[k] = v
      }
    }
    trackEvent(name, safe)
  })
}
