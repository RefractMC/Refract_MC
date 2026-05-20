import { join } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { paths } from '../paths'
import { getConfig } from '../config'
import type { VersionJson } from '@refract/core'
import { buildLaunchCommand } from '@refract/core/launcher'
import { detectJavaInstallations } from '@refract/core/java-manager'
import { versionJsonPath, clientJarPath, nativesDir } from './downloader'

const runningProcesses = new Map<string, ChildProcess>()

function readVersionJson(versionId: string): VersionJson | null {
  const p = versionJsonPath(versionId)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) as VersionJson } catch { return null }
}

function readFabricJson(versionId: string): VersionJson | null {
  const p = join(paths.versions, `${versionId}-fabric`, `${versionId}-fabric.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) as VersionJson } catch { return null }
}

function readForgeJson(versionId: string): VersionJson | null {
  const p = join(paths.versions, `${versionId}-forge`, `${versionId}-forge.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) as VersionJson } catch { return null }
}

async function resolveJava(requiredMajor: number, instanceJavaPath?: string): Promise<string> {
  if (instanceJavaPath) {
    // Accept full exe path or JDK home dir
    if (existsSync(instanceJavaPath)) return instanceJavaPath
    const exeWin  = join(instanceJavaPath, 'bin', 'java.exe')
    if (existsSync(exeWin)) return exeWin
    const exeUnix = join(instanceJavaPath, 'bin', 'java')
    if (existsSync(exeUnix)) return exeUnix
  }

  const installs = await detectJavaInstallations()

  // Try to find matching major version
  const match = installs.find(j => j.version >= requiredMajor) ?? installs[0]
  if (match) {
    const exe = join(match.path, 'bin', 'java.exe')
    if (existsSync(exe)) return exe
    const exeUnix = join(match.path, 'bin', 'java')
    if (existsSync(exeUnix)) return exeUnix
  }

  return 'java' // fall back to PATH
}

export async function launchInstance(
  instanceId: string,
  mainWindow: BrowserWindow
): Promise<void> {
  if (runningProcesses.has(instanceId)) {
    throw new Error('Instance is already running.')
  }

  const fullConfig = getConfig()
  const account = fullConfig.accounts.find(a => a.uuid === fullConfig.activeAccountId)
  if (!account) throw new Error('No active account. Please sign in first.')

  const instanceStore = await import('../instance-store')
  const instance = instanceStore.getInstanceById(instanceId)
  if (!instance) throw new Error(`Instance not found: ${instanceId}`)
  if (!instance.isInstalled) throw new Error('Minecraft is not installed for this instance.')

  const versionJson = readVersionJson(instance.minecraftVersion)
  if (!versionJson) throw new Error('Version JSON missing. Please reinstall.')

  const isForge = instance.modLoader === 'forge' || instance.modLoader === 'neoforge'
  const fabricJson = instance.modLoader === 'fabric'
    ? readFabricJson(instance.minecraftVersion)
    : isForge
      ? readForgeJson(instance.minecraftVersion)
      : undefined

  const requiredJava = versionJson.javaVersion?.majorVersion ?? 8
  const javaExe = await resolveJava(requiredJava, instance.javaPath)

  const gameDir = join(paths.instances, instanceId, 'minecraft')
  mkdirSync(join(gameDir, 'mods'), { recursive: true })
  mkdirSync(join(gameDir, 'saves'), { recursive: true })

  const { safeStorage } = await import('electron')
  let accessToken = 'offline'
  if (account.encryptedAccessToken) {
    try {
      const raw = account.encryptedAccessToken
      if (raw.startsWith('b64:')) {
        accessToken = Buffer.from(raw.slice(4), 'base64').toString('utf8')
      } else if (safeStorage.isEncryptionAvailable()) {
        accessToken = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      }
    } catch { /* use offline */ }
  }

  const cmd = buildLaunchCommand({
    versionId: instance.minecraftVersion,
    versionJson,
    fabricJson: fabricJson ?? undefined,
    librariesDir: paths.libraries,
    assetsDir: paths.assets,
    nativesDir: nativesDir(instanceId),
    gameDir,
    clientJar: clientJarPath(instance.minecraftVersion),
    javaExe,
    memoryMb: instance.memoryMb,
    auth: {
      username: account.username,
      uuid: account.uuid,
      accessToken,
      userType: account.type === 'microsoft' ? 'msa' : 'legacy',
    },
  })

  const [exe, ...args] = cmd
  const proc = spawn(exe, args, {
    cwd: gameDir,
    detached: false,
  })

  runningProcesses.set(instanceId, proc)

  // Record last played
  instanceStore.updateInstance(instanceId, { lastPlayed: new Date().toISOString() })

  proc.stdout?.on('data', (data: Buffer) => {
    mainWindow.webContents.send('mc:log', { instanceId, line: data.toString(), stream: 'stdout' })
  })
  proc.stderr?.on('data', (data: Buffer) => {
    mainWindow.webContents.send('mc:log', { instanceId, line: data.toString(), stream: 'stderr' })
  })
  proc.on('exit', (code) => {
    runningProcesses.delete(instanceId)
    mainWindow.webContents.send('mc:exit', { instanceId, code })
  })
  proc.on('error', (err) => {
    runningProcesses.delete(instanceId)
    mainWindow.webContents.send('mc:exit', { instanceId, code: -1, error: err.message })
  })
}

export function stopInstance(instanceId: string): void {
  const proc = runningProcesses.get(instanceId)
  if (proc) {
    proc.kill()
    runningProcesses.delete(instanceId)
  }
}

export function isInstanceRunning(instanceId: string): boolean {
  return runningProcesses.has(instanceId)
}
