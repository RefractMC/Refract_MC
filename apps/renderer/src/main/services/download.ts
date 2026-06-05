import { createWriteStream, existsSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import https from 'https'
import http from 'http'

export interface DownloadProgress {
  downloaded: number
  total: number
  percent: number
}

function get(url: string, signal?: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Install cancelled')); return }
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { timeout: 30_000 }, resolve)
    req.on('error', reject)
    if (signal) {
      const onAbort = () => { req.destroy(); reject(new Error('Install cancelled')) }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function follow(url: string, depth = 0, signal?: AbortSignal): Promise<http.IncomingMessage> {
  const res = await get(url, signal)
  if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && depth < 5) {
    res.resume()
    const next = res.headers.location
    // Reject http-downgrade redirects from https origins
    if (url.startsWith('https://') && next.startsWith('http://')) {
      throw new Error(`Redirect from https to http rejected: ${next}`)
    }
    return follow(next, depth + 1, signal)
  }
  return res
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new Error('Install cancelled')
  if (existsSync(dest) && statSync(dest).size > 0) return

  mkdirSync(dirname(dest), { recursive: true })

  const res = await follow(url, 0, signal)
  if (res.statusCode && res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} downloading ${url}`)
  }

  const total = parseInt(res.headers['content-length'] ?? '0', 10)
  let downloaded = 0

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { res.destroy(); reject(new Error('Install cancelled')); return }

    const file = createWriteStream(dest)

    const onAbort = () => {
      res.destroy()
      file.close()
      try { unlinkSync(dest) } catch { /* ignore */ }
      reject(new Error('Install cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    res.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      onProgress?.({ downloaded, total, percent: total ? (downloaded / total) * 100 : 0 })
    })

    res.pipe(file)
    file.on('finish', () => { cleanup(); file.close(() => resolve()) })
    file.on('error', (err) => { cleanup(); file.close(); reject(err) })
    res.on('error', (err) => { cleanup(); reject(err) })
  })
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await follow(url, 0, signal)
  if (res.statusCode && res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} fetching ${url}`)
  }
  return new Promise((resolve, reject) => {
    let data = ''
    res.on('data', (chunk: Buffer) => { data += chunk.toString() })
    res.on('end', () => {
      try { resolve(JSON.parse(data) as T) } catch (e) { reject(e) }
    })
    res.on('error', reject)
  })
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await follow(url, 0, signal)
  if (res.statusCode && res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} fetching ${url}`)
  }
  return new Promise((resolve, reject) => {
    let data = ''
    res.on('data', (chunk: Buffer) => { data += chunk.toString() })
    res.on('end', () => resolve(data))
    res.on('error', reject)
  })
}
