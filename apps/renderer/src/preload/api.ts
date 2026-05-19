import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export const api = {
  config: {
    get: () => ipcRenderer.invoke('config.get'),
    set: <K extends string>(key: K, value: unknown) => ipcRenderer.invoke('config.set', key, value),
  },
  auth: {
    accounts:          ()                         => ipcRenderer.invoke('auth.accounts'),
    active:            ()                         => ipcRenderer.invoke('auth.active'),
    microsoftBegin:    ()                         => ipcRenderer.invoke('auth.microsoft.begin'),
    microsoftComplete: (deviceCode: string)       => ipcRenderer.invoke('auth.microsoft.complete', deviceCode),
    createOffline:     (username: string)         => ipcRenderer.invoke('auth.offline.create', username),
    setActive:         (uuid: string)             => ipcRenderer.invoke('auth.setActive', uuid),
    logout:            (uuid: string)             => ipcRenderer.invoke('auth.logout', uuid),
  },
  theme: {
    list:    ()                         => ipcRenderer.invoke('theme.list'),
    install: (sourcePath: string)       => ipcRenderer.invoke('theme.install', sourcePath),
    delete:  (fileName: string)         => ipcRenderer.invoke('theme.delete', fileName),
  },
  instance: {
    list:      ()                                              => ipcRenderer.invoke('instance.list'),
    getById:   (id: string)                                   => ipcRenderer.invoke('instance.getById', id),
    create:    (input: unknown)                               => ipcRenderer.invoke('instance.create', input),
    update:    (id: string, patch: unknown)                   => ipcRenderer.invoke('instance.update', id, patch),
    delete:    (id: string, deleteFiles: boolean)             => ipcRenderer.invoke('instance.delete', id, deleteFiles),
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    maximize: (): void => ipcRenderer.send('window:maximize'),
    close: (): void => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, value: boolean): void => callback(value)
      ipcRenderer.on('window:maximized-change', handler)
      return () => ipcRenderer.off('window:maximized-change', handler)
    },
  },
} as const

export type RefractAPI = typeof api
