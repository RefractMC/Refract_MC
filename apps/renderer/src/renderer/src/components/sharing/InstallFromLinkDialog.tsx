import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from '@tanstack/react-router'
import { Link2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import {
  deliverShareTarget,
  onOpenInstallFromLink,
  resolveShareInput,
  routeForShareTarget,
  type ResolvedShareTarget,
} from '@/lib/share-link'

const handledDeepLinks = new Set<string>()

export function InstallFromLinkDialog() {
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<ResolvedShareTarget | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function resolve(value = input) {
    setLoading(true)
    setError(null)
    setTarget(null)
    try {
      setTarget(await resolveShareInput(value))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.sharing.invalid)
    } finally {
      setLoading(false)
    }
  }

  function receive(value: string) {
    setInput(value)
    setTarget(null)
    setError(null)
    setOpen(true)
    if (value) void resolve(value)
  }

  useEffect(() => onOpenInstallFromLink(receive), [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    const handleUrls = (urls: string[]) => {
      const url = urls.find(candidate => candidate.startsWith('refract://'))
      if (!url || handledDeepLinks.has(url)) return
      handledDeepLinks.add(url)
      receive(url)
    }

    void import('@tauri-apps/plugin-deep-link')
      .then(async ({ getCurrent, onOpenUrl }) => {
        if (cancelled) return
        handleUrls((await getCurrent()) ?? [])
        unlisten = await onOpenUrl(handleUrls)
        if (cancelled) unlisten()
      })
      .catch(() => { /* browser preview has no native deep-link plugin */ })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  function continueToInstall() {
    if (!target) return
    deliverShareTarget(target)
    void navigate({ to: routeForShareTarget(target) })
    setOpen(false)
  }

  const targetIcon = target
    ? target.provider === 'curseforge' ? target.project.logo?.thumbnailUrl : target.project.icon_url
    : null
  const targetName = target
    ? target.provider === 'curseforge' ? target.project.name : target.project.title
    : ''

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!loading) setOpen(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" />
        <Dialog.Content
          className="ni-dialog"
          aria-describedby="elink-description"
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus() }}
          style={{ zIndex: 10001, width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 48px)', overflow: 'hidden' }}
        >
          <div className="ni-dialog-header" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '18px 20px', borderBottom: '1px solid var(--border-r)' }}>
            <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center', color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 13%, var(--surface-2))' }}>
              <Link2 size={18} aria-hidden="true" />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Dialog.Title style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}>{t.sharing.title}</Dialog.Title>
                <span style={{ padding: '2px 6px', borderRadius: 999, fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>{t.sharing.beta}</span>
              </div>
              <Dialog.Description id="elink-description" style={{ margin: '3px 0 0', color: 'var(--ink-3)', fontSize: 12 }}>{t.sharing.subtitle}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t.sharing.cancel}><X size={16} /></Button>
            </Dialog.Close>
          </div>

          <form onSubmit={(event) => { event.preventDefault(); void resolve() }} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}>
              {t.sharing.inputLabel}
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => { setInput(event.target.value); setTarget(null); setError(null) }}
                placeholder={t.sharing.placeholder}
                autoComplete="off"
                spellCheck={false}
                style={{ height: 40, padding: '0 12px', borderRadius: 'var(--radius-sm)', border: `1px solid ${error ? 'var(--danger)' : 'var(--border-r)'}`, background: 'var(--surface-2)', color: 'var(--ink)', outline: 'none', fontSize: 13 }}
              />
            </label>

            {error && <div role="alert" style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)', fontSize: 12 }}>{error}</div>}

            {target && (
              <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', gap: 12, alignItems: 'center', padding: 12, border: '1px solid var(--border-r)', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }}>
                {targetIcon ? (
                  <img src={targetIcon} alt="" style={{ width: 44, height: 44, borderRadius: 'var(--radius-sm)', objectFit: 'cover' }} />
                ) : <div style={{ width: 44, height: 44, borderRadius: 'var(--radius-sm)', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--ink-4)' }}><Link2 size={17} /></div>}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{targetName}</div>
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--ink-3)', textTransform: 'capitalize' }}>{target.provider} ? {target.kind}</div>
                  <div style={{ marginTop: 5, fontSize: 11, color: 'var(--ink-4)' }}>{t.sharing.ready}</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Dialog.Close asChild><Button variant="ghost" disabled={loading}>{t.sharing.cancel}</Button></Dialog.Close>
              {!target ? (
                <Button variant="primary" type="submit" disabled={loading || !input.trim()}>{loading ? t.sharing.resolving : t.sharing.resolve}</Button>
              ) : (
                <Button variant="primary" onClick={continueToInstall}>{t.sharing.continue}</Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
