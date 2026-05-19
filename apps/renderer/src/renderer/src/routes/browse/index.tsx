import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/browse/')({
  component: Browse,
})

function Browse() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold text-text-primary mb-1">Browse</h2>
      <p className="text-text-secondary">Mod browser — coming in Phase 7.</p>
    </div>
  )
}
