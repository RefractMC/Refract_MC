import { handleIpc } from './handle'
import { readActivity, appendActivity } from '../services/activity'

export function registerActivityIpc(): void {
  handleIpc('activity.list', () => readActivity())
  handleIpc('activity.add', (_event, label) => appendActivity(String(label)))
}
