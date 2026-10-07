import assert from 'node:assert/strict'
import test from 'node:test'
import { formatHexAlpha, isDarkColor, parseHexAlpha } from '../src/renderer/src/lib/theme-color.js'

test('theme colors round-trip alpha and keep opaque colors in six-digit form', () => {
  assert.deepEqual(parseHexAlpha('#0f0f1366'), { hex: '#0f0f13', alpha: 0x66 / 255 })
  assert.deepEqual(parseHexAlpha('#abc'), { hex: '#aabbcc', alpha: 1 })
  assert.equal(parseHexAlpha('rgb(0 0 0)'), null)
  assert.equal(formatHexAlpha('#0f0f13', 1), '#0f0f13')
  assert.equal(formatHexAlpha('#0f0f13', 0.4), '#0f0f1366')
})

test('backdrop tint follows the theme background, ignoring its alpha', () => {
  assert.equal(isDarkColor('#0f0f13'), true)
  assert.equal(isDarkColor('#f4f4f800'), false)
  assert.equal(isDarkColor('rgb(255 255 255)'), true)
  assert.equal(isDarkColor(undefined), true)
})
