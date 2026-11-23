import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCALE_STORAGE_KEY,
  MESSAGES,
  detectInitialLocale,
  getMessages,
} from '../src/i18n.ts'

function collectLeafStrings(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof obj === 'string') {
    out.set(prefix, obj)
    return out
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const nextKey = prefix ? `${prefix}.${k}` : k
      for (const [leafKey, leafVal] of collectLeafStrings(v, nextKey)) {
        out.set(leafKey, leafVal)
      }
    }
  }
  return out
}

test('MESSAGES.en and MESSAGES.zh define matching keys with non-empty UI labels', () => {
  const enLeaves = collectLeafStrings(MESSAGES.en)
  const zhLeaves = collectLeafStrings(MESSAGES.zh)

  assert.equal(enLeaves.size, zhLeaves.size)
  for (const [key, val] of enLeaves) {
    assert.ok(val.trim().length > 0, `English key ${key} must be non-empty`)
    const zhVal = zhLeaves.get(key)
    assert.equal(typeof zhVal, 'string', `Missing Simplified Chinese key ${key}`)
    assert.ok((zhVal ?? '').trim().length > 0, `Chinese key ${key} must be non-empty`)
  }
  assert.equal(getMessages('en'), MESSAGES.en)
  assert.equal(getMessages('zh'), MESSAGES.zh)
})

test('detectInitialLocale honors persisted preference, navigator language, and SSR fallbacks', () => {
  const storageEn = {
    getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? 'en' : null),
  }
  const storageZh = {
    getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? 'zh' : null),
  }
  const emptyStorage = {
    getItem: () => null,
  }

  assert.equal(detectInitialLocale({ storage: storageEn, navigatorLanguage: 'zh-CN' }), 'en')
  assert.equal(detectInitialLocale({ storage: storageZh, navigatorLanguage: 'en-US' }), 'zh')
  assert.equal(detectInitialLocale({ storage: emptyStorage, navigatorLanguage: 'zh-CN' }), 'zh')
  assert.equal(detectInitialLocale({ storage: emptyStorage, navigatorLanguage: 'zh-TW' }), 'zh')
  assert.equal(detectInitialLocale({ storage: emptyStorage, navigatorLanguage: 'en-US' }), 'en')
  assert.equal(detectInitialLocale({ storage: null, navigatorLanguage: null }), 'en')
})
