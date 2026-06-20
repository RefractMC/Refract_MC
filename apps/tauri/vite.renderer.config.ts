import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

// Serves the shared Refract renderer (apps/renderer/src/renderer) inside the
// Tauri shell with the same aliases used by the app build.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const rendererRoot = here('../renderer/src/renderer')
const appVersion: string = JSON.parse(readFileSync(here('../renderer/package.json'), 'utf8')).version

export default defineConfig({
  root: rendererRoot,
  plugins: [tailwindcss(), react(), TanStackRouterVite()],
  resolve: {
    alias: {
      '@': resolve(rendererRoot, 'src'),
      '@locales': here('../../locales'),
      '@refract/core/java-manager': here('../../packages/core/src/java-manager/index.ts'),
      '@refract/core/launcher': here('../../packages/core/src/launcher/index.ts'),
      '@refract/core': here('../../packages/core/src/index.ts'),
      '@refract/plugin-api': here('../../packages/plugin-api/src/index.ts'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  clearScreen: false,
  server: {
    port: 5180,
    strictPort: true,
    // Allow importing source from elsewhere in the monorepo (renderer, core, locales).
    fs: { allow: [here('../../')] },
  },
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
  },
})
