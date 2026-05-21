/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Instance, CreateInstanceInput } from '@refract/core'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      config: {
        get: () => Promise<{
          activeAccountId: string | null
          activeThemeId: string
          windowBounds: { width: number; height: number; x?: number; y?: number }
          accounts: Array<{
            uuid: string
            username: string
            type: 'microsoft' | 'offline' | 'yggdrasil'
            expiresAt?: number
            yggdrasilServer?: string
            canManageContent: boolean
            canPlayMinecraft: boolean
            licenseStatus: 'verified' | 'guest'
          }>
        }>
        set: (key: string, value: unknown) => Promise<void>
      }
      log: {
        write: (entry: {
          level: 'info' | 'warn' | 'error'
          source: string
          message: string
          stack?: string
        }) => void
        read:  (limit?: number) => Promise<Array<{ time: string; level: 'info' | 'warn' | 'error'; source: string; message: string; stack?: string }>>
        clear: () => Promise<void>
      }
      auth: {
        accounts: () => Promise<Array<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>>
        active: () => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        } | null>
        microsoftBegin: () => Promise<{
          deviceCode: string
          userCode: string
          verificationUri: string
          expiresIn: number
          interval: number
          message: string
        }>
        microsoftComplete: (deviceCode: string) => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>
        createOffline: (username: string) => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>
        renameOffline: (uuid: string, username: string) => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>
        setActive: (uuid: string) => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>
        logout: (uuid: string) => Promise<void>
      }
      theme: {
        list:    () => Promise<import('@/lib/theme-types').ThemeDefinition[]>
        install: (sourcePath: string) => Promise<import('@/lib/theme-types').ThemeDefinition>
        delete:  (fileName: string) => Promise<void>
      }
      instance: {
        list:    () => Promise<Instance[]>
        getById: (id: string) => Promise<Instance | null>
        create:  (input: CreateInstanceInput) => Promise<Instance>
        update:  (id: string, patch: Partial<Instance>) => Promise<Instance>
        delete:  (id: string, deleteFiles: boolean) => Promise<void>
      }
      window: {
        minimize: () => void
        maximize: () => void
        close: () => void
        isMaximized: () => Promise<boolean>
        onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
      }
      activity: {
        list: () => Promise<Array<{ id: string; label: string; ts: number }>>
        add: (label: string) => Promise<{ id: string; label: string; ts: number }>
      }
      modrinth: {
        search: (query: string, gameVersion?: string, loader?: string, category?: string, limit?: number, offset?: number) => Promise<import('@refract/core').ModrinthSearchResult>
        searchContent: (opts: import('@refract/core').ModrinthSearchOptions) => Promise<import('@refract/core').ModrinthSearchResult>
        versions: (projectId: string, gameVersion?: string, loader?: string) => Promise<import('@refract/core').ModrinthVersion[]>
        install: (instanceId: string, projectId: string, projectName: string, versionId?: string) => Promise<import('@refract/core').InstalledMod>
        uninstall: (instanceId: string, projectId: string) => Promise<void>
        gameVersions: () => Promise<import('@refract/core').ModrinthGameVersion[]>
        contentInstall: (instanceId: string, projectId: string, projectName: string, contentType: string, versionId?: string) => Promise<void>
      }
      modpack: {
        install: (name: string, projectId: string, versionId?: string) => Promise<import('@refract/core').Instance>
        openFileDialog: () => Promise<string | null>
        installFromFile: (filePath: string, name?: string, importId?: string) => Promise<import('@refract/core').Instance>
        onProgress: (cb: (data: { projectId: string; step: string; percent: number }) => void) => () => void
        onDone: (cb: (data: { projectId: string; instanceId?: string; error?: string }) => void) => () => void
      }
      mods: {
        list:   (instanceId: string) => Promise<Array<{ filename: string; displayName: string; enabled: boolean; sizeKb: number }>>
        toggle: (instanceId: string, filename: string) => Promise<void>
        delete: (instanceId: string, filename: string) => Promise<void>
      }
      mc: {
        versions: () => Promise<import('@refract/core').MinecraftVersion[]>
        java: () => Promise<import('@refract/core').JavaInstallation[]>
        isRunning: (instanceId: string) => Promise<boolean>
        install: (instanceId: string, versionId: string, versionUrl: string, modLoader?: string, modLoaderVersion?: string) => Promise<void>
        launch: (instanceId: string) => Promise<void>
        stop: (instanceId: string) => Promise<void>
        onProgress: (cb: (data: { instanceId: string; step: string; current: number; total: number; percent: number }) => void) => () => void
        onLog: (cb: (data: { instanceId: string; line: string; stream: string }) => void) => () => void
        onExit: (cb: (data: { instanceId: string; code: number | null; error?: string }) => void) => () => void
      }
    }
  }
}
