import { ipcMain, BrowserWindow, nativeImage, shell, dialog } from 'electron'
import { join, basename, dirname } from 'path'
import { readdirSync, statSync, readFileSync, existsSync, rmSync } from 'fs'
import { createConnection } from 'net'
import { spawn } from 'child_process'
import { handleIpc } from './handle'
import { fetchVersionList } from '@refract/core'
import { detectJavaInstallations } from '@refract/core/java-manager'
import { installMinecraft } from '../services/minecraft/downloader'
import { launchInstance, stopInstance, isInstanceRunning } from '../services/minecraft/launcher'
import { resolveInstanceDir } from '../services/instance-store'
import { loadManagedJavas } from '../services/java-manager'

export interface ServerEntry { name: string; ip: string; icon?: string }

function parseServersDat(buf: Buffer): ServerEntry[] {
  let p = 0
  const rb = () => buf.readUInt8(p++)
  const rShort = () => { const v = buf.readUInt16BE(p); p += 2; return v }
  const rInt = () => { const v = buf.readInt32BE(p); p += 4; return v }
  const rStr = () => { const len = rShort(); const s = buf.toString('utf8', p, p + len); p += len; return s }
  function skip(type: number): void {
    if (type === 1) { p++; return }
    if (type === 2) { p += 2; return }
    if (type === 3) { p += 4; return }
    if (type === 4) { p += 8; return }
    if (type === 5) { p += 4; return }
    if (type === 6) { p += 8; return }
    if (type === 7) { p += rInt(); return }
    if (type === 8) { p += rShort(); return }
    if (type === 9) { const et = rb(); const n = rInt(); for (let i = 0; i < n; i++) skip(et); return }
    if (type === 10) { while (true) { const t = rb(); if (t === 0) return; p += rShort(); skip(t) } }
    if (type === 11) { p += rInt() * 4; return }
    if (type === 12) { p += rInt() * 8; return }
  }
  try {
    if (rb() !== 10) return []
    rStr() // root name
    const servers: ServerEntry[] = []
    while (p < buf.length) {
      const type = rb()
      if (type === 0) break
      const key = rStr()
      if (type === 9 && key === 'servers') {
        const et = rb(); const n = rInt()
        if (et !== 10) { for (let i = 0; i < n; i++) skip(et); continue }
        for (let i = 0; i < n; i++) {
          const e: Record<string, string> = {}
          while (p < buf.length) { const ft = rb(); if (ft === 0) break; const fn = rStr(); ft === 8 ? (e[fn] = rStr()) : (ft === 1 ? p++ : skip(ft)) }
          if (e.ip) servers.push({ name: e.name ?? e.ip, ip: e.ip, icon: e.icon })
        }
      } else { skip(type) }
    }
    return servers
  } catch { return [] }
}

function getWorldSizeKb(worldPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(worldPath, { withFileTypes: true })) {
      const p = join(worldPath, entry.name)
      if (entry.isFile()) {
        try { total += statSync(p).size } catch { /* ignore */ }
      } else if (entry.isDirectory()) {
        try {
          for (const sub of readdirSync(p, { withFileTypes: true })) {
            if (sub.isFile()) try { total += statSync(join(p, sub.name)).size } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return Math.round(total / 1024)
}

function zipPath(src: string, dst: string): Promise<void> {
  if (process.platform === 'win32') {
    const esc = (s: string) => s.replace(/'/g, "''")
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -LiteralPath '${esc(src)}' -DestinationPath '${esc(dst)}' -Force`],
        { windowsHide: true })
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Zip failed (${code})`)))
      proc.on('error', reject)
    })
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('zip', ['-r', dst, basename(src)], { cwd: dirname(src) })
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Zip failed (${code})`)))
    proc.on('error', reject)
  })
}

export function registerMinecraftIpc(mainWindow: BrowserWindow): void {
  handleIpc('mc.versions', () => fetchVersionList())

  handleIpc('mc.java', async () => {
    const detected = await detectJavaInstallations()
    const managed = loadManagedJavas()
    const seen = new Set(detected.map(j => j.path))
    return [...detected, ...managed.filter(j => !seen.has(j.path))]
      .sort((a, b) => b.version - a.version)
  })

  handleIpc('mc.isRunning', (_event, instanceId) => isInstanceRunning(String(instanceId)))

  handleIpc('mc.install', async (_event, instanceId, versionId, versionUrl, modLoader, modLoaderVersion) => {
    await installMinecraft(
      String(instanceId),
      String(versionId),
      String(versionUrl),
      modLoader ? String(modLoader) : undefined,
      modLoaderVersion ? String(modLoaderVersion) : undefined,
      (progress) => {
        mainWindow.webContents.send('mc:progress', { instanceId, ...progress })
      }
    )

    // Mark instance as installed
    const instanceStore = await import('../services/instance-store')
    instanceStore.updateInstance(String(instanceId), {
      isInstalled: true,
      modLoaderVersion: modLoaderVersion ? String(modLoaderVersion) : undefined,
    })
  })

  handleIpc('mc.repair', async (_event, instanceId) => {
    const instanceStore = await import('../services/instance-store')
    const instance = instanceStore.getInstanceById(String(instanceId))
    if (!instance) throw new Error(`Instance not found: ${instanceId}`)

    const versions = await fetchVersionList()
    const ver = versions.find(v => v.id === instance.minecraftVersion)
    if (!ver) throw new Error(`Minecraft ${instance.minecraftVersion} not found in Mojang manifest.`)

    await installMinecraft(
      String(instanceId),
      ver.id,
      ver.url,
      instance.modLoader,
      instance.modLoaderVersion,
      (progress) => {
        mainWindow.webContents.send('mc:progress', { instanceId, ...progress })
      }
    )

    instanceStore.updateInstance(String(instanceId), { isInstalled: true })
  })

  handleIpc('mc.launch', (_event, instanceId) =>
    launchInstance(String(instanceId), mainWindow)
  )

  handleIpc('mc.stop', (_event, instanceId) => {
    stopInstance(String(instanceId))
  })

  handleIpc('mc.crashReport', (_event, instanceId) => {
    const crashDir = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'crash-reports')
    if (!existsSync(crashDir)) return null
    const files = readdirSync(crashDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ name: f, mtime: statSync(join(crashDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length === 0) return null
    try { return readFileSync(join(crashDir, files[0].name), 'utf-8') } catch { return null }
  })

  handleIpc('mc.worlds', (_event, instanceId) => {
    const savesDir = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'saves')
    if (!existsSync(savesDir)) return []
    return readdirSync(savesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const worldPath = join(savesDir, e.name)
        const levelDat = join(worldPath, 'level.dat')
        const mtime = existsSync(levelDat) ? statSync(levelDat).mtimeMs : statSync(worldPath).mtimeMs
        return { name: e.name, lastModified: mtime, sizeKb: getWorldSizeKb(worldPath) }
      })
      .sort((a, b) => b.lastModified - a.lastModified)
  })

  handleIpc('mc.deleteWorld', (_event, instanceId, worldName) => {
    const worldPath = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'saves', String(worldName))
    if (existsSync(worldPath)) rmSync(worldPath, { recursive: true, force: true })
  })

  handleIpc('mc.screenshots', (_event, instanceId) => {
    const screenshotsDir = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'screenshots')
    if (!existsSync(screenshotsDir)) return []
    const files = readdirSync(screenshotsDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => {
        const p = join(screenshotsDir, f)
        const s = statSync(p)
        return { filename: f, sizeKb: Math.round(s.size / 1024), timestamp: s.mtimeMs, path: p }
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 24)
    return files.map(({ filename, sizeKb, timestamp, path }) => {
      try {
        const img = nativeImage.createFromPath(path)
        if (img.isEmpty()) return { filename, sizeKb, timestamp, dataUrl: null }
        const resized = img.resize({ width: 320, height: 180 })
        return { filename, sizeKb, timestamp, dataUrl: resized.toDataURL() }
      } catch {
        return { filename, sizeKb, timestamp, dataUrl: null }
      }
    })
  })

  handleIpc('mc.openScreenshot', (_event, instanceId, filename) => {
    const p = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'screenshots', String(filename))
    return shell.openPath(p)
  })

  handleIpc('mc.screenshotFull', (_event, instanceId, filename) => {
    const p = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'screenshots', String(filename))
    try {
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      const scale = Math.min(1, 1920 / width, 1080 / height)
      const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img
      return out.toDataURL()
    } catch { return null }
  })

  handleIpc('mc.backupWorld', async (_event, instanceId, worldName) => {
    const worldPath = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'saves', String(worldName))
    if (!existsSync(worldPath)) throw new Error('World not found')
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Save World Backup',
      defaultPath: `${worldName}-backup.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    })
    if (canceled || !filePath) return null
    await zipPath(worldPath, filePath)
    return filePath
  })

  handleIpc('mc.servers', (_event, instanceId) => {
    const p = join(resolveInstanceDir(String(instanceId)), 'minecraft', 'servers.dat')
    if (!existsSync(p)) return []
    try { return parseServersDat(readFileSync(p)) } catch { return [] }
  })

  handleIpc('mc.pingServer', (_event, rawIp): Promise<{ online: number; max: number; latencyMs: number } | null> => {
    const ip = String(rawIp)
    return new Promise((resolve) => {
      const colonIdx = ip.lastIndexOf(':')
      const host = colonIdx > 0 ? ip.slice(0, colonIdx) : ip
      const port = colonIdx > 0 ? (parseInt(ip.slice(colonIdx + 1), 10) || 25565) : 25565

      function writeVarInt(n: number): Buffer {
        const bytes: number[] = []
        let v = n >>> 0
        while (true) {
          if ((v & ~0x7F) === 0) { bytes.push(v); break }
          bytes.push((v & 0x7F) | 0x80)
          v >>>= 7
        }
        return Buffer.from(bytes)
      }
      function writeString(s: string): Buffer {
        const b = Buffer.from(s, 'utf8')
        return Buffer.concat([writeVarInt(b.length), b])
      }
      function buildPacket(id: number, data?: Buffer): Buffer {
        const idBuf = writeVarInt(id)
        const body = data ? Buffer.concat([idBuf, data]) : idBuf
        return Buffer.concat([writeVarInt(body.length), body])
      }

      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      const handshake = buildPacket(0x00, Buffer.concat([
        writeVarInt(765), writeString(host), portBuf, writeVarInt(1),
      ]))
      const statusReq = buildPacket(0x00)

      const socket = createConnection({ host, port })
      socket.setTimeout(5000)
      const start = Date.now()
      let buf = Buffer.alloc(0)
      let resolved = false

      function done(result: { online: number; max: number; latencyMs: number } | null) {
        if (resolved) return
        resolved = true
        socket.destroy()
        resolve(result)
      }

      socket.on('connect', () => { socket.write(handshake); socket.write(statusReq) })
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        try {
          let offset = 0
          function readVarInt(): number {
            let result = 0, shift = 0
            while (true) {
              if (offset >= buf.length) throw new Error('incomplete')
              const byte = buf[offset++]
              result |= (byte & 0x7F) << shift
              shift += 7
              if (!(byte & 0x80)) return result
            }
          }
          const packetLen = readVarInt()
          if (buf.length < offset + packetLen) return
          const packetId = readVarInt()
          if (packetId === 0x00) {
            const strLen = readVarInt()
            if (buf.length < offset + strLen) return
            const json = JSON.parse(buf.slice(offset, offset + strLen).toString('utf8'))
            done({ online: json.players?.online ?? 0, max: json.players?.max ?? 0, latencyMs: Date.now() - start })
          }
        } catch (e) {
          if ((e as Error).message !== 'incomplete') done(null)
        }
      })
      socket.on('error', () => done(null))
      socket.on('timeout', () => done(null))
    })
  })
}
