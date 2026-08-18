import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, Radio, Users, X } from '@/components/ui/Icon'
import { useState } from 'react'
import type { Instance } from '@refract/core'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'

export type WorldShareStage = 'preparing' | 'waiting' | 'ready' | 'error'

interface Props {
  instance: Instance | null
  stage: WorldShareStage
  address?: string
  inviteLink?: string
  error?: string
  onClose: () => void
}

export function WorldShareDialog({ instance, stage, address, inviteLink, error, onClose }: Props) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  if (!instance) return null

  function copyInvite() {
    if (!inviteLink) return
    navigator.clipboard.writeText(inviteLink).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && stage !== 'preparing') onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" />
        <Dialog.Content
          className="ni-dialog"
          aria-describedby="world-share-description"
          style={{ zIndex: 10003, width: 'min(500px, calc(100vw - 32px))', overflow: 'hidden' }}
        >
          <div
            className="ni-dialog-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 13,
              padding: '18px 20px',
              borderBottom: '1px solid var(--border-r)',
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 'var(--radius-md)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--diamond)',
                background: 'color-mix(in srgb, var(--diamond) 13%, var(--surface-2))',
              }}
            >
              {stage === 'ready' ? (
                <Check size={19} />
              ) : stage === 'waiting' ? (
                <Radio size={19} />
              ) : (
                <Users size={19} />
              )}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Dialog.Title style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}>
                {t.social.shareWorldTitle(instance.name)}
              </Dialog.Title>
              <Dialog.Description
                id="world-share-description"
                style={{ margin: '3px 0 0', color: 'var(--ink-3)', fontSize: 12 }}
              >
                {stage === 'preparing'
                  ? t.social.installingE4mc
                  : stage === 'waiting'
                    ? t.social.waitingForLan
                    : stage === 'ready'
                      ? t.social.worldReady
                      : t.social.shareFailed}
              </Dialog.Description>
            </div>
            {stage !== 'preparing' && (
              <Button variant="ghost" size="icon" onClick={onClose} aria-label={t.social.cancel}>
                <X size={16} />
              </Button>
            )}
          </div>

          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 15 }}>
            {stage === 'preparing' && (
              <div
                style={{
                  height: 4,
                  overflow: 'hidden',
                  borderRadius: 99,
                  background: 'var(--surface-3)',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: '45%',
                    borderRadius: 99,
                    background: 'var(--accent)',
                    animation: 'indeterminate 1.2s ease-in-out infinite',
                  }}
                />
              </div>
            )}
            {stage === 'waiting' && (
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  color: 'var(--ink-3)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <li>{t.social.openWorld}</li>
                <li>{t.social.openToLan}</li>
                <li>{t.social.keepDialogOpen}</li>
              </ol>
            )}
            {stage === 'ready' && address && (
              <div
                style={{
                  padding: 13,
                  border: '1px solid color-mix(in srgb, var(--grass) 40%, var(--border-r))',
                  borderRadius: 'var(--radius-md)',
                  background: 'color-mix(in srgb, var(--grass) 8%, var(--surface-2))',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 750, color: 'var(--grass)' }}>
                  {t.social.liveAddress}
                </div>
                <div
                  style={{
                    marginTop: 5,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {address}
                </div>
              </div>
            )}
            {stage === 'error' && (
              <div
                role="alert"
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--danger)',
                  background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                  fontSize: 12,
                }}
              >
                {error ?? t.social.shareFailed}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {stage !== 'preparing' && (
                <Button variant="ghost" onClick={onClose}>
                  {stage === 'ready' ? t.social.done : t.social.cancel}
                </Button>
              )}
              {stage === 'ready' && (
                <Button variant="primary" onClick={copyInvite}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? t.social.inviteCopied : t.social.copyInvite}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
