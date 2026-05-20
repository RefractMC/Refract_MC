import { createWriteStream, existsSync, statSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import https from 'https'
import http from 'http'

export interface DownloadProgress {
  downloaded: number
  total: number
  percent: number
}

function get(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    proto.get(url, { timeout: 30_000 }, resolve).on('error', reject)
  })
}

async function follow(url: string, depth = 0): Promise<http.IncomingMessage> {
  const res = await get(url)
  if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && depth < 5) {
    res.resume()
    const next = res.headers.location
    // Reject http-downgrade redirects from https origins
    if (url.startsWith('https://') && next.startsWith('http://')) {
      throw new Error(`Redirect from https to http rejected: ${next}`)
    }
    return follow(next, depth + 1)
  }
  return res
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return

  mkdirSync(dirname(dest), { recursive: true })

  const res = await follow(url)
  if (res.statusCode && res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} downloading ${url}`)
  }

  const total = parseInt(res.headers['content-length'] ?? '0', 10)
  let downloaded = 0

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)

    res.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      onProgress?.({ downloaded, total, percent: total ? (downloaded / total) * 100 : 0 })
    })

    res.pipe(file)
    file.on('finish', () => file.close(() => resolve()))
    file.on('error', (err) => { file.close(); reject(err) })
    res.on('error', reject)
  })
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await follow(url)
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
