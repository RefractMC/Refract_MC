import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTargetValue, PENDING_PREFIX, UNTRANSLATED_PREFIX } from '@shulha/lexmit/runtime'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const native = 'apps/tauri/src-tauri/src'

function leaves(value, prefix = '', result = new Map()) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (entry !== null && typeof entry === 'object') {
      leaves(entry, path, result)
    } else {
      assert.equal(typeof entry, 'string', `${path} must contain text`)
      result.set(path, entry)
    }
  }
  return result
}

// Every file in /locales is a language named by its BCP 47 tag, discovered as the renderer
// discovers it. lexmit requires every value to be a string, so arrays are rejected.
const placeholders = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
function checkShape(fallback, value, path) {
  if (value === undefined) return
  assert.ok(!Array.isArray(value), `${path}: locale values must be strings or objects, not arrays`)
  assert.equal(typeof value, typeof fallback, `${path}: incorrect translation type`)
  if (fallback !== null && typeof fallback === 'object') {
    assert.notEqual(value, null, `${path}: translation cannot be null`)
    for (const [key, entry] of Object.entries(fallback))
      checkShape(entry, value[key], `${path}.${key}`)
  }
}
const englishJson = JSON.parse(read('locales/en.json'))
const english = leaves(englishJson)

// The same rule as tray_label in window_lifecycle.rs. The tray rejects the whole pair when
// one label breaks it and keeps the previous labels, so a bad translation must fail here.
const TRAY_KEYS = ['windowLifecycle.showLauncher', 'windowLifecycle.quitLauncher']
function checkTrayLabel(text, where) {
  const label = text.trim()
  assert.ok(
    label !== '' && [...label].length <= 128 && !/\p{Cc}/u.test(label),
    `${where} must be one line of at most 128 characters for the system tray`
  )
}
for (const key of TRAY_KEYS) checkTrayLabel(english.get(key), `en:${key}`)
for (const [key, text] of english) {
  // English is the source: a marker there would be read as a workflow state in every language.
  assert.ok(
    !text.startsWith(PENDING_PREFIX) && !text.startsWith(UNTRANSLATED_PREFIX),
    `en:${key} must not begin with a translation marker`
  )
}
const locales = readdirSync(join(root, 'locales'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
for (const locale of locales) {
  assert.equal(
    Intl.getCanonicalLocales(locale)[0],
    locale,
    `locales/${locale}.json must be named by a canonical BCP 47 tag`
  )
}
for (const locale of locales.filter((id) => id !== 'en').sort()) {
  const translation = JSON.parse(read(`locales/${locale}.json`))
  checkShape(englishJson, translation, locale)
  const translated = leaves(translation)
  const counts = { accepted: 0, pending: 0, 'untranslated-scaffold': 0 }
  let stalePending = 0
  for (const [key, text] of translated) {
    if (!english.has(key)) continue
    // Throws for a marker with nothing after it, which lexmit would also reject.
    const value = parseTargetValue(text)
    counts[value.kind]++
    if (TRAY_KEYS.includes(key) && value.kind !== 'untranslated-scaffold')
      checkTrayLabel(value.targetText, `${locale}:${key}`)
    // A pending translation may predate an English placeholder change, and a scaffold is
    // English; the runtime shows English for both whenever placeholders disagree.
    const matches = placeholders(text).join() === placeholders(english.get(key)).join()
    if (value.kind === 'pending' && !matches) stalePending++
    if (value.kind !== 'accepted') continue
    assert.deepEqual(
      placeholders(text),
      placeholders(english.get(key)),
      `${locale}:${key} placeholders differ`
    )
  }
  const missing = [...english.keys()].filter((key) => !translated.has(key)).length
  console.log(
    `${locale}: JSON and interpolation valid; ${counts.accepted} accepted, ${counts.pending} to review, ${missing + counts['untranslated-scaffold'] + stalePending} use English fallback`
  )
}

// Check literal command names and the argument objects visible at the facade.
// Spread/computed payloads still require native integration tests and typed IPC.
function splitParameters(signature) {
  let depth = 0
  let start = 0
  const parts = []
  for (let index = 0; index < signature.length; index += 1) {
    const character = signature[index]
    if ('<([{'.includes(character)) depth += 1
    if ('>)]}'.includes(character)) depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(signature.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(signature.slice(start).trim())
  return parts.filter(Boolean)
}

const handlers = read(`${native}/lib.rs`).match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1]
assert.ok(handlers, 'Tauri registration list was not found')
const commands = new Map()
for (const match of handlers.matchAll(/(\w+)::(\w+)/g)) {
  const [, module, name] = match
  const source = read(`${native}/${module}.rs`)
  const signature = source.match(
    new RegExp(`pub\\s+(?:async\\s+)?fn\\s+${name}\\s*\\(([\\s\\S]*?)\\)\\s*(?:->|\\{)`)
  )?.[1]
  assert.notEqual(signature, undefined, `Cannot inspect registered command ${name}`)
  const argumentsByName = new Map()
  for (const parameter of splitParameters(signature)) {
    const [, rustName, type] = parameter.match(/^(?:mut\s+)?(?:r#)?(\w+)\s*:\s*([\s\S]+)$/) ?? []
    assert.ok(rustName, `Cannot inspect argument ${name}: ${parameter}`)
    if (/\b(?:AppHandle|WebviewWindow|Window|State)\b/.test(type)) continue
    const camelCase = rustName.replace(/_([a-z])/g, (_, character) => character.toUpperCase())
    argumentsByName.set(camelCase, /^Option\s*</.test(type))
  }
  commands.set(name, argumentsByName)
}

const facade = read('apps/renderer/src/renderer/src/lib/api.ts')
const ast = ts.createSourceFile('api.ts', facade, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let calls = 0
let fullyChecked = 0
let dynamicPayloads = 0
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'tinvoke'
  ) {
    const [command, payload] = node.arguments
    assert.ok(
      command && ts.isStringLiteral(command),
      'Native facade commands must use a literal name'
    )
    const expected = commands.get(command.text)
    assert.ok(expected, `Unregistered native command: ${command.text}`)
    calls += 1
    const supplied = new Set()
    let complete = payload === undefined || ts.isObjectLiteralExpression(payload)
    if (payload && ts.isObjectLiteralExpression(payload)) {
      for (const property of payload.properties) {
        if (
          ts.isSpreadAssignment(property) ||
          !property.name ||
          ts.isComputedPropertyName(property.name)
        ) {
          complete = false
          continue
        }
        const name = property.name.text
        assert.ok(
          expected.has(name),
          `${command.text}: unexpected argument ${name}; check camelCase spelling`
        )
        supplied.add(name)
      }
    }
    if (complete) {
      for (const [name, optional] of expected) {
        assert.ok(
          optional || supplied.has(name),
          `${command.text}: missing required argument ${name}`
        )
      }
      fullyChecked += 1
    } else dynamicPayloads += 1
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(calls > 0, 'No native facade calls were checked')
console.log(
  `IPC: ${calls} registered calls; ${fullyChecked} complete argument objects checked; ${dynamicPayloads} dynamic payloads need integration coverage`
)
