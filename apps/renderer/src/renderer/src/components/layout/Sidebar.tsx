import { Link, useMatchRoute } from '@tanstack/react-router'
import { LayoutGrid, Compass, Settings, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useThemeStore } from '@/stores/theme'
import { cn } from '@/lib/utils'

const NAV_ITEMS: Array<{ to: '/'; icon: LucideIcon; label: string; exact: boolean } | { to: '/browse/'; icon: LucideIcon; label: string; exact: boolean } | { to: '/settings/'; icon: LucideIcon; label: string; exact: boolean }> = [
  { to: '/',         icon: LayoutGrid, label: 'Instances', exact: true  },
  { to: '/browse/',  icon: Compass,    label: 'Browse',    exact: false },
  { to: '/settings/', icon: Settings,  label: 'Settings',  exact: false },
]

interface NavItemProps {
  to: string
  icon: LucideIcon
  label: string
  exact: boolean
  collapsed: boolean
}

function NavItem({ to, icon: Icon, label, exact, collapsed }: NavItemProps) {
  const matchRoute = useMatchRoute()
  const isActive = !!matchRoute({ to, fuzzy: !exact })

  return (
    <Link
      to={to as '/'}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors',
        isActive
          ? 'bg-bg-overlay text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      )}
    >
      <Icon size={18} className="shrink-0" />
      {!collapsed && <span className="text-sm font-medium truncate">{label}</span>}
    </Link>
  )
}

export function Sidebar() {
  const sidebarCollapsed = useThemeStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useThemeStore((s) => s.setSidebarCollapsed)

  return (
    <aside
      className="flex flex-col bg-bg-surface border-r border-border shrink-0 transition-[width] duration-200 overflow-hidden"
      style={{ width: sidebarCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)' }}
    >
      <nav className="flex-1 flex flex-col gap-0.5 p-2 pt-3">
        {NAV_ITEMS.map((item) => (
          <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />
        ))}
      </nav>

      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="flex items-center justify-center m-2 p-2 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
      </button>
    </aside>
  )
}
