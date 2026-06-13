import { join } from 'path'
import type { VersionJson, LibraryRule } from '../version-manager/index'

export interface LaunchContext {
  versionId: string
  versionJson: VersionJson
  fabricJson?: VersionJson
  librariesDir: string
  assetsDir: string
  nativesDir: string
  gameDir: string
  clientJar: string
  javaExe: string
  memoryMb: number
  javaArgs?: string
  auth: {
    username: string
    uuid: string
    accessToken: string
    xuid: string
    clientId: string
    userType: 'msa' | 'legacy'
  }
}

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'

function mavenCoordToPath(name: string): string {
  const parts = name.split(':')
  const [group, artifact, version, classifierExt] = parts
  const groupPath = group.replace(/\./g, '/')
  let fname: string
  if (classifierExt) {
    const [classifier, ext] = classifierExt.split('@')
    fname = `${artifact}-${version}-${classifier}.${ext ?? 'jar'}`
  } else {
    fname = `${artifact}-${version}.jar`
  }
  return join(groupPath, artifact, version, fname)
}

// Features we support — anything not listed here defaults to false
const LAUNCHER_FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
}

function ruleApplies(rules: LibraryRule[]): boolean {
  if (!rules.length) return true
  let result = false
  for (const r of rules) {
    const osMatch = !r.os?.name || r.os.name === OS_NAME
    const featuresMatch = !r.features || Object.entries(r.features).every(
      ([k, v]) => (LAUNCHER_FEATURES[k] ?? false) === v
    )
    if (osMatch && featuresMatch) result = r.action === 'allow'
  }
  return result
}

function resolveArgs(
  args: Array<string | { rules: LibraryRule[]; value: string | string[] }>,
  vars: Record<string, string>
): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') {
      out.push(substituteVars(arg, vars))
    } else if (ruleApplies(arg.rules)) {
      const values = Array.isArray(arg.value) ? arg.value : [arg.value]
      for (const v of values) out.push(substituteVars(v, vars))
    }
  }
  return out
}

function substituteVars(str: string, vars: Record<string, string>): string {
  return str.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? `\${${key}}`)
}

// "group:artifact:version[:classifier@ext]" → "group:artifact[:classifier]".
// Dropping the version lets us detect two libraries that are the same artifact
// at different versions; keeping the classifier prevents a natives jar (e.g.
// lwjgl:natives-windows) from collapsing onto its plain counterpart.
function mavenKey(name: string): string {
  const [group, artifact, , classifierExt] = name.split(':')
  const classifier = classifierExt ? classifierExt.split('@')[0] : ''
  return classifier ? `${group}:${artifact}:${classifier}` : `${group}:${artifact}`
}

function buildClasspath(ctx: LaunchContext): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const allLibs = [...ctx.versionJson.libraries]
  if (ctx.fabricJson) allLibs.push(...ctx.fabricJson.libraries)

  // Dedupe by maven group:artifact(:classifier) so a vanilla library and a
  // loader-overlay library that ship different versions of the same artifact
  // (ASM, log4j, guava…) don't both land on the classpath — duplicates make the
  // JVM resolve whichever appears first, which silently broke older Forge. The
  // overlay is appended after vanilla, so the later set() wins: the loader's
  // chosen version replaces vanilla's while keeping its classpath position.
  const jars = new Map<string, string>()
  for (const lib of allLibs) {
    if (lib.rules && !ruleApplies(lib.rules)) continue
    let jarPath: string
    if (lib.downloads?.artifact) {
      jarPath = join(ctx.librariesDir, lib.downloads.artifact.path)
    } else if (lib.url) {
      jarPath = join(ctx.librariesDir, mavenCoordToPath(lib.name))
    } else {
      continue
    }
    jars.set(mavenKey(lib.name), jarPath)
  }

  return [...jars.values(), ctx.clientJar].join(sep)
}

export function buildLaunchCommand(ctx: LaunchContext): string[] {
  const mainJson = ctx.fabricJson ?? ctx.versionJson
  const assetIndex = ctx.versionJson.assetIndex.id

  const sep = process.platform === 'win32' ? ';' : ':'
  const vars: Record<string, string> = {
    natives_directory: ctx.nativesDir,
    launcher_name: 'Refract',
    launcher_version: '0.4.0',
    classpath: buildClasspath(ctx),
    library_directory: ctx.librariesDir,
    classpath_separator: sep,
    auth_player_name: ctx.auth.username,
    version_name: ctx.versionId,
    game_directory: ctx.gameDir,
    assets_root: ctx.assetsDir,
    assets_index_name: assetIndex,
    auth_uuid: ctx.auth.uuid.replace(/-/g, ''),
    auth_access_token: ctx.auth.accessToken,
    auth_xuid: ctx.auth.xuid,
    user_type: ctx.auth.userType,
    version_type: 'release',
    resolution_width: '854',
    resolution_height: '480',
    clientid: ctx.auth.clientId,
  }

  const jvmBase = [
    `-Xmx${ctx.memoryMb}m`,
    `-Xms${Math.floor(ctx.memoryMb / 2)}m`,
    `-Djava.library.path=${ctx.nativesDir}`,
    '-Dminecraft.launcher.brand=Refract',
    '-Dminecraft.launcher.version=0.4.0',
  ]

  let jvmArgs: string[]
  let gameArgs: string[]

  // Fabric/Forge JSONs are overlays — they extend vanilla args, not replace them.
  // Always build from versionJson args, then append the overlay's extra args.
  const baseJson = ctx.versionJson
  const overlayJson = ctx.fabricJson !== ctx.versionJson ? ctx.fabricJson : undefined

  if (baseJson.arguments) {
    const baseJvm  = resolveArgs(baseJson.arguments.jvm, vars)
    const extraJvm = overlayJson?.arguments ? resolveArgs(overlayJson.arguments.jvm, vars) : []
    jvmArgs = [...jvmBase, ...baseJvm, ...extraJvm]

    const baseGame  = resolveArgs(baseJson.arguments.game, vars)
    const extraGame = overlayJson?.arguments ? resolveArgs(overlayJson.arguments.game, vars) : []
    gameArgs = [...baseGame, ...extraGame]
  } else if (baseJson.minecraftArguments) {
    jvmArgs = [...jvmBase, '-cp', vars['classpath']]
    gameArgs = substituteVars(baseJson.minecraftArguments, vars).split(' ')
  } else {
    jvmArgs = [...jvmBase, '-cp', vars['classpath']]
    gameArgs = []
  }

  const extraJvmArgs = ctx.javaArgs ? ctx.javaArgs.trim().split(/\s+/).filter(Boolean) : []
  return [ctx.javaExe, ...jvmArgs, ...extraJvmArgs, mainJson.mainClass, ...gameArgs]
}
