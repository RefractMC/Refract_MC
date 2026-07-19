import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter, createHashHistory } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import { useThemeStore } from './stores/theme'
import { useLanguageStore } from './stores/language'
import { installRendererErrorLogging } from './lib/logger'
import { api } from './lib/api'
import './styles/globals.css'

installRendererErrorLogging()
useThemeStore.getState().initialize()
useLanguageStore.getState().initialize()

// Cache query results across navigations so switching pages serves instantly
// from cache instead of refetching every mount (the default staleTime is 0).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const router = createRouter({ routeTree, history: createHashHistory() })

// Anonymous page-view analytics: route path only, with any dynamic id-like
// segment masked so no instance/account identifiers ever leave the app.
router.subscribe('onResolved', (e) => {
  try {
    const path = (e?.toLocation?.pathname || '/').replace(/\/[0-9a-fA-F-]{8,}/g, '/:id')
    api.analytics.track('page_view', { page_path: path })
  } catch { /* analytics must never break navigation */ }
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function hideStartupLoader(): void {
  const loader = document.getElementById('startup-loader')
  if (!loader) return
  const remove = () => loader.remove()
  loader.setAttribute('data-state', 'done')
  window.setTimeout(remove, 280)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
)

requestAnimationFrame(() => {
  requestAnimationFrame(hideStartupLoader)
})
