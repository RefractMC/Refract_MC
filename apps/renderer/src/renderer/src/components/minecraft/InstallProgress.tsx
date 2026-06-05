import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Props {
  instanceId: string
  instanceName: string
  onDone: () => void
  onError: (err: string) => void
}

export function InstallProgress({ instanceId, instanceName, onDone, onError }: Props) {
  const [step, setStep] = useState('Starting…')
  const [percent, setPercent] = useState(0)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    const unsub = api.mc.onProgress((data) => {
      if (data.instanceId !== instanceId) return
      setStep(data.step)
      setPercent(data.percent)
      if (data.step === 'Done') onDone()
    })
    const unsubExit = api.mc.onExit((data) => {
      if (data.instanceId !== instanceId) return
      if (data.error) onError(data.error)
    })
    return () => { unsub(); unsubExit() }
  }, [instanceId, onDone, onError])

  function handleCancel() {
    setCancelling(true)
    api.mc.cancelInstall().catch(() => {})
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius)',
        padding: '28px 32px',
        width: 360,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontFamily: "'VT323',monospace", fontSize: 20, color: 'var(--accent)', letterSpacing: '.1em' }}>
          INSTALLING MINECRAFT
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 600 }}>{instanceName}</div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
            {cancelling ? 'Cancelling…' : step}
          </div>
          <div style={{
            height: 8,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-r)',
          }}>
            <div style={{
              height: '100%',
              width: `${percent}%`,
              background: cancelling ? 'var(--ink-4)' : 'var(--accent)',
              transition: 'width 200ms linear',
              boxShadow: cancelling ? 'none' : 'inset 0 -2px 0 var(--accent-lo), inset 0 2px 0 var(--accent-hi)',
            }} />
          </div>
          <div style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--ink-4)', marginTop: 4, textAlign: 'right' }}>
            {Math.round(percent)}%
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>
            {cancelling ? 'Finishing current operation…' : 'This may take a few minutes depending on your connection.'}
          </div>
          <button
            onClick={handleCancel}
            disabled={cancelling}
            style={{
              flexShrink: 0,
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 7,
              border: '1px solid var(--border-r)',
              background: 'var(--surface-2)',
              color: cancelling ? 'var(--ink-4)' : 'var(--ink-3)',
              cursor: cancelling ? 'not-allowed' : 'pointer',
            }}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
