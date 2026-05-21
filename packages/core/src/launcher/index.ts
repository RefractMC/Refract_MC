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

function buildClasspath(ctx: LaunchContext): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const jars: string[] = []
  const allLibs = [...ctx.versionJson.libraries]
  if (ctx.fabricJson) allLibs.push(...ctx.fabricJson.libraries)

  for (const lib of allLibs) {
    if (lib.rules && !ruleApplies(lib.rules)) continue
    if (lib.downloads?.artifact) {
      jars.push(join(ctx.librariesDir, lib.downloads.artifact.path))
    } else if (lib.name && lib.url) {
      jars.push(join(ctx.librariesDir, mavenCoordToPath(lib.name)))
    }
  }

  jars.push(ctx.clientJar)
  return jars.join(sep)
}

export function buildLaunchCommand(ctx: LaunchContext): string[] {
  const mainJson = ctx.fabricJson ?? ctx.versionJson
  const assetIndex = ctx.versionJson.assetIndex.id

  const vars: Record<string, string> = {
    natives_directory: ctx.nativesDir,
    launcher_name: 'Refract',
    launcher_version: '0.4.0',
    classpath: buildClasspath(ctx),
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

  if (mainJson.arguments) {
    jvmArgs = [
      ...jvmBase,
      ...resolveArgs(mainJson.arguments.jvm, vars),
    ]
    gameArgs = resolveArgs(mainJson.arguments.game, vars)
  } else if (mainJson.minecraftArguments) {
    jvmArgs = [
      ...jvmBase,
      '-cp', vars['classpath'],
    ]
    gameArgs = substituteVars(mainJson.minecraftArguments, vars).split(' ')
  } else {
    jvmArgs = [...jvmBase, '-cp', vars['classpath']]
    gameArgs = []
  }

  return [ctx.javaExe, ...jvmArgs, mainJson.mainClass, ...gameArgs]
}
