import { useEffect, useState } from 'react'
import type { Instance } from '@refract/core'
import { PixelScene, loaderToScene } from '@/components/ui/PixelScene'
import { Button } from '@/components/ui/Button'
import { useT, type T } from '@/i18n'
import { getFilePath } from '@/lib/file-path'
import { registerNativeDropTarget } from '@/lib/native-drop'

export interface InstanceCardProps {
  instance: Instance
  onLaunch: () => void
  onEdit: () => void
  onConsole: () => void
  onMods: () => void
  onOpenFolder: () => void
  onServers: () => void
  onDropJar: (path: string) => void
  blockReason: 'no-profile' | 'no-license' | null
  isRunning: boolean
  isLaunching?: boolean
  hasLogs: boolean
  updateCount: number
  javaOk: boolean
  selectionMode?: boolean
  selected?: boolean
  onSelect?: () => void
  updateAvailable?: boolean
  onUpdate?: () => void
}

function PlayButton({
  onClick,
  disabled = false,
  label = 'PLAY',
}: {
  onClick?: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <Button
      variant="primary"
      disabled={disabled}
      onClick={onClick}
      style={{ flex: 1, height: 40, fontSize: 14, letterSpacing: '.03em' }}
    >
      {label}
    </Button>
  )
}

function formatPlaytime(seconds: number, t: T): string {
  if (seconds < 60) return t.home.lessThanMinute
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function requiredJava(mcVersion: string): number {
  const nums = [...mcVersion.matchAll(/\d+/g)].map((match) => Number(match[0]))
  const major = nums[0] ?? 1
  const minor = nums[1] ?? 0
  const patch = nums[2] ?? 0
  if (major >= 26) return 25
  if (major === 1 && (minor >= 21 || (minor === 20 && patch >= 5))) return 21
  if (major === 1 && minor >= 17) return 17
  return 8
}

function StatusChip({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'good' | 'warn' | 'info'
}) {
  const toneVars = {
    neutral: { color: 'var(--ink-3)', background: 'var(--surface-2)' },
    good: {
      color: 'var(--grass)',
      background: 'color-mix(in srgb, var(--grass) 12%, transparent)',
    },
    warn: {
      color: 'var(--gold)',
      background: 'color-mix(in srgb, var(--gold) 12%, transparent)',
    },
    info: {
      color: 'var(--diamond)',
      background: 'color-mix(in srgb, var(--diamond) 12%, transparent)',
    },
  }[tone]

  return (
    <span
      style={{
        height: 20,
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 7px',
        borderRadius: 'var(--radius-sm)',
        background: toneVars.background,
        color: toneVars.color,
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

export function InstanceCard({
  instance,
  onLaunch,
  onEdit,
  onConsole,
  onMods,
  onOpenFolder,
  onServers,
  onDropJar,
  blockReason,
  isRunning,
  isLaunching,
  hasLogs,
  updateCount,
  javaOk,
  selectionMode,
  selected,
  onSelect,
  updateAvailable,
  onUpdate,
}: InstanceCardProps) {
  const t = useT()
  const [dragOver, setDragOver] = useState(false)
  const [bannerHover, setBannerHover] = useState(false)
  const label = isLaunching
    ? t.home.launching
    : isRunning
      ? t.home.stop
      : instance.isInstalled
        ? t.home.play
        : t.home.install
  const statusChips: Array<{
    label: string
    tone?: 'neutral' | 'good' | 'warn' | 'info'
  }> = []
  if (isLaunching) statusChips.push({ label: t.home.launching, tone: 'info' })
  else if (isRunning) statusChips.push({ label: t.home.running, tone: 'good' })
  if (instance.isInstalled && updateAvailable) {
    statusChips.push({ label: t.home.update, tone: 'good' })
  }
  if (instance.isInstalled && updateCount > 0) {
    statusChips.push({ label: t.home.modCount(updateCount), tone: 'warn' })
  }
  if (instance.isInstalled && !javaOk) {
    statusChips.push({ label: t.home.missingJava, tone: 'warn' })
  }
  if (instance.isInstalled && blockReason === 'no-profile') {
    statusChips.push({ label: t.home.statusNoAccount, tone: 'warn' })
  }
  if (instance.isInstalled && blockReason === 'no-license') {
    statusChips.push({ label: t.home.licenseRequired, tone: 'warn' })
  }
  if (statusChips.length === 0) {
    statusChips.push(
      instance.isInstalled
        ? { label: t.home.statusInstalled, tone: 'info' }
        : { label: t.home.statusNeedsInstall, tone: 'neutral' }
    )
  }

  useEffect(
    () =>
      registerNativeDropTarget(
        instance.id,
        (paths) => paths.filter((path) => /\.(jar|zip)$/i.test(path)).forEach(onDropJar),
        setDragOver
      ),
    [instance.id, onDropJar]
  )

  return (
    <div
      data-instance-drop-id={instance.id}
      onDragOver={(event) => {
        event.preventDefault()
        if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        for (const file of [...event.dataTransfer.files]) {
          const path = getFilePath(file)
          if (path && /\.(jar|zip)$/i.test(path)) onDropJar(path)
        }
      }}
      className="instance-card"
      style={{
        width: 300,
        flexShrink: 0,
        outline: dragOver
          ? '2px solid var(--accent)'
          : selected
            ? '2px solid var(--accent)'
            : 'none',
        background:
          'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012)), var(--surface)',
        border: '1px solid var(--border-r)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        onClick={selectionMode ? onSelect : onMods}
        onMouseEnter={() => setBannerHover(true)}
        onMouseLeave={() => setBannerHover(false)}
        style={{ height: 164, position: 'relative', overflow: 'hidden', cursor: 'pointer' }}
      >
        {instance.iconPath ? (
          <img
            src={instance.iconPath}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <PixelScene
            name={loaderToScene(instance.modLoader)}
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {selectionMode && (
          <div
            onClick={(event) => {
              event.stopPropagation()
              onSelect?.()
            }}
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 5,
              width: 18,
              height: 18,
              background: selected ? 'var(--accent)' : 'rgba(0,0,0,.55)',
              border: `2px solid ${selected ? 'var(--accent)' : 'rgba(255,255,255,.5)'}`,
              borderRadius: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            {selected && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d="M2 5l2.5 2.5L8 3"
                  stroke="#fff"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        )}
        {!selectionMode && bannerHover && !dragOver && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#fff',
                letterSpacing: '.08em',
                background: 'rgba(0,0,0,.5)',
                padding: '5px 14px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {t.home.viewDetails}
            </div>
          </div>
        )}
        {dragOver && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(79,184,232,.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                letterSpacing: '.04em',
                background: 'rgba(0,0,0,.6)',
                padding: '6px 16px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {t.home.dropMod}
            </div>
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(transparent, rgba(0,0,0,.76))',
            height: 72,
          }}
        />
        {!javaOk && instance.isInstalled && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: selectionMode ? 34 : 8,
              background: 'rgba(196,148,50,.9)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 7px',
              fontSize: 11,
              fontWeight: 600,
              color: '#000',
              letterSpacing: '.02em',
            }}
          >
            {t.home.javaWarning(requiredJava(instance.minecraftVersion))}
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(0,0,0,.55)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 7px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ink-2)',
            letterSpacing: '.06em',
          }}
        >
          {instance.modLoader?.toUpperCase() ?? t.home.vanilla.toUpperCase()}
        </div>
      </div>

      <div
        style={{
          padding: '13px 14px 14px',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.2 }}>
          {instance.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              color: 'var(--ink-4)',
              letterSpacing: '.02em',
            }}
          >
            MC {instance.minecraftVersion}
          </div>
          {instance.totalTimePlayed > 0 && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--ink-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <span style={{ opacity: 0.5 }}>⏱</span>
              {formatPlaytime(instance.totalTimePlayed, t)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minHeight: 20 }}>
          {statusChips.map((chip) => (
            <StatusChip key={chip.label} label={chip.label} tone={chip.tone} />
          ))}
        </div>
        {!instance.isInstalled && (
          <div style={{ fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.35 }}>
            {t.home.notInstalled}
          </div>
        )}
        {instance.isInstalled && blockReason === 'no-profile' && (
          <div style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.35 }}>
            {t.home.noProfile}
          </div>
        )}
        {instance.isInstalled && blockReason === 'no-license' && (
          <div style={{ fontSize: 11, color: 'var(--gold)', lineHeight: 1.35 }}>
            {t.home.licenseNeeded}
          </div>
        )}
        {instance.isInstalled && updateAvailable && (
          <button
            onClick={onUpdate}
            title={t.home.modpackUpdateTitle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              alignSelf: 'flex-start',
              marginTop: 2,
              padding: '3px 9px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--grass)',
              background: 'color-mix(in srgb, var(--grass) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--grass) 45%, transparent)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            ↑ {t.home.modpackUpdate}
          </button>
        )}
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <PlayButton onClick={onLaunch} disabled={isLaunching} label={label} />
            {(isRunning || isLaunching || hasLogs) && (
              <Button
                variant="outline"
                onClick={onConsole}
                style={{
                  height: 40,
                  ...(isRunning || isLaunching
                    ? {
                        color: 'var(--grass)',
                        borderColor: 'color-mix(in srgb, var(--grass) 40%, transparent)',
                      }
                    : {}),
                }}
              >
                {isRunning || isLaunching ? t.home.console : t.home.log}
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={onMods}
              style={{
                flex: 1,
                height: 32,
                position: 'relative',
                borderColor: updateCount > 0 ? 'var(--gold)' : undefined,
              }}
            >
              {t.home.mods}
              {updateCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -5,
                    background: 'var(--gold)',
                    color: '#000',
                    fontSize: 9,
                    fontWeight: 700,
                    borderRadius: 8,
                    padding: '1px 4px',
                    lineHeight: 1.4,
                  }}
                >
                  {updateCount}
                </span>
              )}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onServers}
              style={{ flex: 1, height: 32 }}
            >
              {t.home.srv}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit} style={{ flex: 1, height: 32 }}>
              {t.home.edit}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={onOpenFolder}
              title={t.home.openFolderTip}
              style={{ width: 32, height: 32, flexShrink: 0, fontSize: 14 }}
            >
              📁
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function EmptyLibrary({ onOpen }: { onOpen: () => void }) {
  const t = useT()

  return (
    <div className="launcher-panel" style={{ padding: '60px 40px', textAlign: 'center' }}>
      <div
        style={{
          width: 72,
          height: 72,
          margin: '0 auto 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="72"
          height="72"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#b48aff"
          aria-hidden="true"
        >
          <g stroke="#b48aff" strokeWidth="1.2" strokeLinejoin="miter">
            <polygon points="3,14 12,10 21,14 12,18" fill="#b48aff" fillOpacity="0.35" />
            <polygon points="3,10 12,6 21,10 12,14" fill="#b48aff" fillOpacity="0.55" />
            <polygon points="3,6 12,2 21,6 12,10" fill="#b48aff" fillOpacity="0.85" />
          </g>
          <g stroke="#b48aff" strokeLinecap="round" strokeWidth="1" opacity="0.7">
            <line x1="6" y1="20" x2="9" y2="20" />
            <line x1="10.5" y1="20" x2="13.5" y2="20" />
            <line x1="15" y1="20" x2="18" y2="20" />
            <line x1="8" y1="22" x2="16" y2="22" opacity="0.5" />
          </g>
        </svg>
      </div>
      <p style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', margin: '0 0 6px' }}>
        {t.home.emptyTitle}
      </p>
      <p
        style={{
          fontSize: 13,
          color: 'var(--ink-3)',
          margin: '0 0 20px',
          maxWidth: 320,
          marginInline: 'auto',
        }}
      >
        {t.home.emptyDesc}
      </p>
      <Button variant="primary" size="lg" onClick={onOpen} style={{ margin: '0 auto' }}>
        {t.home.emptyBtn}
      </Button>
    </div>
  )
}
