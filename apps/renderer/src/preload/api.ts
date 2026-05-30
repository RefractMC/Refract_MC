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
    yggdrasilLogin:    (serverUrl: string, username: string, password: string) =>
      ipcRenderer.invoke('auth.yggdrasil.login', serverUrl, username, password),
  },
  theme: {
    list:    ()                         => ipcRenderer.invoke('theme.list'),
    install: (sourcePath: string)       => ipcRenderer.invoke('theme.install', sourcePath),
    delete:  (fileName: string)         => ipcRenderer.invoke('theme.delete', fileName),
  },
  updater: {
    onAvailable:  (cb: (v: { version: string }) => void) => {
      const h = (_: IpcRendererEvent, v: { version: string }) => cb(v)
      ipcRenderer.on('updater:available', h)
      return () => ipcRenderer.off('updater:available', h)
    },
    onProgress:   (cb: (v: { percent: number }) => void) => {
      const h = (_: IpcRendererEvent, v: { percent: number }) => cb(v)
      ipcRenderer.on('updater:progress', h)
      return () => ipcRenderer.off('updater:progress', h)
    },
    onDownloaded: (cb: () => void) => {
      const h = () => cb()
      ipcRenderer.on('updater:downloaded', h)
      return () => ipcRenderer.off('updater:downloaded', h)
    },
    install: () => ipcRenderer.send('updater:install'),
  },
  launcher: {
    deleteAll: () => ipcRenderer.invoke('launcher.deleteAll'),
  },
  instance: {
    list:       ()                                              => ipcRenderer.invoke('instance.list'),
    getById:    (id: string)                                   => ipcRenderer.invoke('instance.getById', id),
    create:     (input: unknown)                               => ipcRenderer.invoke('instance.create', input),
    update:     (id: string, patch: unknown)                   => ipcRenderer.invoke('instance.update', id, patch),
    delete:     (id: string)                                   => ipcRenderer.invoke('instance.delete', id),
    openFolder: (id: string)                                   => ipcRenderer.invoke('instance.openFolder', id),
    export:         (id: string): Promise<string | null>       => ipcRenderer.invoke('instance.export', id),
    duplicate:      (id: string)                               => ipcRenderer.invoke('instance.duplicate', id),
    importMultiMc:  (): Promise<import('@refract/core').Instance | null> => ipcRenderer.invoke('instance.importMultiMc'),
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
    checkModUpdates: (instanceId: string) =>
      ipcRenderer.invoke('modrinth.checkModUpdates', instanceId),
    applyModUpdates: (instanceId: string, updates: unknown[]) =>
      ipcRenderer.invoke('modrinth.applyModUpdates', instanceId, updates),
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
    list:           (instanceId: string) => ipcRenderer.invoke('mods.list', instanceId),
    toggle:         (instanceId: string, filename: string, type: string) => ipcRenderer.invoke('mods.toggle', instanceId, filename, type),
    delete:         (instanceId: string, filename: string, type: string) => ipcRenderer.invoke('mods.delete', instanceId, filename, type),
    installLocal:   (instanceId: string, srcPath: string) => ipcRenderer.invoke('mods.installLocal', instanceId, srcPath),
    profilesList:   (instanceId: string) => ipcRenderer.invoke('mods.profiles.list', instanceId),
    profilesSave:   (instanceId: string, name: string, enabledFiles: string[]) => ipcRenderer.invoke('mods.profiles.save', instanceId, name, enabledFiles),
    profilesApply:  (instanceId: string, profileId: string) => ipcRenderer.invoke('mods.profiles.apply', instanceId, profileId),
    profilesDelete: (instanceId: string, profileId: string) => ipcRenderer.invoke('mods.profiles.delete', instanceId, profileId),
    profilesRename: (instanceId: string, profileId: string, newName: string) => ipcRenderer.invoke('mods.profiles.rename', instanceId, profileId, newName),
  },
  friends: {
    list:       ()                           => ipcRenderer.invoke('friends.list'),
    add:        (username: string)           => ipcRenderer.invoke('friends.add', username),
    remove:     (uuid: string)               => ipcRenderer.invoke('friends.remove', uuid),
    updateNote: (uuid: string, note: string) => ipcRenderer.invoke('friends.updateNote', uuid, note),
  },
  curseforge: {
    searchMods:    (query?: string, gameVersion?: string, loader?: string, pageSize?: number, index?: number) =>
      ipcRenderer.invoke('curseforge.searchMods', query, gameVersion, loader, pageSize, index),
    searchModpacks:(query?: string, gameVersion?: string, pageSize?: number, index?: number) =>
      ipcRenderer.invoke('curseforge.searchModpacks', query, gameVersion, pageSize, index),
    files:         (modId: number, gameVersion?: string, loader?: string) =>
      ipcRenderer.invoke('curseforge.files', modId, gameVersion, loader),
    install:       (instanceId: string, modId: number, fileId: number, displayName: string) =>
      ipcRenderer.invoke('curseforge.install', instanceId, modId, fileId, displayName),
  },
  java: {
    managedList:  (): Promise<import('@refract/core').JavaInstallation[]> => ipcRenderer.invoke('java.managedList'),
    requiredFor:  (mcVersion: string): Promise<number> => ipcRenderer.invoke('java.requiredFor', mcVersion),
    download:     (major: number): Promise<import('@refract/core').JavaInstallation> => ipcRenderer.invoke('java.download', major),
    delete:       (major: number): Promise<void> => ipcRenderer.invoke('java.delete', major),
    browseExe:    (): Promise<string | null> => ipcRenderer.invoke('java.browseExe'),
    addCustom:    (javaPath: string): Promise<import('@refract/core').JavaInstallation> => ipcRenderer.invoke('java.addCustom', javaPath),
    removeCustom: (javaPath: string): Promise<void> => ipcRenderer.invoke('java.removeCustom', javaPath),
    onProgress: (cb: (data: { major: number; step: string; percent: number }) => void) => {
      const handler = (_e: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('java:progress', handler)
      return () => ipcRenderer.off('java:progress', handler)
    },
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
    crashReport: (instanceId: string): Promise<string | null> => ipcRenderer.invoke('mc.crashReport', instanceId),
    worlds:    (instanceId: string) => ipcRenderer.invoke('mc.worlds', instanceId),
    deleteWorld: (instanceId: string, worldName: string) => ipcRenderer.invoke('mc.deleteWorld', instanceId, worldName),
    screenshots: (instanceId: string) => ipcRenderer.invoke('mc.screenshots', instanceId),
    openScreenshot: (instanceId: string, filename: string) => ipcRenderer.invoke('mc.openScreenshot', instanceId, filename),
    servers:    (instanceId: string) => ipcRenderer.invoke('mc.servers', instanceId),
    pingServer: (ip: string): Promise<{ online: number; max: number; latencyMs: number } | null> => ipcRenderer.invoke('mc.pingServer', ip),
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
