import { useEffect, useRef } from 'react'
import { SkinViewer, WalkingAnimation, IdleAnimation } from 'skinview3d'

interface Props {
  skinUrl: string | null
  width?: number
  height?: number
  walk?: boolean
  rotate?: boolean
}

// Named export kept for lazy() wrapper; add default export so React.lazy works
export function SkinViewer3D({ skinUrl, width = 180, height = 280, walk = true, rotate = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Create the canvas imperatively so every mount gets a fresh one. The
    // cleanup force-loses the WebGL context (see below), which permanently
    // disables that canvas — reusing a single JSX <canvas> across remounts
    // would hand the next viewer a dead context (null gl → "reading precision").
    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.borderRadius = 'var(--radius-sm)'
    container.appendChild(canvas)

    const viewer = new SkinViewer({ canvas, width, height })
    viewer.fov = 70
    viewer.zoom = 0.9
    viewer.autoRotate = rotate
    viewer.autoRotateSpeed = 0.6
    viewer.animation = walk ? new WalkingAnimation() : new IdleAnimation()
    viewerRef.current = viewer

    return () => {
      // three.js keeps the WebGL context alive after dispose(), so repeated
      // mounts (opening skin/cape previews) leak contexts until the browser
      // hits its ~16-context limit and the whole webview stalls. Force the
      // context loss to release the GPU resources immediately, then drop the
      // now-unusable canvas.
      try { viewer.renderer.forceContextLoss() } catch { /* ignore */ }
      viewer.dispose()
      viewerRef.current = null
      canvas.remove()
    }
  }, [width, height, walk, rotate])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !skinUrl) return
    viewer.loadSkin(skinUrl).catch(() => {})
  }, [skinUrl])

  return <div ref={containerRef} style={{ display: 'block', lineHeight: 0 }} />
}

export default SkinViewer3D
