import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useT, type T } from '@/i18n'

const STEP_LABELS: Record<string, string> = {
  'Fetching version data': 'stepFetchingVersionData',
  'Downloading client': 'stepDownloadingClient',
  'Extracting natives': 'stepExtractingNatives',
  'Downloading assets': 'stepDownloadingAssets',
  'Installing Fabric loader': 'stepInstallingFabric',
  'Installing Quilt loader': 'stepInstallingQuilt',
  'Installing loader libraries': 'stepInstallingLoaderLibs',
  'Done': 'stepDone',
  'Downloading Forge installer': 'stepDownloadingForgeInstaller',
  'Extracting Forge installer': 'stepExtractingForgeInstaller',
  'Downloading Forge libraries': 'stepDownloadingForgeLibs',
  'Downloading Forge tools': 'stepDownloadingForgeTools',
  'Preparing Java for Forge processors': 'stepPreparingJavaForge',
  'Running Forge processors': 'stepRunningForgeProcessors',
  'Forge installed': 'stepForgeInstalled',
}

function resolveStep(step: string, t: T): string {
  const key = STEP_LABELS[step]
  if (!key) return step
  const val = (t.home as Record<string, unknown>)[key]
  return typeof val === 'string' ? val : step
}

interface Props {
  instanceId: string
  instanceName: string
  onDone: () => void
  onError: (err: string) => void
}

export function InstallProgress({ instanceId, instanceName, onDone, onError }: Props) {
  const t = useT()
  const [step, setStep] = useState(t.home.starting)
  const [percent, setPercent] = useState(0)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    const unsub = api.mc.onProgress((data) => {
      if (data.instanceId !== instanceId) return
      setStep(resolveStep(data.step, t))
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
    api.mc.cancelInstall(instanceId).catch(() => {})
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
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-floating)',
        padding: '28px 32px',
        width: 360,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.04em' }}>
          {t.home.installingMinecraft}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 600 }}>{instanceName}</div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
            {cancelling ? t.home.cancelling : step}
          </div>
          <div style={{
            height: 8,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-r)',
            borderRadius: 'var(--radius-max)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${percent}%`,
              background: cancelling ? 'var(--ink-4)' : 'var(--accent)',
              transition: 'width 200ms linear',
            }} />
          </div>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'var(--ink-4)', marginTop: 4, textAlign: 'right' }}>
            {Math.round(percent)}%
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 }}>
            {cancelling ? t.home.finishingOperation : t.home.installMayTake}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
            style={{ flexShrink: 0 }}
          >
            {cancelling ? t.home.cancelling : t.home.cancel}
          </Button>
        </div>
      </div>
    </div>
  )
}
