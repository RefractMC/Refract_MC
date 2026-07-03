import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

type Rect = [number, number, number, number, string]

const BODY = '#2b2b33'
const DARK = '#1e1e26'
const EYE = '#ffd93d'
const NOSE = '#e08bb6'
const EAR = '#8a52ff'

// A 16×16 pixel cat, sitting. Drawn as SVG rects so it scales crisply.
const CAT: Rect[] = [
  // ears (outer + inner)
  [3, 1, 2, 2, BODY], [9, 1, 2, 2, BODY],
  [3, 2, 1, 1, EAR], [10, 2, 1, 1, EAR],
  // head
  [2, 3, 10, 6, BODY],
  // eyes + nose
  [4, 5, 2, 2, EYE], [8, 5, 2, 2, EYE],
  [6, 7, 2, 1, NOSE],
  // body + front paws
  [3, 9, 8, 6, BODY],
  [3, 14, 8, 1, DARK],
  // tail curling up on the right
  [11, 13, 3, 2, BODY],
  [13, 10, 2, 4, BODY],
  [13, 9, 2, 1, DARK],
]

// Seasonal hats — the cat keeps up with the holidays.
function seasonalHat(): Rect[] {
  const now = new Date()
  const m = now.getMonth() + 1
  const d = now.getDate()
  // Santa hat: Dec 10 – Jan 5
  if ((m === 12 && d >= 10) || (m === 1 && d <= 5)) {
    return [
      [3, -1, 7, 2, '#d93b3b'],
      [2, 1, 10, 1, '#f4f4f4'],
      [10, -2, 2, 2, '#f4f4f4'],
    ]
  }
  // Witch hat: Oct 15 – Nov 1
  if ((m === 10 && d >= 15) || (m === 11 && d <= 1)) {
    return [
      [1, 1, 12, 1, '#3d2a66'],
      [5, -1, 4, 2, '#3d2a66'],
      [5, 0, 4, 1, '#e59a2f'],
    ]
  }
  return []
}

const MEOWS = ['meow~', 'mrrp!', 'purr…', 'mrow?', ':3']

/// The Refract cat: an optional companion in the corner of the home screen
/// (enable in Settings). Click it — it appreciates the attention.
export function CornerCat() {
  const [show, setShow] = useState(false)
  const [meow, setMeow] = useState<string | null>(null)
  const [wiggle, setWiggle] = useState(false)

  useEffect(() => {
    api.config.get().then(cfg => setShow(!!cfg.showCat)).catch(() => {})
  }, [])

  if (!show) return null

  function pet() {
    setMeow(MEOWS[Math.floor(Math.random() * MEOWS.length)])
    setWiggle(true)
    setTimeout(() => setWiggle(false), 600)
    setTimeout(() => setMeow(null), 1800)
  }

  return (
    <div
      onClick={pet}
      title="meow"
      style={{
        position: 'fixed', right: 18, bottom: 12, zIndex: 40,
        cursor: 'pointer', userSelect: 'none',
        opacity: .9,
        animation: wiggle ? 'refract-cat-wiggle .6s ease' : undefined,
      }}
    >
      <style>{`@keyframes refract-cat-wiggle { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-8deg) } 75% { transform: rotate(8deg) } }`}</style>
      {meow && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius-md)', padding: '3px 9px',
          fontSize: 11, color: 'var(--ink-2)', whiteSpace: 'nowrap',
        }}>
          {meow}
        </div>
      )}
      <svg width="44" height="50" viewBox="0 -3 14 19" shapeRendering="crispEdges" aria-hidden="true">
        {[...CAT, ...seasonalHat()].map(([x, y, w, h, fill], i) => (
          <rect key={i} x={x - 1} y={y} width={w} height={h} fill={fill} />
        ))}
      </svg>
    </div>
  )
}
