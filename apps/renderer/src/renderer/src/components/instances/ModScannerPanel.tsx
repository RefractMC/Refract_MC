import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'

export function ModScannerPanel({ instanceId }: { instanceId: string }) {
  const t = useT().modScanner
  const [filter, setFilter] = useState('ALL')
  const scan = useQuery({
    queryKey: ['mod-scan', instanceId],
    queryFn: () => api.mods.scan(instanceId),
    enabled: false,
    retry: false,
    gcTime: 0,
  })
  const report = scan.isError ? undefined : scan.data
  const filters = [
    { id: 'ALL', label: t.all },
    { id: 'ERROR', label: t.errors },
    { id: 'WARNING', label: t.warnings },
    { id: 'INFO', label: t.info },
  ]
  const visible = report?.findings.filter((f) => filter === 'ALL' || f.severity === filter) ?? []
  const color = (severity: string) =>
    severity === 'ERROR' ? 'var(--lava)' : severity === 'WARNING' ? 'var(--gold)' : 'var(--ink-3)'

  return (
    <section
      aria-label={t.title}
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--line)',
        color: 'var(--ink-2)',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
            {t.title}
          </h3>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-3)', fontSize: 11 }}>{t.subtitle}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={scan.isFetching}
          onClick={() => void scan.refetch()}
        >
          {scan.isFetching ? t.scanning : report ? t.rescan : t.scan}
        </Button>
      </div>
      {scan.isFetching && (
        <p role="status" style={{ margin: '12px 0 0', color: 'var(--accent)' }}>
          {t.progress}
        </p>
      )}
      {scan.isError && (
        <p role="alert" style={{ margin: '12px 0 0', color: 'var(--lava)' }}>
          {t.failed}
        </p>
      )}
      {report && !scan.isFetching && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              padding: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <p role="status" style={{ margin: 0, fontWeight: 600 }}>
              {t.incomplete}
            </p>
            <p style={{ margin: '6px 0 0', color: 'var(--ink-3)', lineHeight: 1.6 }}>
              {t.limitations}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: 10 }}>
              <span>
                <strong>{report.scannedMods}</strong> {t.scanned}
              </span>
              <span style={{ color: color('ERROR') }}>
                <strong>{report.findings.filter((f) => f.severity === 'ERROR').length}</strong>{' '}
                {t.errors}
              </span>
              <span style={{ color: color('WARNING') }}>
                <strong>{report.findings.filter((f) => f.severity === 'WARNING').length}</strong>{' '}
                {t.warnings}
              </span>
            </div>
          </div>
          <div
            role="group"
            aria-label={t.filter}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '10px 0' }}
          >
            {filters.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={filter === item.id ? 'secondary' : 'ghost'}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label} ·{' '}
                {report.findings.filter((f) => item.id === 'ALL' || f.severity === item.id).length}
              </Button>
            ))}
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {visible.length === 0 && (
              <p style={{ color: 'var(--ink-3)', padding: '8px 0', margin: 0 }}>{t.noFindings}</p>
            )}
            {visible.map((finding) => (
              <details
                key={finding.id}
                style={{ borderTop: '1px solid var(--line)', overflowWrap: 'anywhere' }}
              >
                <summary style={{ cursor: 'pointer', padding: '10px 2px', lineHeight: 1.6 }}>
                  <span
                    style={{
                      color: color(finding.severity),
                      fontSize: 10,
                      fontWeight: 700,
                      marginRight: 8,
                    }}
                  >
                    {filters.find((f) => f.id === finding.severity)?.label ?? t.info}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {t.codes[finding.code as keyof typeof t.codes] ?? t.incomplete}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--ink-3)',
                      fontSize: 11,
                      marginLeft: 16,
                    }}
                  >
                    {finding.filename}
                  </span>
                </summary>
                <div style={{ padding: '0 16px 12px', lineHeight: 1.6 }}>
                  <p style={{ margin: '0 0 6px' }}>
                    {finding.code === 'duplicateModId'
                      ? t.duplicateAction
                      : finding.code === 'compatibilityUnverified'
                        ? t.unverifiedAction
                        : t.reviewAction}
                  </p>
                  {finding.evidence && (
                    <p style={{ margin: 0, color: 'var(--ink-3)' }}>
                      {t.evidence}: <code>{finding.evidence}</code>
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
