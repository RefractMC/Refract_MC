import React from 'react'

/** Shimmering placeholder block (see `.sk` in globals.css). */
export function Skeleton({ w, h, r, style }: {
  w?: number | string
  h?: number | string
  r?: number | string
  style?: React.CSSProperties
}) {
  return <div className="sk" aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />
}

/** Placeholder for the mod/modpack browse grids — mirrors the card layout. */
export function CardGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div aria-hidden style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ padding: '14px 14px 10px', display: 'flex', gap: 12 }}>
            <Skeleton w={64} h={64} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              <Skeleton w={`${62 + ((i * 13) % 25)}%`} h={14} />
              <Skeleton w="45%" h={11} />
            </div>
          </div>
          <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Skeleton w="100%" h={11} />
            <Skeleton w={`${70 + ((i * 7) % 22)}%`} h={11} />
            <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
              <Skeleton w={54} h={18} r="calc(var(--radius) * 1.125)" />
              <Skeleton w={54} h={18} r="calc(var(--radius) * 1.125)" />
              <Skeleton w={40} h={18} r="calc(var(--radius) * 1.125)" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Placeholder rows for list views (mods, worlds, servers). */
export function RowsSkeleton({ rows = 6, pad = '10px 16px' }: { rows?: number; pad?: string }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: pad }}>
          <Skeleton w={34} h={34} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton w={`${55 - (i % 3) * 10}%`} h={12} />
            <Skeleton w="30%" h={10} />
          </div>
          <Skeleton w={64} h={24} r="var(--radius-sm)" />
        </div>
      ))}
    </div>
  )
}

/** Placeholder for paragraph/description text. */
export function TextSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === lines - 1 ? '60%' : '100%'} h={12} />
      ))}
    </div>
  )
}
