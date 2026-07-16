import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { useT } from '@/i18n'

type NewsItem = Awaited<ReturnType<typeof api.news.list>>[number]

export const Route = createFileRoute('/news/')({
  component: MinecraftNewsPage,
})

function MinecraftNewsPage() {
  const t = useT()
  const [items, setItems] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await api.news.list())
    } catch (err) {
      setItems([])
      setError(err instanceof Error ? err.message : t.news.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function openArticle(url: string) {
    try {
      await api.news.open(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.news.openFailed)
    }
  }

  return (
    <div className="library-dashboard">
      <div className="library-hero">
        <div>
          <div className="library-kicker">{t.news.kicker}</div>
          <h1 className="library-title">{t.news.title}</h1>
          <div className="library-subtitle">
            {t.news.subtitle}
          </div>
        </div>
        <button
          onClick={() => { void load() }}
          disabled={loading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--border-r)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 8,
            padding: '9px 12px',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          <RefreshCw size={15} />
          {t.news.refresh}
        </button>
      </div>

      {error && (
        <div className="launcher-panel" style={{ padding: '12px 14px', marginBottom: 14, color: 'var(--gold)' }}>
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="launcher-panel" style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--ink-4)' }}>
          {t.news.loading}
        </div>
      ) : items.length === 0 ? (
        <div className="launcher-panel" style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--ink-4)' }}>
          {t.news.empty}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {items.map(item => (
            <article key={item.url} className="launcher-panel" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ aspectRatio: '16 / 9', background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', overflow: 'hidden' }}>
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.title}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4)' }}>
                    <Newspaper size={28} />
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 14px', flex: 1 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.35 }}>
                    {item.title}
                  </div>
                  {item.publishedAt && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ink-4)' }}>
                      {item.publishedAt}
                    </div>
                  )}
                </div>

                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-3)' }}>
                  {item.summary}
                </div>

                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => { void openArticle(item.url) }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      border: '1px solid var(--border-r)',
                      background: 'var(--surface-2)',
                      color: 'var(--ink)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <ExternalLink size={14} />
                    {t.news.readArticle}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{t.news.source}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
