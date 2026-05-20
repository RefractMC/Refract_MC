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
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>{step}</div>
          <div style={{
            height: 8,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-r)',
          }}>
            <div style={{
              height: '100%',
              width: `${percent}%`,
              background: 'var(--accent)',
              transition: 'width 200ms linear',
              boxShadow: 'inset 0 -2px 0 var(--accent-lo), inset 0 2px 0 var(--accent-hi)',
            }} />
          </div>
          <div style={{ fontFamily: "'VT323',monospace", fontSize: 13, color: 'var(--ink-4)', marginTop: 4, textAlign: 'right' }}>
            {Math.round(percent)}%
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--ink-4)', textAlign: 'center', lineHeight: 1.4 }}>
          This may take a few minutes depending on your connection.
        </div>
      </div>
    </div>
  )
}
