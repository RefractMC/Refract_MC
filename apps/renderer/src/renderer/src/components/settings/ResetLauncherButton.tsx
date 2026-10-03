import * as Dialog from '@radix-ui/react-dialog'
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { finishLauncherReset } from '@/lib/launcher-reset'
import { useScrollLock } from '@/lib/use-scroll-lock'
import { useT } from '@/i18n'

export function ResetLauncherButton({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        ref={trigger}
        variant="danger"
        disabled={disabled}
        onClick={() => setOpen(true)}
        style={{ flexShrink: 0 }}
      >
        {t.settings.deleteAllDataBtn}
      </Button>
      {open && (
        <ResetReview
          disabled={disabled}
          onClose={() => setOpen(false)}
          onReturnFocus={() => trigger.current?.focus()}
        />
      )}
    </>
  )
}

function ResetReview({
  disabled,
  onClose,
  onReturnFocus,
}: {
  disabled: boolean
  onClose: () => void
  onReturnFocus: () => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  useScrollLock()
  const [deleteAccounts, setDeleteAccounts] = useState(false)
  const [unlinkExternalInstances, setUnlinkExternalInstances] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nativeComplete, setNativeComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const completed = useRef(false)

  async function reset() {
    if (disabled || running.current || (!confirmed && !completed.current)) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      if (!completed.current) {
        await api.launcher.deleteAll({ deleteAccounts, unlinkExternalInstances })
        completed.current = true
        setNativeComplete(true)
      }
      await finishLauncherReset({
        cancelQueries: () => queryClient.cancelQueries(),
        clearQueries: () => queryClient.clear(),
        local: window.localStorage,
        session: window.sessionStorage,
        reload: () => {
          window.location.hash = '#/'
          window.location.reload()
        },
      })
    } catch (failure) {
      const detail =
        typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : ''
      setError(
        completed.current
          ? t.settingsReset.localFailure
          : `${t.settingsReset.failure} ${detail}`.trim()
      )
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const locked = busy || nativeComplete
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !running.current && !completed.current) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" style={{ zIndex: 10004 }} />
        <Dialog.Content
          className="ni-dialog"
          aria-busy={busy}
          style={{
            zIndex: 10005,
            width: 'min(620px, calc(100vw - 32px))',
            maxHeight: '85vh',
            overflow: 'auto',
            padding: 20,
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onReturnFocus()
          }}
          onEscapeKeyDown={(event) => {
            event.stopPropagation()
            if (locked) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (locked) event.preventDefault()
          }}
        >
          <Dialog.Title style={{ marginTop: 0 }}>{t.settingsReset.title}</Dialog.Title>
          <Dialog.Description>{t.settingsReset.description}</Dialog.Description>
          <ul style={{ paddingLeft: 20, lineHeight: 1.6 }}>
            <li>{t.settingsReset.managed}</li>
            <li>{t.settingsReset.personal}</li>
            <li>{t.settingsReset.local}</li>
          </ul>
          <p>{t.settingsReset.external}</p>
          <p>{t.settingsReset.analytics}</p>
          <fieldset
            disabled={locked}
            style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 12 }}
          >
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={deleteAccounts}
                onChange={(event) => setDeleteAccounts(event.target.checked)}
              />
              {t.settingsReset.accounts}
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={unlinkExternalInstances}
                onChange={(event) => setUnlinkExternalInstances(event.target.checked)}
              />
              {t.settingsReset.unlink}
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t.settingsReset.confirmation}
            </label>
          </fieldset>
          {error && (
            <p role="alert" style={{ color: 'var(--lava)', overflowWrap: 'anywhere' }}>
              {error}
            </p>
          )}
          {busy && <p role="status">{t.settings.deleting}</p>}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 20,
            }}
          >
            <Button variant="secondary" disabled={locked} onClick={onClose}>
              {t.settings.cancel}
            </Button>
            <Button
              variant="danger"
              disabled={disabled || busy || (!confirmed && !nativeComplete)}
              onClick={() => void reset()}
            >
              {nativeComplete ? t.settingsReset.finish : t.settings.deleteAllConfirm}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
