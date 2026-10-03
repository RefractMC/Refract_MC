import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(tmpdir(), 'refract-renderer-tests-'))
try {
  const compile = spawnSync(
    process.execPath,
    [
      join(renderer, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(renderer, 'tsconfig.test.json'),
      '--outDir',
      output,
    ],
    { stdio: 'inherit', cwd: renderer }
  )
  if (compile.error) throw compile.error
  if (compile.status !== 0) process.exitCode = compile.status ?? 1
  else {
    const tests = readdirSync(join(output, 'tests'))
      .filter((name) => name.endsWith('.test.js'))
      .map((name) => join(output, 'tests', name))
    if (tests.length === 0) throw new Error('No renderer regression tests were compiled.')
    const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
