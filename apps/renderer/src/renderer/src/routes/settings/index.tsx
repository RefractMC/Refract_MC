import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/')({
  component: Settings,
})

function Settings() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold text-text-primary mb-1">Settings</h2>
      <p className="text-text-secondary">Settings — coming in Phase 8.</p>
    </div>
  )
}
