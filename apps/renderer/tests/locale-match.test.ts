import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectLocale,
  isCanonicalLocaleTag,
  matchLocale,
} from '../src/renderer/src/lib/locale-match.js'

const available = ['en', 'uk', 'zh-CN']

test('OS and browser locale tags resolve to the shipped language', () => {
  assert.equal(matchLocale('uk', available), 'uk')
  assert.equal(matchLocale('uk-UA', available), 'uk')
  assert.equal(matchLocale('uk_UA.UTF-8', available), 'uk')
  assert.equal(matchLocale('en-GB', available), 'en')
  assert.equal(matchLocale('EN-us', available), 'en')
})

test('Simplified Chinese tags choose zh-CN and Traditional ones do not', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh_CN.UTF-8']) {
    assert.equal(matchLocale(tag, available), 'zh-CN', tag)
  }
  for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW']) {
    assert.equal(matchLocale(tag, available), null, tag)
  }
})

test('a same-script locale with the same region is preferred', () => {
  assert.equal(matchLocale('pt-BR', ['en', 'pt-PT', 'pt-BR']), 'pt-BR')
  assert.equal(matchLocale('pt-BR', ['en', 'pt-PT']), 'pt-PT')
})

test('a Unicode extension does not stop an exact match', () => {
  assert.equal(matchLocale('en-US-u-hc-h23', ['en', 'en-US']), 'en-US')
  assert.equal(matchLocale('zh-CN-u-nu-hanidec', available), 'zh-CN')
})

test('unsupported and malformed tags fall through to English', () => {
  for (const tag of ['', '  ', 'C', 'POSIX', 'ru', 'not a tag']) {
    assert.equal(matchLocale(tag, available), null, tag)
  }
  assert.equal(detectLocale(['ru-RU', 'zh-TW', 'uk-UA'], available), 'uk')
  assert.equal(detectLocale(['ru-RU', 'de'], available), 'en')
  assert.equal(detectLocale([], available), 'en')
})

test('only canonical BCP 47 file names count as languages', () => {
  for (const id of ['en', 'uk', 'zh-CN', 'pt-BR', 'sr-Latn']) {
    assert.equal(isCanonicalLocaleTag(id), true, id)
  }
  for (const id of ['pt-br', 'zh_CN', 'README', 'en.json', '']) {
    assert.equal(isCanonicalLocaleTag(id), false, id)
  }
})
