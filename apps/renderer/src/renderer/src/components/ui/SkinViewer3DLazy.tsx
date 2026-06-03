import { lazy, Suspense } from 'react'

// Three.js (~1 MB) only loads when this component is first rendered.
// Import this instead of SkinViewer3D everywhere to keep startup RAM low.
const SkinViewer3D = lazy(() => import('./SkinViewer3D'))

interface Props {
  skinUrl: string | null
  width?: number
  height?: number
  walk?: boolean
  rotate?: boolean
}

export function SkinViewer3DLazy(props: Props) {
  return (
    <Suspense fallback={
      <div style={{
        width: props.width ?? 180,
        height: props.height ?? 280,
        background: 'var(--surface-2)',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ink-4)',
        fontSize: 11,
      }}>
        Loading…
      </div>
    }>
      <SkinViewer3D {...props} />
    </Suspense>
  )
}
