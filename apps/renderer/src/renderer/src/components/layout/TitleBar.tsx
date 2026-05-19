import { useEffect, useState } from 'react'
import { Minus, Maximize2, Minimize2, X, Layers } from 'lucide-react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    window.api.window.isMaximized().then(setIsMaximized)
    return window.api.window.onMaximizedChange(setIsMaximized)
  }, [])

  return (
    <header
      className="drag-region flex items-center justify-between bg-bg-surface border-b border-border select-none"
      style={{ height: 'var(--titlebar-height)' }}
    >
      <div className="flex items-center gap-2 px-4">
        <Layers size={16} className="text-accent" />
        <span className="text-sm font-semibold text-text-primary tracking-wide">Refract</span>
      </div>

      <div className="no-drag-region flex items-center h-full">
        <button
          onClick={() => window.api.window.minimize()}
          className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          title="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => window.api.window.maximize()}
          className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={() => window.api.window.close()}
          className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-error hover:text-white transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  )
}
