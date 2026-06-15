import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export function StatusBar() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [mem, setMem] = useState<number | null>(null)
  const [java, setJava] = useState<number | null>(null)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // Real renderer heap usage, refreshed periodically (Chromium-only API).
  useEffect(() => {
    const read = () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      if (m) setMem(Math.round(m.usedJSHeapSize / 1048576))
    }
    read()
    const id = setInterval(read, 2000)
    return () => clearInterval(id)
  }, [])

  // Highest Java runtime actually available (detected + managed).
  useEffect(() => {
    api.mc.java()
      .then(list => { const top = list.map(j => j.version).sort((a, b) => b - a)[0]; if (top) setJava(top) })
      .catch(() => {})
  }, [])

  return (
    <footer style={{
      height: 'var(--statusbar-height)',
      background: 'var(--sb)',
      borderTop: '1px solid var(--sb-line)',
      display: 'flex', alignItems: 'center',
      padding: '0 14px',
      gap: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      color: 'var(--ink-4)',
      letterSpacing: '.01em',
      userSelect: 'none',
      flexShrink: 0,
    }}>
      <Dot color={online ? 'var(--grass)' : 'var(--ink-4)'} />
      <span style={{ color: 'var(--ink-3)' }}>{online ? 'Online' : 'Offline'}</span>

      {java != null && (
        <>
          <Dot color="var(--diamond)" />
          <span style={{ color: 'var(--ink-3)' }}>Java {java}</span>
        </>
      )}

      {mem != null && (
        <>
          <Dot color="var(--gold)" />
          <span style={{ color: 'var(--ink-3)' }}>{mem} MB</span>
        </>
      )}

      <div style={{ flex: 1 }} />

      <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>Refract v{__APP_VERSION__}</span>
    </footer>
  )
}

function Dot({ color }: { color: string }) {
  return (
    <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
  )
}
