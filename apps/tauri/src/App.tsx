import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Check, MemoryStick, Palette, Boxes, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { configApi, instancesApi, downloadApi, type AppConfig, type InstanceSummary, type DownloadProgress } from './tauri-api'

const DEMO_URL = 'https://libraries.minecraft.net/com/google/guava/guava/31.1-jre/guava-31.1-jre.jar'

// POC harness: exercises the Rust `config_get` / `config_set` commands end-to-end
// through shadcn/ui + Tailwind, proving the full Tauri + frontend stack.
export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [url, setUrl] = useState(DEMO_URL)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const unlistenRef = useRef<(() => void) | null>(null)

  // Subscribe to the Rust progress events for the lifetime of the component.
  useEffect(() => {
    downloadApi.onProgress(setProgress).then(un => { unlistenRef.current = un })
    return () => { unlistenRef.current?.() }
  }, [])

  async function startDownload() {
    setDownloading(true)
    setSavedPath(null)
    setProgress(null)
    try { setSavedPath(await downloadApi.start(url)) }
    catch (e) { setError(String(e)) }
    finally { setDownloading(false) }
  }

  async function reload() {
    try {
      const [cfg, list] = await Promise.all([configApi.get(), instancesApi.list()])
      setConfig(cfg)
      setInstances(list)
      setError(null)
    } catch (e) { setError(String(e)) }
  }

  useEffect(() => { void reload() }, [])

  async function set(key: string, value: unknown) {
    setBusy(true)
    try { setConfig(await configApi.set(key, value)); setError(null) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen p-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Refract <span className="text-primary">· Tauri POC</span>
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            shadcn/ui + Tailwind v4, talking to a Rust command over <code className="text-foreground">invoke()</code>.
          </p>
        </div>

        {error && (
          <div className="border-destructive text-destructive rounded-md border bg-destructive/10 px-4 py-2.5 text-sm">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>config.json</CardTitle>
            <CardDescription>
              Read &amp; written by Rust at the same path the Electron app uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={reload} disabled={busy}>
                <RefreshCw /> Reload
              </Button>
              <Button size="sm" onClick={() => set('onboardingDone', !config?.onboardingDone)} disabled={busy}>
                <Check /> Toggle onboardingDone
              </Button>
              <Button variant="secondary" size="sm" onClick={() => set('defaultMemoryMb', (Number(config?.defaultMemoryMb) || 2048) + 1024)} disabled={busy}>
                <MemoryStick /> +1024 MB
              </Button>
              <Button variant="secondary" size="sm" onClick={() => set('activeThemeId', config?.activeThemeId === 'dark' ? 'light' : 'dark')} disabled={busy}>
                <Palette /> Flip theme
              </Button>
            </div>

            <pre className="bg-muted text-muted-foreground max-h-[40vh] overflow-auto rounded-lg p-4 font-mono text-xs leading-relaxed">
              {config ? JSON.stringify(config, null, 2) : 'Loading…'}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Boxes className="size-4" /> Instances</CardTitle>
            <CardDescription>
              Read by Rust from <code className="text-foreground">{'<data>/instances'}</code> — the same data the Electron app shows.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {instances == null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : instances.length === 0 ? (
              <p className="text-muted-foreground text-sm">No instances found yet — create one in the Electron app, then Reload.</p>
            ) : (
              instances.map(inst => (
                <div key={inst.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <span className={`size-2 rounded-full ${inst.isInstalled ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  <span className="font-medium">{inst.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">MC {inst.minecraftVersion}</span>
                  {inst.modLoader && (
                    <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-xs uppercase">{inst.modLoader}</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs">{inst.isInstalled ? 'installed' : 'not installed'}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Download className="size-4" /> Streaming download</CardTitle>
            <CardDescription>
              Rust streams the file with <code className="text-foreground">reqwest</code> and emits <code className="text-foreground">download://progress</code> events — the pattern every install/launch screen uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              spellCheck={false}
              className="border-input bg-background h-9 rounded-md border px-3 font-mono text-xs outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={startDownload} disabled={downloading}>
                <Download /> {downloading ? 'Downloading…' : 'Download'}
              </Button>
              {progress && (
                <span className="text-muted-foreground font-mono text-xs">
                  {Math.round(progress.percent)}% · {(progress.downloaded / 1048576).toFixed(1)} / {(progress.total / 1048576).toFixed(1)} MB
                </span>
              )}
            </div>
            <div className="bg-muted h-2 overflow-hidden rounded-full">
              <div className="bg-primary h-full transition-all" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            {savedPath && <p className="text-muted-foreground text-xs">Saved to <code className="text-foreground">{savedPath}</code></p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
