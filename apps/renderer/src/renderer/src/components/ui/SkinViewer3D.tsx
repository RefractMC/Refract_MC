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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

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
      // context loss to release the GPU resources immediately.
      try { viewer.renderer.forceContextLoss() } catch { /* ignore */ }
      viewer.dispose()
      viewerRef.current = null
    }
  }, [width, height, walk, rotate])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !skinUrl) return
    viewer.loadSkin(skinUrl).catch(() => {})
  }, [skinUrl])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', borderRadius: 6 }}
    />
  )
}

export default SkinViewer3D
