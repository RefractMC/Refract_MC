import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export const api = {
  config: {
    get: () => ipcRenderer.invoke('config.get'),
    set: <K extends string>(key: K, value: unknown) => ipcRenderer.invoke('config.set', key, value),
  },
  log: {
    write: (entry: { level: 'info' | 'warn' | 'error'; source: string; message: string; stack?: string }) =>
      ipcRenderer.send('log.write', entry),
    read:  (limit?: number) => ipcRenderer.invoke('logs.read', limit),
    clear: () => ipcRenderer.invoke('logs.clear'),
  },
  auth: {
    accounts:          ()                         => ipcRenderer.invoke('auth.accounts'),
    active:            ()                         => ipcRenderer.invoke('auth.active'),
    microsoftBegin:    ()                         => ipcRenderer.invoke('auth.microsoft.begin'),
    microsoftComplete: (deviceCode: string)       => ipcRenderer.invoke('auth.microsoft.complete', deviceCode),
    createOffline:     (username: string)         => ipcRenderer.invoke('auth.offline.create', username),
    renameOffline:     (uuid: string, username: string) => ipcRenderer.invoke('auth.offline.rename', uuid, username),
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
  activity: {
    list: (): Promise<Array<{ id: string; label: string; ts: number }>> => ipcRenderer.invoke('activity.list'),
    add:  (label: string): Promise<{ id: string; label: string; ts: number }> => ipcRenderer.invoke('activity.add', label),
  },
  modrinth: {
    search:    (query: string, gameVersion?: string, loader?: string, category?: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('modrinth.search', query, gameVersion, loader, category, limit, offset),
    searchContent: (opts: import('@refract/core').ModrinthSearchOptions) =>
      ipcRenderer.invoke('modrinth.searchContent', opts),
    versions:  (projectId: string, gameVersion?: string, loader?: string) =>
      ipcRenderer.invoke('modrinth.versions', projectId, gameVersion, loader),
    install:   (instanceId: string, projectId: string, projectName: string, versionId?: string) =>
      ipcRenderer.invoke('modrinth.install', instanceId, projectId, projectName, versionId),
    uninstall: (instanceId: string, projectId: string) =>
      ipcRenderer.invoke('modrinth.uninstall', instanceId, projectId),
    gameVersions: (): Promise<import('@refract/core').ModrinthGameVersion[]> =>
      ipcRenderer.invoke('modrinth.gameVersions'),
    contentInstall: (instanceId: string, projectId: string, projectName: string, contentType: string, versionId?: string) =>
      ipcRenderer.invoke('modpack.content.install', instanceId, projectId, projectName, contentType, versionId),
  },
  modpack: {
    install: (name: string, projectId: string, versionId?: string): Promise<import('@refract/core').Instance> =>
      ipcRenderer.invoke('modpack.install', name, projectId, versionId),
    openFileDialog: (): Promise<string | null> =>
      ipcRenderer.invoke('modpack.openFileDialog'),
    installFromFile: (filePath: string, name?: string, importId?: string): Promise<import('@refract/core').Instance> =>
      ipcRenderer.invoke('modpack.installFromFile', filePath, name, importId),
    onProgress: (cb: (data: { projectId: string; step: string; percent: number }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('modpack:progress', handler)
      return () => ipcRenderer.off('modpack:progress', handler)
    },
    onDone: (cb: (data: { projectId: string; instanceId?: string; error?: string }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('modpack:done', handler)
      return () => ipcRenderer.off('modpack:done', handler)
    },
  },
  mods: {
    list:   (instanceId: string) => ipcRenderer.invoke('mods.list', instanceId),
    toggle: (instanceId: string, filename: string) => ipcRenderer.invoke('mods.toggle', instanceId, filename),
    delete: (instanceId: string, filename: string) => ipcRenderer.invoke('mods.delete', instanceId, filename),
  },
  mc: {
    versions:  (): Promise<import('@refract/core').MinecraftVersion[]> => ipcRenderer.invoke('mc.versions'),
    java:      () => ipcRenderer.invoke('mc.java'),
    isRunning: (instanceId: string): Promise<boolean> => ipcRenderer.invoke('mc.isRunning', instanceId),
    install:   (instanceId: string, versionId: string, versionUrl: string, modLoader?: string, modLoaderVersion?: string) =>
      ipcRenderer.invoke('mc.install', instanceId, versionId, versionUrl, modLoader, modLoaderVersion),
    repair:    (instanceId: string) => ipcRenderer.invoke('mc.repair', instanceId),
    launch:    (instanceId: string) => ipcRenderer.invoke('mc.launch', instanceId),
    stop:      (instanceId: string) => ipcRenderer.invoke('mc.stop', instanceId),
    onProgress: (cb: (data: { instanceId: string; step: string; current: number; total: number; percent: number }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('mc:progress', handler)
      return () => ipcRenderer.off('mc:progress', handler)
    },
    onLog: (cb: (data: { instanceId: string; line: string; stream: string }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('mc:log', handler)
      return () => ipcRenderer.off('mc:log', handler)
    },
    onExit: (cb: (data: { instanceId: string; code: number | null; error?: string }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('mc:exit', handler)
      return () => ipcRenderer.off('mc:exit', handler)
    },
  },
} as const

export type RefractAPI = typeof api
