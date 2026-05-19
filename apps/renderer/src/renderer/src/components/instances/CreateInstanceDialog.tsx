import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, ChevronDown } from 'lucide-react'
import type { ModLoader } from '@refract/core'
import { cn } from '@/lib/utils'

const MC_VERSIONS = [
  '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
  '1.19.4', '1.19.2', '1.19',
  '1.18.2', '1.18.1', '1.18',
  '1.17.1', '1.16.5', '1.15.2', '1.14.4',
  '1.12.2', '1.8.9', '1.7.10',
]

const MOD_LOADERS: Array<{ value: ModLoader | ''; label: string }> = [
  { value: '',         label: 'No mods'  },
  { value: 'fabric',   label: 'Fabric'   },
  { value: 'forge',    label: 'Forge'    },
  { value: 'quilt',    label: 'Quilt'    },
  { value: 'neoforge', label: 'NeoForge' },
]

const MEMORY_QUICK = [1024, 2048, 4096, 8192, 16384]
const MEMORY_MIN_MB = 512
const MEMORY_MAX_MB = 32768
const MEMORY_STEP   = 512

function mbToGb(mb: number) {
  return (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)
}

interface CreateInput {
  name: string
  minecraftVersion: string
  modLoader?: ModLoader
  memoryMb: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreateInput) => Promise<void>
}

export function CreateInstanceDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName]           = useState('')
  const [mcVersion, setMcVersion] = useState('1.21.1')
  const [modLoader, setModLoader] = useState<ModLoader | ''>('')
  const [memoryMb, setMemoryMb]   = useState(2048)
  const [gbInput, setGbInput]     = useState('2')
  const [loading, setLoading]     = useState(false)

  function setMemory(mb: number) {
    const clamped = Math.max(MEMORY_MIN_MB, Math.min(MEMORY_MAX_MB, mb))
    setMemoryMb(clamped)
    setGbInput(mbToGb(clamped))
  }

  function handleGbInput(raw: string) {
    setGbInput(raw)
    const gb = parseFloat(raw)
    if (!isNaN(gb) && gb > 0) {
      const mb = Math.round(gb * 1024 / MEMORY_STEP) * MEMORY_STEP
      setMemoryMb(Math.max(MEMORY_MIN_MB, Math.min(MEMORY_MAX_MB, mb)))
    }
  }

  function handleGbBlur() {
    setGbInput(mbToGb(memoryMb))
  }

  function reset() {
    setName('')
    setMcVersion('1.21.1')
    setModLoader('')
    setMemory(2048)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    try {
      await onCreate({
        name: name.trim(),
        minecraftVersion: mcVersion,
        modLoader: modLoader || undefined,
        memoryMb,
      })
      onOpenChange(false)
      reset()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!loading) { if (!v) reset(); onOpenChange(v) } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/75 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg-surface border border-border rounded-3xl shadow-2xl z-50 focus:outline-none" style={{ width: '548px', padding: '24px' }}>

          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <Dialog.Title className="text-xl font-semibold text-text-primary">
              New Instance
            </Dialog.Title>
            <Dialog.Close
              disabled={loading}
              className="p-2 rounded-xl text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors disabled:opacity-40"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-6">

            {/* Name */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-text-secondary">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Instance"
                className="w-full px-4 py-2.5 rounded-xl bg-bg-overlay border border-border text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent/60 transition-colors"
                autoFocus
              />
            </div>

            {/* Minecraft version */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-text-secondary">Minecraft Version</label>
              <div className="relative">
                <select
                  value={mcVersion}
                  onChange={(e) => setMcVersion(e.target.value)}
                  className="w-full px-4 py-2.5 pr-9 rounded-xl bg-bg-overlay border border-border text-text-primary text-sm focus:outline-none focus:border-accent/60 transition-colors appearance-none cursor-pointer"
                >
                  {MC_VERSIONS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              </div>
            </div>

            {/* Mod loader */}
            <div className="flex flex-col gap-2">
              <div>
                <label className="text-sm font-medium text-text-secondary">Mod Loader</label>
                <p className="mt-1 text-xs text-text-muted">Choose “No mods” to create a clean Vanilla Minecraft instance.</p>
              </div>
              <div className="flex gap-2">
                {MOD_LOADERS.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => setModLoader(l.value)}
                    className={cn(
                      'flex-1 py-2 rounded-xl text-sm font-medium transition-colors border',
                      modLoader === l.value
                        ? 'bg-accent text-accent-fg border-accent'
                        : 'bg-bg-overlay text-text-secondary border-border hover:border-accent/40 hover:text-text-primary'
                    )}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Memory */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-secondary">Memory</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0.5}
                    max={32}
                    step={0.5}
                    value={gbInput}
                    onChange={(e) => handleGbInput(e.target.value)}
                    onBlur={handleGbBlur}
                    className="w-16 px-2 py-1 rounded-lg bg-bg-overlay border border-border text-text-primary text-sm text-right focus:outline-none focus:border-accent/60 transition-colors"
                  />
                  <span className="text-sm text-text-muted">GB</span>
                </div>
              </div>

              {/* Slider */}
              <input
                type="range"
                min={MEMORY_MIN_MB}
                max={MEMORY_MAX_MB}
                step={MEMORY_STEP}
                value={memoryMb}
                onChange={(e) => setMemory(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)] bg-bg-overlay"
                style={{
                  background: `linear-gradient(to right, var(--color-accent) ${((memoryMb - MEMORY_MIN_MB) / (MEMORY_MAX_MB - MEMORY_MIN_MB)) * 100}%, var(--color-bg-overlay) 0%)`,
                }}
              />

              <div className="flex items-center justify-between text-xs text-text-muted">
                <span>512 MB</span>
                <span>32 GB</span>
              </div>

              {/* Quick picks */}
              <div className="flex gap-2">
                {MEMORY_QUICK.map((mb) => (
                  <button
                    key={mb}
                    type="button"
                    onClick={() => setMemory(mb)}
                    className={cn(
                      'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                      memoryMb === mb
                        ? 'bg-accent text-accent-fg border-accent'
                        : 'bg-bg-overlay text-text-muted border-border hover:border-accent/40 hover:text-text-secondary'
                    )}
                  >
                    {mb >= 1024 ? `${mb / 1024}G` : `${mb}M`}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2 border-t border-border">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={loading}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-text-secondary bg-bg-overlay border border-border hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={!name.trim() || loading}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-accent text-accent-fg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
