import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { api } from './api'

function reportPreloadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  api.log.write({ level: 'error', source: 'preload', message, stack })
  console.error(error)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    reportPreloadError(error)
  }
} else {
  try {
    window.electron = electronAPI
    window.api = api
  } catch (error) {
    reportPreloadError(error)
  }
}
