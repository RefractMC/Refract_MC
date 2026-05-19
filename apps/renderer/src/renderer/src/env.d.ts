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
          }>
        }>
        set: (key: string, value: unknown) => Promise<void>
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
    }
  }
}
