import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// The renderer test runner uses apps/renderer as its working directory.
const sourceRoot = resolve('src/renderer/src')

test('the radius scale follows the theme value and preserves built-in proportions', () => {
  const css = readFileSync(join(sourceRoot, 'styles/globals.css'), 'utf8')
  const ratios = { xs: 0.5, sm: 0.75, md: 1.25, lg: 1.5, xl: 1.75 }
  assert.match(css, /--radius:\s*8px;/)
  for (const [size, ratio] of Object.entries(ratios)) {
    const declaration = css.match(new RegExp(`--radius-${size}:\\s*([^;]+);`))
    assert.equal(declaration?.[1], `calc(var(--radius) * ${ratio})`, size)
  }
  // Intentional circles/pills must not become square with the surface tokens.
  assert.match(css, /--radius-max:\s*999px;/)
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(css|tsx)$/.test(path) ? [path] : []
  })
}

test('rectangular UI corners do not bypass the theme with fixed pixel radii', () => {
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8')
    // Zero is structural; large values deliberately make pills. Percentage
    // circles and proportional CSS calculations are also intentionally allowed.
    const fixedRadii =
      /(?:border-radius:\s*|borderRadius\s*[:=]\s*['"]?)(\d+(?:\.\d+)?)(?:px)?(?=[;'",\s}])/g
    for (const match of source.matchAll(fixedRadii)) {
      const radius = Number(match[1])
      assert.ok(radius === 0 || radius >= 99, `${file}: fixed radius ${match[0]}`)
    }
    assert.doesNotMatch(source, /<Skeleton\b[^>]*\br=\{\d+\}/, file)
  }
})
