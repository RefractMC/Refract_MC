import { createFileRoute } from '@tanstack/react-router'
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileKey2,
  PackageOpen,
  ShieldCheck,
  UploadCloud,
} from '@/components/ui/Icon'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Instance } from '@refract/core'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import {
  api,
  type CreatorPublishInput,
  type CreatorPublishResult,
  type CreatorStatus,
} from '@/lib/api'
import './creator.css'

export const Route = createFileRoute('/creator/')({
  component: CreatorPage,
})

type ProjectMode = 'new' | 'existing'
type SideSupport = 'required' | 'optional' | 'unsupported' | 'unknown'
type ReleaseChannel = 'release' | 'beta' | 'alpha'

interface CreatorDraft {
  mode: ProjectMode
  projectId: string
  title: string
  slug: string
  summary: string
  description: string
  categories: string[]
  licenseId: string
  clientSide: SideSupport
  serverSide: SideSupport
  releaseName: string
  versionNumber: string
  versionType: ReleaseChannel
  changelog: string
  featured: boolean
  submitForReview: boolean
}

const DRAFTS_KEY = 'refract.creator.drafts.v1'
const CATEGORY_OPTIONS = [
  'adventure',
  'challenging',
  'combat',
  'kitchen-sink',
  'lightweight',
  'magic',
  'multiplayer',
  'optimization',
  'quests',
  'technology',
]
const LICENSE_OPTIONS = [
  ['MIT', 'MIT'],
  ['Apache-2.0', 'Apache 2.0'],
  ['GPL-3.0-only', 'GPL 3.0'],
  ['LGPL-3.0-only', 'LGPL 3.0'],
  ['MPL-2.0', 'Mozilla Public License 2.0'],
] as const

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function freshDraft(instance?: Instance): CreatorDraft {
  const title = instance?.name ?? ''
  return {
    mode: 'new',
    projectId: '',
    title,
    slug: slugify(title),
    summary: '',
    description: '',
    categories: ['adventure'],
    licenseId: 'MIT',
    clientSide: 'required',
    serverSide: 'optional',
    releaseName: '1.0.0',
    versionNumber: '1.0.0',
    versionType: 'release',
    changelog: '',
    featured: true,
    submitForReview: true,
  }
}

function readDrafts(): Record<string, CreatorDraft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, CreatorDraft>
  } catch {
    return {}
  }
}

function writeDraft(instanceId: string, draft: CreatorDraft): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ ...readDrafts(), [instanceId]: draft }))
  } catch {
    // A draft persistence failure should not block publishing.
  }
}

function titleCase(value: string): string {
  return value.replace(
    /(^|-)([a-z])/g,
    (_, separator: string, letter: string) =>
      `${separator === '-' ? ' ' : ''}${letter.toUpperCase()}`
  )
}

function Field({
  label,
  help,
  children,
  wide,
}: {
  label: string
  help?: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <label className={wide ? 'creator-field creator-field-wide' : 'creator-field'}>
      <span className="creator-label">{label}</span>
      {children}
      {help && <span className="creator-help">{help}</span>}
    </label>
  )
}

function CheckRow({ complete, children }: { complete: boolean; children: React.ReactNode }) {
  return (
    <div className={complete ? 'creator-check complete' : 'creator-check'}>
      <span className="creator-check-icon">{complete && <Check size={13} />}</span>
      <span>{children}</span>
    </div>
  )
}

function CreatorPage() {
  const t = useT()
  const [instances, setInstances] = useState<Instance[]>([])
  const [instancesLoading, setInstancesLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<CreatorDraft>(() => freshDraft())
  const [status, setStatus] = useState<CreatorStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [sourceDeleteWarning, setSourceDeleteWarning] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [progress, setProgress] = useState({ step: '', percent: 0 })
  const [result, setResult] = useState<CreatorPublishResult | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.allSettled([api.instance.list(), api.creator.status()])
      .then(([instancesResult, statusResult]) => {
        if (!active) return

        if (instancesResult.status === 'fulfilled') {
          const installed = instancesResult.value.filter((instance) => instance.isInstalled)
          setInstances(installed)
          const first = installed[0]
          if (first) {
            setSelectedId(first.id)
            setDraft(readDrafts()[first.id] ?? freshDraft(first))
          }
        } else {
          setConnectionError(String(instancesResult.reason))
        }

        if (statusResult.status === 'fulfilled') {
          setStatus(statusResult.value)
        } else {
          setConnectionError(String(statusResult.reason))
        }
      })
      .finally(() => {
        if (active) {
          setInstancesLoading(false)
          setStatusLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => api.creator.onProgress(setProgress), [])

  useEffect(() => {
    if (selectedId) writeDraft(selectedId, draft)
  }, [draft, selectedId])

  const selected = useMemo(
    () => instances.find((instance) => instance.id === selectedId),
    [instances, selectedId]
  )
  const listingComplete =
    draft.mode === 'existing'
      ? draft.projectId.trim().length >= 3
      : draft.title.trim().length >= 3 &&
        draft.slug.trim().length >= 3 &&
        draft.summary.trim().length >= 3 &&
        draft.description.trim().length >= 3 &&
        draft.categories.length > 0
  const releaseComplete =
    draft.releaseName.trim().length > 0 && draft.versionNumber.trim().length > 0
  const canPublish =
    !!status?.connected && !!selected && listingComplete && releaseComplete && !publishing

  function update<K extends keyof CreatorDraft>(key: K, value: CreatorDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function chooseInstance(instanceId: string) {
    setSelectedId(instanceId)
    const instance = instances.find((item) => item.id === instanceId)
    setDraft(readDrafts()[instanceId] ?? freshDraft(instance))
    setResult(null)
    setPublishError(null)
  }

  function toggleCategory(category: string) {
    setDraft((current) => {
      const selectedCategory = current.categories.includes(category)
      if (selectedCategory) {
        return { ...current, categories: current.categories.filter((item) => item !== category) }
      }
      if (current.categories.length >= 3) return current
      return { ...current, categories: [...current.categories, category] }
    })
  }

  async function connect() {
    setConnecting(true)
    setConnectionError(null)
    setSourceDeleteWarning(false)
    try {
      const connection = await api.creator.connectFromFile()
      if (!connection) return
      setStatus(connection.status)
      setSourceDeleteWarning(!connection.sourceDeleted)
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect() {
    try {
      await api.creator.disconnect()
      setStatus({ connected: false })
      setSourceDeleteWarning(false)
      setConnectionError(null)
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error))
    }
  }

  async function publish(event: FormEvent) {
    event.preventDefault()
    if (!canPublish) return
    setPublishing(true)
    setPublishError(null)
    setResult(null)
    setProgress({ step: t.creator.publish, percent: 2 })

    const input: CreatorPublishInput = {
      instanceId: selectedId,
      projectId: draft.mode === 'existing' ? draft.projectId.trim() : undefined,
      project:
        draft.mode === 'new'
          ? {
              slug: draft.slug,
              title: draft.title,
              summary: draft.summary,
              description: draft.description,
              categories: draft.categories,
              clientSide: draft.clientSide,
              serverSide: draft.serverSide,
              licenseId: draft.licenseId,
            }
          : undefined,
      version: {
        name: draft.releaseName,
        versionNumber: draft.versionNumber,
        changelog: draft.changelog,
        versionType: draft.versionType,
        featured: draft.featured,
      },
      submitForReview: draft.mode === 'new' && draft.submitForReview,
    }

    try {
      const published = await api.creator.publish(input)
      setResult(published)
      setDraft((current) => ({ ...current, mode: 'existing', projectId: published.projectId }))
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error))
    } finally {
      setPublishing(false)
    }
  }

  async function copyProjectId() {
    if (!result) return
    await navigator.clipboard.writeText(result.projectId)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <main className="creator-page">
      <header className="creator-header">
        <div>
          <h1>{t.creator.title}</h1>
          <p>{t.creator.subtitle}</p>
        </div>
        <div className={status?.connected ? 'creator-account connected' : 'creator-account'}>
          {statusLoading ? (
            <span>{t.creator.checkingAccount}</span>
          ) : status?.connected ? (
            <>
              {status.avatarUrl ? <img src={status.avatarUrl} alt="" /> : <ShieldCheck size={18} />}
              <span>
                <small>{t.creator.connectedAs}</small>
                <strong>{status.username}</strong>
              </span>
              <button type="button" onClick={() => void disconnect()}>
                {t.creator.disconnect}
              </button>
            </>
          ) : (
            <>
              <FileKey2 size={18} />
              <span>{t.creator.notConnected}</span>
            </>
          )}
        </div>
      </header>

      {!statusLoading && !status?.connected && (
        <section className="creator-connect-panel">
          <div className="creator-connect-icon">
            <ShieldCheck size={28} />
          </div>
          <div>
            <h2>{t.creator.account}</h2>
            <p>{t.creator.tokenIntro}</p>
            <p className="creator-security-note">{t.creator.tokenSafety}</p>
          </div>
          <div className="creator-connect-actions">
            <Button
              variant="outline"
              onClick={() => void api.external.open('https://modrinth.com/settings/pats')}
            >
              {t.creator.createToken}
              <ExternalLink size={14} />
            </Button>
            <Button variant="primary" disabled={connecting} onClick={() => void connect()}>
              <FileKey2 size={15} />
              {connecting ? t.creator.connecting : t.creator.chooseToken}
            </Button>
          </div>
        </section>
      )}

      {(connectionError || sourceDeleteWarning) && (
        <div className="creator-alert" role="alert">
          {connectionError ?? t.creator.sourceDeleteWarning}
        </div>
      )}

      <form className="creator-workspace" onSubmit={publish}>
        <div className="creator-editor">
          <section className="creator-section">
            <div className="creator-section-heading">
              <PackageOpen size={19} />
              <div>
                <h2>{t.creator.pack}</h2>
                <p>{t.creator.packHelp}</p>
              </div>
            </div>
            {instancesLoading ? (
              <div className="creator-skeleton" />
            ) : instances.length === 0 ? (
              <div className="creator-empty">{t.creator.noPacks}</div>
            ) : (
              <div className="creator-pack-row">
                <Field label={t.creator.choosePack}>
                  <select
                    value={selectedId}
                    onChange={(event) => chooseInstance(event.target.value)}
                  >
                    {instances.map((instance) => (
                      <option key={instance.id} value={instance.id}>
                        {instance.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {selected && (
                  <div className="creator-compatibility">
                    <span>{t.creator.compatibility}</span>
                    <strong>{selected.minecraftVersion}</strong>
                    <strong>{selected.modLoader || 'Minecraft'}</strong>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="creator-section">
            <div className="creator-section-heading">
              <UploadCloud size={19} />
              <div>
                <h2>{t.creator.listing}</h2>
                <p>{t.creator.listingHelp}</p>
              </div>
            </div>
            <div className="creator-mode-switch" role="group" aria-label={t.creator.listing}>
              <button
                type="button"
                className={draft.mode === 'new' ? 'active' : ''}
                onClick={() => update('mode', 'new')}
              >
                {t.creator.newProject}
              </button>
              <button
                type="button"
                className={draft.mode === 'existing' ? 'active' : ''}
                onClick={() => update('mode', 'existing')}
              >
                {t.creator.existingProject}
              </button>
            </div>

            {draft.mode === 'existing' ? (
              <div className="creator-form-grid">
                <Field label={t.creator.projectId} help={t.creator.projectIdHelp} wide>
                  <input
                    value={draft.projectId}
                    onChange={(event) => update('projectId', event.target.value)}
                    required
                  />
                </Field>
              </div>
            ) : (
              <div className="creator-form-grid">
                <Field label={t.creator.projectTitle}>
                  <input
                    value={draft.title}
                    onChange={(event) => {
                      const title = event.target.value
                      setDraft((current) => ({
                        ...current,
                        title,
                        slug:
                          current.slug === slugify(current.title) ? slugify(title) : current.slug,
                      }))
                    }}
                    required
                  />
                </Field>
                <Field label={t.creator.projectSlug}>
                  <input
                    value={draft.slug}
                    onChange={(event) => update('slug', slugify(event.target.value))}
                    required
                  />
                </Field>
                <Field label={t.creator.summary} wide>
                  <input
                    value={draft.summary}
                    maxLength={256}
                    onChange={(event) => update('summary', event.target.value)}
                    required
                  />
                </Field>
                <Field label={t.creator.description} wide>
                  <textarea
                    value={draft.description}
                    placeholder={t.creator.descriptionPlaceholder}
                    rows={6}
                    onChange={(event) => update('description', event.target.value)}
                    required
                  />
                </Field>
                <Field label={t.creator.categories} help={t.creator.categoriesHelp} wide>
                  <div className="creator-category-grid">
                    {CATEGORY_OPTIONS.map((category) => (
                      <button
                        type="button"
                        key={category}
                        className={draft.categories.includes(category) ? 'selected' : ''}
                        onClick={() => toggleCategory(category)}
                      >
                        {draft.categories.includes(category) && <Check size={12} />}
                        {titleCase(category)}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t.creator.license}>
                  <select
                    value={draft.licenseId}
                    onChange={(event) => update('licenseId', event.target.value)}
                  >
                    {LICENSE_OPTIONS.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="creator-side-grid">
                  <Field label={t.creator.clientSupport}>
                    <select
                      value={draft.clientSide}
                      onChange={(event) => update('clientSide', event.target.value as SideSupport)}
                    >
                      <option value="required">{t.creator.required}</option>
                      <option value="optional">{t.creator.optional}</option>
                      <option value="unsupported">{t.creator.unsupported}</option>
                      <option value="unknown">{t.creator.unknown}</option>
                    </select>
                  </Field>
                  <Field label={t.creator.serverSupport}>
                    <select
                      value={draft.serverSide}
                      onChange={(event) => update('serverSide', event.target.value as SideSupport)}
                    >
                      <option value="required">{t.creator.required}</option>
                      <option value="optional">{t.creator.optional}</option>
                      <option value="unsupported">{t.creator.unsupported}</option>
                      <option value="unknown">{t.creator.unknown}</option>
                    </select>
                  </Field>
                </div>
              </div>
            )}
          </section>

          <section className="creator-section">
            <div className="creator-section-heading">
              <UploadCloud size={19} />
              <div>
                <h2>{t.creator.release}</h2>
                <p>{t.creator.releaseHelp}</p>
              </div>
            </div>
            <div className="creator-form-grid">
              <Field label={t.creator.releaseName}>
                <input
                  value={draft.releaseName}
                  onChange={(event) => update('releaseName', event.target.value)}
                  required
                />
              </Field>
              <Field label={t.creator.versionNumber}>
                <input
                  value={draft.versionNumber}
                  onChange={(event) => update('versionNumber', event.target.value)}
                  required
                />
              </Field>
              <Field label={t.creator.channel}>
                <select
                  value={draft.versionType}
                  onChange={(event) => update('versionType', event.target.value as ReleaseChannel)}
                >
                  <option value="release">{t.creator.stable}</option>
                  <option value="beta">{t.creator.beta}</option>
                  <option value="alpha">{t.creator.alpha}</option>
                </select>
              </Field>
              <label className="creator-toggle-field">
                <input
                  type="checkbox"
                  checked={draft.featured}
                  onChange={(event) => update('featured', event.target.checked)}
                />
                <span>{t.creator.featured}</span>
              </label>
              <Field label={t.creator.changelog} wide>
                <textarea
                  value={draft.changelog}
                  rows={5}
                  onChange={(event) => update('changelog', event.target.value)}
                />
              </Field>
              {draft.mode === 'new' && (
                <label className="creator-toggle-field creator-field-wide">
                  <input
                    type="checkbox"
                    checked={draft.submitForReview}
                    onChange={(event) => update('submitForReview', event.target.checked)}
                  />
                  <span>{t.creator.submitReview}</span>
                </label>
              )}
            </div>
          </section>
        </div>

        <aside className="creator-review-panel">
          <div className="creator-review-heading">
            <ShieldCheck size={20} />
            <div>
              <h2>{t.creator.review}</h2>
              <p>{t.creator.reviewHelp}</p>
            </div>
          </div>

          {result ? (
            <div className="creator-result">
              <CheckCircle2 size={34} />
              <h3>{t.creator.success}</h3>
              <p>
                {result.projectCreated
                  ? result.submittedForReview
                    ? t.creator.submitted
                    : t.creator.draftCreated
                  : t.creator.versionPublished}
              </p>
              {result.reviewSubmissionError && (
                <p className="creator-result-warning">{result.reviewSubmissionError}</p>
              )}
              <div className="creator-result-id">
                <span>{result.projectId}</span>
                <button type="button" onClick={() => void copyProjectId()}>
                  <Copy size={13} />
                  {copied ? t.creator.copied : t.creator.copyProjectId}
                </button>
              </div>
              <Button variant="primary" onClick={() => void api.external.open(result.projectUrl)}>
                {t.creator.openProject}
                <ExternalLink size={14} />
              </Button>
              <Button variant="ghost" onClick={() => setResult(null)}>
                {t.creator.publishAnother}
              </Button>
            </div>
          ) : publishError ? (
            <div className="creator-publish-error" role="alert">
              <h3>{t.creator.errorTitle}</h3>
              <p>{publishError}</p>
              <Button variant="outline" onClick={() => setPublishError(null)}>
                {t.creator.retry}
              </Button>
            </div>
          ) : (
            <>
              <div className="creator-readiness">
                <CheckRow complete={!!status?.connected}>{t.creator.connectedCheck}</CheckRow>
                <CheckRow complete={!!selected}>{t.creator.packCheck}</CheckRow>
                <CheckRow complete={listingComplete}>{t.creator.listingCheck}</CheckRow>
                <CheckRow complete={releaseComplete}>{t.creator.releaseCheck}</CheckRow>
              </div>
              <div className={canPublish ? 'creator-ready-label ready' : 'creator-ready-label'}>
                {canPublish ? t.creator.ready : t.creator.needsAttention}
              </div>
              {publishing && (
                <div className="creator-progress" aria-live="polite">
                  <div>
                    <span>{progress.step}</span>
                    <strong>{progress.percent}%</strong>
                  </div>
                  <div className="creator-progress-track">
                    <span style={{ width: `${progress.percent}%` }} />
                  </div>
                </div>
              )}
              <Button
                className="creator-publish-button"
                variant="primary"
                size="lg"
                type="submit"
                disabled={!canPublish}
              >
                <UploadCloud size={17} />
                {publishing ? t.creator.publishing : t.creator.publish}
              </Button>
            </>
          )}
        </aside>
      </form>
    </main>
  )
}
