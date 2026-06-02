/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Instance, CreateInstanceInput } from '@refract/core'

declare global {
  const __APP_VERSION__: string
  interface Window {
    electron: ElectronAPI
    api: {
      skins: {
        list:    () => Promise<Array<{ id: string; name: string; filename: string; variant: 'classic' | 'slim'; addedAt: string }>>
        browse:  () => Promise<string | null>
        add:     (name: string, sourcePath: string, variant: string) => Promise<{ id: string; name: string; filename: string; variant: 'classic' | 'slim'; addedAt: string }>
        delete:  (id: string) => Promise<void>
        getPath: (filename: string) => Promise<string>
        apply:   (skinId: string, accountUuid: string) => Promise<void>
      }
      system: {
        ramGb: () => Promise<number>
      }
      config: {
        get: () => Promise<{
          activeAccountId: string | null
          activeThemeId: string
          windowBounds: { width: number; height: number; x?: number; y?: number }
          defaultMemoryMb: number
          onboardingDone: boolean
          systemRamGb?: number
          curseforgeApiKey?: string
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
        fetchSkinTextureUrl: (uuid: string) => Promise<string | null>
        browseSkin: () => Promise<string | null>
        uploadSkin: (uuid: string, imagePath: string, variant: 'classic' | 'slim') => Promise<void>
        yggdrasilLogin: (serverUrl: string, username: string, password: string) => Promise<{
          uuid: string
          username: string
          type: 'microsoft' | 'offline' | 'yggdrasil'
          expiresAt?: number
          yggdrasilServer?: string
          canManageContent: boolean
          canPlayMinecraft: boolean
          licenseStatus: 'verified' | 'guest'
        }>
      }
      theme: {
        list:    () => Promise<import('@/lib/theme-types').ThemeDefinition[]>
        install: (sourcePath: string) => Promise<import('@/lib/theme-types').ThemeDefinition>
        delete:  (fileName: string) => Promise<void>
      }
      updater: {
        onAvailable:  (cb: (v: { version: string }) => void) => () => void
        onProgress:   (cb: (v: { percent: number }) => void) => () => void
        onDownloaded: (cb: () => void) => () => void
        install:  () => void
        download: () => void
      }
      launcher: {
        deleteAll: () => Promise<void>
      }
      instance: {
        list:       () => Promise<Instance[]>
        getById:    (id: string) => Promise<Instance | null>
        create:     (input: CreateInstanceInput) => Promise<Instance>
        update:     (id: string, patch: Partial<Instance>) => Promise<Instance>
        delete:     (id: string) => Promise<void>
        openFolder:   (id: string) => Promise<void>
        browseFolder: () => Promise<string | null>
        export:       (id: string) => Promise<string | null>
        duplicate:      (id: string) => Promise<import('@refract/core').Instance | null>
        importMultiMc:  () => Promise<import('@refract/core').Instance | null>
      }
      system: {
        totalMemoryMb: () => Promise<number>
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
        checkModUpdates: (instanceId: string) => Promise<Array<{ filename: string; projectId: string; latestVersionId: string; latestVersionName: string; latestFilename: string; downloadUrl: string; hasUpdate: boolean }>>
        applyModUpdates: (instanceId: string, updates: Array<{ filename: string; downloadUrl: string; newFilename: string }>) => Promise<Array<{ filename: string; success: boolean; error?: string }>>
      }
      modpack: {
        install: (name: string, projectId: string, versionId?: string) => Promise<import('@refract/core').Instance>
        openFileDialog: () => Promise<string | null>
        installFromFile: (filePath: string, name?: string, importId?: string) => Promise<import('@refract/core').Instance>
        onProgress: (cb: (data: { projectId: string; step: string; percent: number }) => void) => () => void
        onDone: (cb: (data: { projectId: string; instanceId?: string; error?: string }) => void) => () => void
      }
      mods: {
        list:           (instanceId: string) => Promise<Array<{ filename: string; displayName: string; type: 'mod' | 'resourcepack' | 'shader' | 'datapack'; enabled: boolean; sizeKb: number; iconDataUrl?: string }>>
        toggle:         (instanceId: string, filename: string, type: string) => Promise<void>
        delete:         (instanceId: string, filename: string, type: string) => Promise<void>
        installLocal:   (instanceId: string, srcPath: string) => Promise<string>
        profilesList:   (instanceId: string) => Promise<Array<{ id: string; name: string; enabledFiles: string[] }>>
        profilesSave:   (instanceId: string, name: string, enabledFiles: string[]) => Promise<{ id: string; name: string; enabledFiles: string[] }>
        profilesApply:  (instanceId: string, profileId: string) => Promise<void>
        profilesDelete: (instanceId: string, profileId: string) => Promise<void>
        profilesRename: (instanceId: string, profileId: string, newName: string) => Promise<{ id: string; name: string; enabledFiles: string[] }>
      }
      java: {
        managedList:  () => Promise<import('@refract/core').JavaInstallation[]>
        requiredFor:  (mcVersion: string) => Promise<number>
        download:     (major: number) => Promise<import('@refract/core').JavaInstallation>
        delete:       (major: number) => Promise<void>
        browseExe:    () => Promise<string | null>
        addCustom:    (javaPath: string) => Promise<import('@refract/core').JavaInstallation>
        removeCustom: (javaPath: string) => Promise<void>
        onProgress:   (cb: (data: { major: number; step: string; percent: number }) => void) => () => void
      }
      friends: {
        list:       () => Promise<Array<{ uuid: string; username: string; addedAt: number; note?: string }>>
        add:        (username: string) => Promise<{ uuid: string; username: string; addedAt: number; note?: string }>
        remove:     (uuid: string) => Promise<void>
        updateNote: (uuid: string, note: string) => Promise<void>
      }
      mc: {
        versions: () => Promise<import('@refract/core').MinecraftVersion[]>
        java: () => Promise<import('@refract/core').JavaInstallation[]>
        isRunning: (instanceId: string) => Promise<boolean>
        install: (instanceId: string, versionId: string, versionUrl: string, modLoader?: string, modLoaderVersion?: string) => Promise<void>
        repair: (instanceId: string) => Promise<void>
        launch: (instanceId: string) => Promise<void>
        stop: (instanceId: string) => Promise<void>
        crashReport: (instanceId: string) => Promise<string | null>
        worlds: (instanceId: string) => Promise<Array<{ name: string; lastModified: number; sizeKb: number }>>
        deleteWorld: (instanceId: string, worldName: string) => Promise<void>
        screenshots: (instanceId: string) => Promise<Array<{ filename: string; sizeKb: number; timestamp: number; dataUrl: string | null }>>
        openScreenshot:  (instanceId: string, filename: string) => Promise<void>
        screenshotFull:  (instanceId: string, filename: string) => Promise<string | null>
        servers:     (instanceId: string) => Promise<Array<{ name: string; ip: string; icon?: string }>>
        pingServer:  (ip: string) => Promise<{ online: number; max: number; latencyMs: number } | null>
        backupWorld: (instanceId: string, worldName: string) => Promise<string | null>
        onProgress: (cb: (data: { instanceId: string; step: string; current: number; total: number; percent: number }) => void) => () => void
        onLog: (cb: (data: { instanceId: string; line: string; stream: string }) => void) => () => void
        onExit: (cb: (data: { instanceId: string; code: number | null; error?: string }) => void) => () => void
      }
      curseforge: {
        searchMods:     (query?: string, gameVersion?: string, loader?: string, pageSize?: number, index?: number) => Promise<import('@refract/core').CFSearchResult>
        searchModpacks: (query?: string, gameVersion?: string, pageSize?: number, index?: number) => Promise<import('@refract/core').CFSearchResult>
        files:          (modId: number, gameVersion?: string, loader?: string) => Promise<import('@refract/core').CFFile[]>
        install:        (instanceId: string, modId: number, fileId: number, displayName: string) => Promise<void>
        installModpack: (name: string, modId: number, fileId: number) => Promise<import('@refract/core').Instance>
      }
    }
  }
}
