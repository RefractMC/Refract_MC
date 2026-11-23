import * as Dialog from '@radix-ui/react-dialog'
import { useMemo } from 'react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import { LOCALE_IDS, localeCoverage, localeNativeName } from '@/i18n/locales'
import { api } from '@/lib/api'
import { useScrollLock } from '@/lib/use-scroll-lock'
import { useLanguageStore } from '@/stores/language'

const TRANSLATION_GUIDE = 'https://github.com/RefractMC/Refract_MC/blob/main/locales/README.md'

export function TranslationStatusDialog({
  onClose,
  onReturnFocus,
}: {
  onClose: () => void
  onReturnFocus: () => void
}) {
  const t = useT()
  const lang = useLanguageStore((state) => state.lang)
  useScrollLock()
  const rows = useMemo(
    () =>
      LOCALE_IDS.map((id) => {
        const { translated, total } = localeCoverage(id)
        return { id, name: localeNativeName(id), ratio: total === 0 ? 0 : translated / total }
      }),
    []
  )
  const percent = useMemo(
    () => new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }),
    [lang]
  )

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" style={{ zIndex: 10004 }} />
        <Dialog.Content
          className="ni-dialog"
          style={{
            zIndex: 10005,
            width: 'min(520px, calc(100vw - 32px))',
            maxHeight: '85vh',
            overflow: 'auto',
            padding: 20,
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onReturnFocus()
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="theme-dialog-title">{t.settings.languageStatus}</Dialog.Title>
          <Dialog.Description className="theme-dialog-subtitle">
            {t.settings.languageStatusNote}
          </Dialog.Description>
          <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--ink-4)', textAlign: 'left' }}>
                <th scope="col" style={{ padding: '6px 12px 6px 0', fontWeight: 600 }}>
                  {t.settings.language}
                </th>
                <th scope="col" style={{ padding: '6px 0', fontWeight: 600, width: '55%' }}>
                  {t.settings.languageCoverage}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ id, name, ratio }) => (
                <tr key={id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '9px 12px 9px 0' }}>
                    <span lang={id} style={{ color: 'var(--ink)', fontSize: 13 }}>
                      {name}
                    </span>
                    <span style={{ color: 'var(--ink-4)', marginLeft: 6 }}>{id}</span>
                  </td>
                  <td style={{ padding: '9px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        aria-hidden
                        style={{
                          flex: 1,
                          height: 4,
                          borderRadius: 'var(--radius-max)',
                          background: 'var(--surface-3)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${ratio * 100}%`,
                            height: '100%',
                            background: 'var(--accent)',
                          }}
                        />
                      </div>
                      <span
                        style={{
                          minWidth: 48,
                          textAlign: 'right',
                          color: 'var(--ink-3)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {percent.format(ratio)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 20,
            }}
          >
            <Button
              variant="ghost"
              onClick={() => {
                void api.external.open(TRANSLATION_GUIDE)
              }}
            >
              {t.settings.helpTranslate}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t.settings.close}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
