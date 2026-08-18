import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from '@tanstack/react-router'
import { Link2, Server, Users, X } from '@/components/ui/Icon'
import { useEffect, useMemo, useState } from 'react'
import type { Instance } from '@refract/core'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import { api } from '@/lib/api'
import { deliverSocialJoin, parseSocialInviteLink, type SocialInvite } from '@/lib/social-invites'

const handledInviteLinks = new Set<string>()

export function SocialInviteDialog() {
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [invite, setInvite] = useState<SocialInvite | null>(null)
  const [instances, setInstances] = useState<Instance[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [keepLinked, setKeepLinked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const compatible = useMemo(
    () =>
      instances.filter(
        (instance) =>
          instance.isInstalled &&
          (!invite?.minecraftVersion || instance.minecraftVersion === invite.minecraftVersion)
      ),
    [instances, invite]
  )

  function receive(raw: string) {
    try {
      const parsed = parseSocialInviteLink(raw)
      setInvite(parsed)
      setKeepLinked(parsed.kind === 'server')
      setError(null)
      setOpen(true)
      setLoading(true)
      void api.instance
        .list()
        .then((list) => {
          const matches = list.filter(
            (instance) =>
              instance.isInstalled &&
              (!parsed.minecraftVersion || instance.minecraftVersion === parsed.minecraftVersion)
          )
          setInstances(list)
          setSelectedId(matches[0]?.id ?? '')
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : t.social.loadFailed))
        .finally(() => setLoading(false))
    } catch (cause) {
      setInvite(null)
      setError(cause instanceof Error ? cause.message : t.social.invalidInvite)
      setOpen(true)
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    const handleUrls = (urls: string[]) => {
      const url = urls.find((candidate) => candidate.startsWith('refract://join/'))
      if (!url || handledInviteLinks.has(url)) return
      handledInviteLinks.add(url)
      receive(url)
    }
    void import('@tauri-apps/plugin-deep-link')
      .then(async ({ getCurrent, onOpenUrl }) => {
        if (cancelled) return
        handleUrls((await getCurrent()) ?? [])
        unlisten = await onOpenUrl(handleUrls)
        if (cancelled) unlisten()
      })
      .catch(() => {
        /* browser preview has no native deep-link plugin */
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  async function accept() {
    if (!invite || !selectedId) return
    setLoading(true)
    setError(null)
    try {
      if (keepLinked && invite.kind === 'server') {
        await api.mc.linkServer(selectedId, {
          id: invite.linkId,
          name: invite.name,
          ip: invite.address,
          minecraftVersion: invite.minecraftVersion,
        })
      }
      deliverSocialJoin({ instanceId: selectedId, invite })
      setOpen(false)
      await navigate({ to: '/' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.social.joinFailed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!loading) setOpen(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" />
        <Dialog.Content
          className="ni-dialog"
          aria-describedby="social-invite-description"
          style={{ zIndex: 10002, width: 'min(500px, calc(100vw - 32px))', overflow: 'hidden' }}
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
              {invite?.kind === 'world' ? <Users size={19} /> : <Server size={19} />}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Dialog.Title style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}>
                {invite?.kind === 'world' ? t.social.worldInvite : t.social.serverInvite}
              </Dialog.Title>
              <Dialog.Description
                id="social-invite-description"
                style={{ margin: '3px 0 0', color: 'var(--ink-3)', fontSize: 12 }}
              >
                {t.social.confirmHint}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t.social.cancel}>
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>

          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 15 }}>
            {invite && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px minmax(0, 1fr)',
                  gap: 12,
                  alignItems: 'center',
                  padding: 12,
                  border: '1px solid var(--border-r)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)',
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 'var(--radius-sm)',
                    display: 'grid',
                    placeItems: 'center',
                    color: 'var(--accent)',
                    background: 'var(--surface-3)',
                  }}
                >
                  <Link2 size={17} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--ink)' }}>
                    {invite.name}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--ink-3)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {invite.address}
                  </div>
                  {invite.minecraftVersion && (
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--ink-4)' }}>
                      Minecraft {invite.minecraftVersion}
                    </div>
                  )}
                </div>
              </div>
            )}

            {invite && (
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 7,
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--ink-2)',
                }}
              >
                {t.social.chooseInstance}
                <select
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  disabled={loading || compatible.length === 0}
                  style={{
                    height: 40,
                    padding: '0 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-r)',
                    background: 'var(--surface-2)',
                    color: 'var(--ink)',
                  }}
                >
                  {compatible.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name} - {instance.minecraftVersion}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {!loading && invite && compatible.length === 0 && (
              <div
                role="status"
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--gold)',
                  background: 'color-mix(in srgb, var(--gold) 10%, transparent)',
                  fontSize: 12,
                }}
              >
                {t.social.noCompatible(invite.minecraftVersion ?? t.social.anyVersion)}
              </div>
            )}
            {error && (
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
                {error}
              </div>
            )}

            {invite?.kind === 'server' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  fontSize: 12,
                  color: 'var(--ink-3)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={keepLinked}
                  onChange={(event) => setKeepLinked(event.target.checked)}
                />
                {t.social.keepLinked}
              </label>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Dialog.Close asChild>
                <Button variant="ghost" disabled={loading}>
                  {t.social.cancel}
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                onClick={() => void accept()}
                disabled={loading || !invite || !selectedId}
              >
                {loading ? t.social.preparing : keepLinked ? t.social.joinAndLink : t.social.join}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
