import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { useInstances } from '@/hooks/use-instances'
import { useT } from '@/i18n'
import { api } from '@/lib/api'
import type { NativeOperation } from '@/env'

const terminal = new Set<NativeOperation['state']>(['succeeded', 'failed', 'cancelled'])

function RecoveryRow({
  instanceId,
  name,
  active,
}: {
  instanceId: string
  name: string
  active?: NativeOperation
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const recovery = useMutation({
    mutationFn: () => api.operations.recover(instanceId),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['instance-recoveries'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['instances'] }),
      ])
    },
  })
  const label =
    recovery.isPending || active?.state === 'recovering'
      ? t.storage.recoveringInstance
      : active
        ? t.storage.waitingForOperation
        : t.storage.retryRecovery

  return (
    <li style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 180px', minWidth: 0 }}>{name}</span>
        <Button
          size="sm"
          disabled={recovery.isPending || Boolean(active)}
          onClick={() => recovery.mutate()}
          aria-label={`${label}: ${name}`}
        >
          {label}
        </Button>
      </div>
      {recovery.error && (
        <div role="alert" style={{ marginTop: 4, color: 'var(--ink-3)' }}>
          {String(recovery.error instanceof Error ? recovery.error.message : recovery.error)}
        </div>
      )}
    </li>
  )
}

export function RecoveryNotice() {
  const t = useT()
  const queryClient = useQueryClient()
  const recoveries = useQuery({
    queryKey: ['instance-recoveries'],
    queryFn: () => api.operations.recoveries(),
  })
  const operations = useQuery({
    queryKey: ['operations'],
    queryFn: () => api.operations.list(),
    enabled: Boolean(recoveries.data?.length),
  })
  const instances = useInstances()
  useEffect(
    () =>
      api.operations.onChanged((operation) => {
        if (operation.kind === 'restore' || operation.kind === 'modpack') {
          void queryClient.invalidateQueries({ queryKey: ['instance-recoveries'] })
          void queryClient.invalidateQueries({ queryKey: ['operations'] })
          if (terminal.has(operation.state)) {
            void queryClient.invalidateQueries({ queryKey: ['instances'] })
          }
        }
      }),
    [queryClient]
  )
  // A journal exists during a healthy update too. Only interrupted work and
  // active recovery belong in this notice, never an ordinary running update.
  const visible = recoveries.data?.filter(
    (instanceId) =>
      !operations.data?.some(
        (operation) =>
          operation.instanceIds.includes(instanceId) &&
          operation.kind !== 'restore' &&
          !terminal.has(operation.state)
      )
  )
  const statusError = recoveries.error ?? operations.error
  if (!statusError && (!visible?.length || operations.isPending)) return null

  return (
    <section
      aria-label={t.storage.instanceRecoveryTitle}
      style={{
        margin: '14px 28px 0',
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
        color: 'var(--ink)',
        fontSize: 12,
        lineHeight: 1.5,
        overflowWrap: 'anywhere',
      }}
    >
      <strong>{t.storage.instanceRecoveryTitle}</strong>
      <div style={{ color: 'var(--ink-3)' }}>{t.storage.instanceRecoveryHint}</div>
      {statusError && (
        <div role="alert" style={{ marginTop: 8 }}>
          <div>{t.storage.recoveryCheckFailed}</div>
          <div>{String(statusError.message)}</div>
          <Button
            size="sm"
            disabled={recoveries.isFetching || operations.isFetching}
            onClick={() => {
              void recoveries.refetch()
              void operations.refetch()
            }}
          >
            {t.storage.retryRecoveryCheck}
          </Button>
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {!statusError &&
          visible?.map((instanceId) => (
            <RecoveryRow
              key={instanceId}
              instanceId={instanceId}
              name={
                instances.data?.find((instance) => instance.id === instanceId)?.name ?? instanceId
              }
              active={operations.data?.find(
                (operation) =>
                  operation.instanceIds.includes(instanceId) && !terminal.has(operation.state)
              )}
            />
          ))}
      </ul>
    </section>
  )
}
