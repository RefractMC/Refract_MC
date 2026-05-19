export function StatusBar() {
  return (
    <footer
      className="flex items-center justify-between px-4 bg-bg-surface border-t border-border"
      style={{ height: 'var(--statusbar-height)' }}
    >
      <span className="text-xs text-text-muted">Refract v0.1.0</span>
    </footer>
  )
}
