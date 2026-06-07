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
        {/* Animated ambient background */}
        <div aria-hidden style={{
          position:'absolute', inset:0, zIndex:0, pointerEvents:'none', overflow:'hidden',
        }}>
          <div style={{
            position:'absolute', width:'60%', height:'60%', borderRadius:'50%',
            background:'radial-gradient(ellipse, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%)',
            top:'-10%', right:'5%',
            animation:'ambient-1 18s ease-in-out infinite alternate',
          }} />
          <div style={{
            position:'absolute', width:'50%', height:'50%', borderRadius:'50%',
            background:'radial-gradient(ellipse, color-mix(in srgb, var(--accent) 5%, transparent), transparent 70%)',
            bottom:'0%', left:'10%',
            animation:'ambient-2 24s ease-in-out infinite alternate',
          }} />
        </div>
        <div
          key={pathname}
          style={{ flex:1, minHeight:0, overflowY:'auto', overflowX:'hidden', padding:'24px 28px 28px', position:'relative', zIndex:1, animation:'page-enter 210ms cubic-bezier(.25,.46,.45,.94) both' }}
        >
          {children}
        </div>
        <StatusBar />
      </div>
    </div>
  )
}
