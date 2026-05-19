import type { ReactNode } from 'react'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

interface Props {
  children: ReactNode
}

export function AppShell({ children }: Props) {
  return (
    <div
      className="h-screen overflow-hidden grid bg-bg-base"
      style={{
        gridTemplateAreas: '"titlebar" "body" "statusbar"',
        gridTemplateRows: 'var(--titlebar-height) 1fr var(--statusbar-height)',
      }}
    >
      <div style={{ gridArea: 'titlebar' }}>
        <TitleBar />
      </div>

      <div style={{ gridArea: 'body' }} className="flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>

      <div style={{ gridArea: 'statusbar' }}>
        <StatusBar />
      </div>
    </div>
  )
}
