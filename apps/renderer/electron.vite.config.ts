import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

const appVersion: string = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

const workspaceAlias = {
  '@refract/core/java-manager': resolve('../../packages/core/src/java-manager/index.ts'),
  '@refract/core/launcher':     resolve('../../packages/core/src/launcher/index.ts'),
  '@refract/core':              resolve('../../packages/core/src/index.ts'),
  '@refract/plugin-api':        resolve('../../packages/plugin-api/src/index.ts'),
}

const workspaceExclude = ['@refract/core', '@refract/core/java-manager', '@refract/core/launcher', '@refract/plugin-api', 'electron-updater', '@xhayper/discord-rpc']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceExclude })],
    resolve: { alias: workspaceAlias },
    build: {
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    // Bundle @electron-toolkit/preload into the preload instead of leaving it
    // an external runtime require: with sandbox enabled, a preload's require()
    // is restricted to "electron" + core modules, so a third-party require
    // throws and the whole preload (and thus window.api) fails to load.
    plugins: [externalizeDepsPlugin({ exclude: [...workspaceExclude, '@electron-toolkit/preload'] })],
    resolve: { alias: workspaceAlias },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@locales': resolve('../../locales'),
        ...workspaceAlias,
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [tailwindcss(), react(), TanStackRouterVite()],
  },
})
