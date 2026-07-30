import { useEffect, useState } from 'react'
import type { Instance } from '@refract/core'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { RowsSkeleton } from '@/components/ui/Skeleton'
import { useT } from '@/i18n'
import { createSocialInvite, createSocialInviteLink } from '@/lib/social-invites'

type ServerEntry = {
  name: string
  ip: string
  icon?: string
  linked?: boolean
  linkId?: string
  minecraftVersion?: string
}

interface Props {
  instance: Instance | null
  open: boolean
  onOpenChange: (value: boolean) => void
}

export function SocialServersDialog({ instance, open, onOpenChange }: Props) {
  const t = useT()
  const [servers, setServers] = useState<ServerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [shared, setShared] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !instance) return
    setServers([])
    setLoading(true)
    api.mc
      .servers(instance.id)
      .then(setServers)
      .catch(() => setServers([]))
      .finally(() => setLoading(false))
  }, [open, instance])

  if (!open || !instance) return null
  const instanceId = instance.id
  const minecraftVersion = instance.minecraftVersion

  function flash(value: string, setter: (next: string | null) => void) {
    setter(value)
    window.setTimeout(() => setter(null), 1600)
  }

  function copyIp(ip: string) {
    navigator.clipboard.writeText(ip).catch(() => {})
    flash(ip, setCopied)
  }

  function shareServer(server: ServerEntry) {
    const invite = createSocialInvite({
      kind: 'server',
      address: server.ip,
      name: server.name || t.instanceDetail.unknownServer,
      minecraftVersion: server.minecraftVersion ?? minecraftVersion,
      linkId: server.linkId,
    })
    navigator.clipboard.writeText(createSocialInviteLink(invite)).catch(() => {})
    flash(server.ip, setShared)
  }

  async function unlinkServer(server: ServerEntry) {
    if (!server.linkId) return
    await api.mc.unlinkServer(instanceId, server.linkId)
    setServers((current) => current.filter((entry) => entry.linkId !== server.linkId))
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 150,
        background: 'rgba(0,0,0,.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={() => onOpenChange(false)}
    >
      <div
        style={{
          width: 560,
          maxHeight: '70vh',
          background: 'var(--surface)',
          border: '1px solid var(--border-r)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-r)',
          }}
        >
          <div>
            <div
              style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', letterSpacing: '.04em' }}
            >
              {t.instanceDetail.serversTitle(instance.name)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
              {t.social.serverShareHint}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label={t.instanceDetail.cancel}
          >
            X
          </Button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <RowsSkeleton rows={4} />
          ) : servers.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--ink-4)',
                  letterSpacing: '.10em',
                  marginBottom: 8,
                }}
              >
                {t.instanceDetail.emptyServers}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.5 }}>
                {t.instanceDetail.serversEmptyBodyLine1}
                <br />
                {t.instanceDetail.serversEmptyBodyLine2}
              </div>
            </div>
          ) : (
            servers.map((server) => (
              <ServerRow
                key={server.linkId ?? server.ip}
                server={server}
                copied={copied === server.ip}
                shared={shared === server.ip}
                onCopy={() => copyIp(server.ip)}
                onShare={() => shareServer(server)}
                onUnlink={server.linked ? () => void unlinkServer(server) : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ServerRow({
  server,
  copied,
  shared,
  onCopy,
  onShare,
  onUnlink,
}: {
  server: ServerEntry
  copied: boolean
  shared: boolean
  onCopy: () => void
  onShare: () => void
  onUnlink?: () => void
}) {
  const t = useT()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-r)',
          imageRendering: 'pixelated',
        }}
      >
        {server.icon ? (
          <img
            src={
              server.icon.startsWith('data:') ? server.icon : `data:image/png;base64,${server.icon}`
            }
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              imageRendering: 'pixelated',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              fontSize: 18,
            }}
          >
            S
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {server.name}
          </span>
          {server.linked && (
            <span
              style={{
                padding: '2px 5px',
                borderRadius: 999,
                fontSize: 9,
                fontWeight: 800,
                color: 'var(--diamond)',
                background: 'color-mix(in srgb, var(--diamond) 12%, transparent)',
              }}
            >
              {t.social.linked}
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--ink-4)',
            marginTop: 2,
          }}
        >
          {server.ip}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? t.instanceDetail.copied : t.instanceDetail.copyIp}
        </Button>
        <Button variant="secondary" size="sm" onClick={onShare}>
          {shared ? t.social.inviteCopied : t.social.share}
        </Button>
        {onUnlink && (
          <Button variant="ghost" size="sm" onClick={onUnlink}>
            {t.social.unlink}
          </Button>
        )}
      </div>
    </div>
  )
}
