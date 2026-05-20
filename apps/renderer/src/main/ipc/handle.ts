import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { logError } from '../services/logger'

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export function handleIpc(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logError(`ipc:${channel}`, error)
      throw error
    }
  })
}
