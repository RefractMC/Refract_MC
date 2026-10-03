import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { useScrollLock } from '@/lib/use-scroll-lock'
import { useT } from '@/i18n'

type Preview = Awaited<ReturnType<Window['api']['mc']['previewLog']>>
type Source = 'latest' | 'crash'

export function UploadLogButton({
  instanceId,
  source,
  style,
}: {
  instanceId: string
  source: Source
  style?: CSSProperties
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button ref={trigger} variant="secondary" onClick={() => setOpen(true)} style={style}>
        {t.home.uploadLog}
      </Button>
      {open && (
        <LogSharePreview
          instanceId={instanceId}
          source={source}
          onClose={() => setOpen(false)}
          onReturnFocus={() => trigger.current?.focus()}
        />
      )}
    </>
  )
}

function LogSharePreview({
  instanceId,
  source,
  onClose,
  onReturnFocus,
}: {
  instanceId: string
  source: Source
  onClose: () => void
  onReturnFocus: () => void
}) {
  const t = useT()
  useScrollLock()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [state, setState] = useState<'loading' | 'review' | 'uploading' | 'done' | 'error'>(
    'loading'
  )
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const alive = useRef(false)
  const uploading = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let previewId: string | undefined
    setState('loading')
    setPreview(null)
    void api.mc.previewLog(instanceId, source).then(
      (result) => {
        previewId = result.previewId
        if (disposed) {
          void api.mc.discardLogPreview(result.previewId).catch(() => {})
          return
        }
        setPreview(result)
        setState('review')
      },
      () => {
        if (!disposed) setState('error')
      }
    )
    return () => {
      disposed = true
      if (previewId) void api.mc.discardLogPreview(previewId).catch(() => {})
    }
  }, [instanceId, source, attempt])

  async function upload() {
    if (!preview || state !== 'review' || uploading.current) return
    uploading.current = true
    setState('uploading')
    try {
      const link = await api.mc.uploadLog(preview.previewId)
      if (!alive.current) return
      setUrl(link)
      setState('done')
    } catch {
      if (alive.current) setState('error')
    } finally {
      uploading.current = false
    }
  }

  async function copyLink() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      if (alive.current) {
        setCopied(true)
        setCopyFailed(false)
      }
    } catch {
      if (alive.current) setCopyFailed(true)
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !uploading.current) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" style={{ zIndex: 10004 }} />
        <Dialog.Content
          className="ni-dialog"
          aria-busy={state === 'loading' || state === 'uploading'}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onReturnFocus()
          }}
          style={{
            zIndex: 10005,
            width: 'min(840px, calc(100vw - 32px))',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            padding: 20,
            gap: 12,
          }}
          onEscapeKeyDown={(event) => {
            event.stopPropagation()
            if (uploading.current) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (uploading.current) event.preventDefault()
          }}
        >
          <Dialog.Title style={{ margin: 0, fontSize: 18 }}>{t.logSharing.title}</Dialog.Title>
          <Dialog.Description style={{ margin: 0, fontSize: 13, color: 'var(--ink-3)' }}>
            {t.logSharing.description}
          </Dialog.Description>
          {state === 'loading' && <p role="status">{t.logSharing.loading}</p>}
          {preview && state !== 'done' && (
            <>
              {preview.truncated && <p role="status">{t.logSharing.truncated}</p>}
              <pre
                tabIndex={0}
                aria-label={t.logSharing.previewLabel}
                style={{
                  flex: 1,
                  minHeight: 100,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontSize: 11,
                  padding: 12,
                  margin: 0,
                  background: 'var(--surface-2)',
                  color: 'var(--ink)',
                }}
              >
                {preview.text}
              </pre>
            </>
          )}
          {state === 'error' && <p role="alert">{t.logSharing.failed}</p>}
          {state === 'done' && url && (
            <div role="status" style={{ overflowWrap: 'anywhere' }}>
              <p>{t.logSharing.shared}</p>
              <code>{url}</code>
              {copyFailed && <p role="alert">{t.logSharing.copyFailed}</p>}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" disabled={state === 'uploading'} onClick={onClose}>
              {t.logSharing.close}
            </Button>
            {state === 'error' && (
              <Button onClick={() => setAttempt((value) => value + 1)}>{t.logSharing.retry}</Button>
            )}
            {(state === 'review' || state === 'uploading') && (
              <Button disabled={state === 'uploading'} onClick={() => void upload()}>
                {state === 'uploading' ? t.home.uploading : t.logSharing.confirm}
              </Button>
            )}
            {state === 'done' && (
              <Button onClick={() => void copyLink()}>
                {copied ? t.home.linkCopied : t.logSharing.copyLink}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
