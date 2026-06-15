import type { ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div style={{
      height: '100vh',
      display: 'grid',
      gridTemplateColumns: 'var(--sidebar-width) 1fr',
      gridTemplateRows: 'var(--titlebar-height) 1fr',
      overflow: 'hidden',
      transition: 'grid-template-columns 220ms cubic-bezier(.4,0,.2,1)',
      background: 'var(--bg)',
      position: 'relative',
      zIndex: 1,
      boxShadow: '0 0 0 1px var(--border-r) inset, 0 24px 60px -10px rgba(0,0,0,.6)',
    }}>
      <TitleBar />
      <Sidebar />
      <div style={{ gridRow:'2/3', gridColumn:'2/3', display:'flex', flexDirection:'column', minHeight:0, minWidth:0, overflow:'hidden', background:'var(--bg)', position:'relative' }}>
        <div
          key={pathname}
          className="app-scroll"
          style={{ flex:1, minHeight:0, overflowY:'auto', overflowX:'hidden', padding:'24px 28px 28px', position:'relative', zIndex:1, animation:'page-enter 160ms ease-out both' }}
        >
          {children}
        </div>
        <StatusBar />
      </div>
    </div>
  )
}
