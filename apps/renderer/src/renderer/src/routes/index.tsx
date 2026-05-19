import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Instances,
})

function Instances() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold text-text-primary mb-1">Instances</h2>
      <p className="text-text-secondary">No instances yet. Create one to get started.</p>
    </div>
  )
}
