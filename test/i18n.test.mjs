/**
 * i18n tests — the locale registry (parse/discover/merge) and the `t()`
 * runtime (fallback, interpolation, live switch), plus the three coverage
 * guards that keep the language files honest:
 *
 *   1. every `t('…')` literal in src/ has its key in `locales/en.json`
 *      (and vice versa — no orphan catalog entries),
 *   2. every bundled locale carries exactly en.json's key set,
 *   3. every bundled locale's `{param}` placeholders match en.json per key.
 *
 * Guard 1 is what lets extraction land file-by-file without silent drift:
 * an en value must reproduce the pre-i18n literal byte-for-byte, and a call
 * site whose key never made it into the catalog fails here instead of
 * rendering the raw key to users.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinLocalesDir, discoverLocales, parseLocaleFile, scanLocaleDir, userLocalesDir } from '../lib/i18n/registry.js'
import { currentLocale, initI18n, listLocales, setLocale, t } from '../lib/i18n/index.js'

function readBundledLocale(id) {
  return JSON.parse(readFileSync(join(builtinLocalesDir(), `${id}.json`), 'utf8'))
}

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(path, out)
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** All `t('…')` / `t("…")` literal keys referenced across the src/ .ts files. */
function referencedKeys() {
  const keys = new Set()
  for (const file of listSourceFiles(join(import.meta.dirname, '..', 'src'))) {
    // Skip comment lines (`//`-lines and `*`-continuations of block docs) —
    // prose may mention `t('…')` without being a call site.
    const source = readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => { const s = line.trimStart(); return !s.startsWith('//') && !s.startsWith('*') })
      .join('\n')
    for (const match of source.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1/g)) {
      keys.add(match[2])
    }
  }
  return keys
}

test('parseLocaleFile: valid file yields name + strings', () => {
  const parsed = parseLocaleFile('{"name":"Français","a.b":"bonjour"}', 'test.json')
  assert.equal(parsed.name, 'Français')
  assert.deepEqual(parsed.strings, { 'a.b': 'bonjour' })
})

test('parseLocaleFile: invalid input rejects with the source and key', () => {
  assert.throws(() => parseLocaleFile('not json', 'x.json'), /x\.json/)
  assert.throws(() => parseLocaleFile('[]', 'x.json'), /must be a JSON object/)
  assert.throws(() => parseLocaleFile('{"a":"b"}', 'x.json'), /"name"/)
  assert.throws(() => parseLocaleFile('{"name":"n","a":1}', 'x.json'), /"a"/)
  assert.throws(() => parseLocaleFile('{"name":"n","a":""}', 'x.json'), /"a"/)
  assert.throws(() => parseLocaleFile('{"name":"n","a":{"b":"c"}}', 'x.json'), /"a"/)
})

test('scanLocaleDir: keys by file id, skips invalid files fail-open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-i18n-'))
  writeFileSync(join(dir, 'fr.json'), '{"name":"Français","k":"v"}')
  writeFileSync(join(dir, 'broken.json'), '{nope')
  writeFileSync(join(dir, 'notes.txt'), 'ignored')
  const scanned = scanLocaleDir(dir, () => {})
  assert.deepEqual([...scanned.keys()].sort(), ['fr'])
  assert.equal(scanned.get('fr').name, 'Français')
})

test('discoverLocales: user file merges per-key over bundled and new ids register', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-i18n-home-'))
  mkdirSync(userLocalesDir(home), { recursive: true })
  // Same id as the bundled zh-CN: override one key, keep the rest.
  writeFileSync(
    join(userLocalesDir(home), 'zh-CN.json'),
    JSON.stringify({ name: '简体中文（定制）', 'command.language.unknown': '不认识的语言：{id}' }),
  )
  // A brand-new language: registers without any bundled twin.
  writeFileSync(join(userLocalesDir(home), 'ko.json'), '{"name":"한국어","greet":"안녕"}')
  const merged = discoverLocales({ home, warn: () => {} })
  const zh = merged.get('zh-CN')
  assert.equal(zh.name, '简体中文（定制）')
  assert.equal(zh.strings['command.language.unknown'], '不认识的语言：{id}')
  // The bundled twin's other keys survive the per-key merge.
  assert.equal(typeof zh.strings['command.language.description'], 'string')
  assert.equal(merged.get('ko').strings.greet, '안녕')
})

test('t(): falls back active → en → key, and interpolates {params}', () => {
  initI18n({})
  // With the real bundled catalog, en resolves through en.json.
  assert.equal(t('settings.maxAgents.description').includes('subagents'), true)
  // Missing everywhere → the key itself (visible programming error).
  assert.equal(t('totally.missing.key'), 'totally.missing.key')
  // Interpolation replaces known params and leaves unknown ones visible.
  setLocale('en')
  assert.equal(t('command.language.unknown', { id: 'xx', list: 'a, b' }), 'Unknown language "xx". Installed: a, b')
  assert.equal(t('command.language.unknown'), 'Unknown language "{id}". Installed: {list}')
})

test('t(): live switch to zh-CN translates, setLocale of an unknown id keeps current', () => {
  initI18n({})
  assert.equal(setLocale('zh-CN'), true)
  assert.equal(t('settings.maxAgents.description'), '子代理并发上限（0 = 不限）')
  assert.equal(setLocale('xx-NOPE'), false)
  assert.equal(currentLocale().id, 'zh-CN')
  setLocale('en')
})

test('listLocales: bundled catalog exposes en and zh-CN with display names', () => {
  initI18n({})
  const ids = listLocales().map(locale => locale.id)
  assert.equal(ids.includes('en'), true)
  assert.equal(ids.includes('zh-CN'), true)
  assert.equal(listLocales().find(locale => locale.id === 'zh-CN').name, '简体中文')
})

// ---------------------------------------------------------------- coverage guards --

test('coverage: every t() literal in src/ exists in en.json, and en.json has no orphans', () => {
  const catalog = readBundledLocale('en')
  const catalogKeys = new Set(Object.keys(catalog).filter(key => key !== 'name'))
  const referenced = referencedKeys()
  const missingInCatalog = [...referenced].filter(key => !catalogKeys.has(key))
  assert.deepEqual(
    missingInCatalog.sort(),
    [],
    `t() call sites with no en.json entry — add them to locales/en.json`,
  )
  const orphanKeys = [...catalogKeys].filter(key => !referenced.has(key))
  assert.deepEqual(
    orphanKeys.sort(),
    [],
    `en.json entries no t() call site references — remove them or use t('…') literally`,
  )
})

test('coverage: every bundled locale carries exactly en.json\u2019s key set', () => {
  const catalog = readBundledLocale('en')
  const expected = new Set(Object.keys(catalog).filter(key => key !== 'name'))
  for (const file of readdirSync(builtinLocalesDir())) {
    if (!file.endsWith('.json') || file === 'en.json') continue
    const locale = JSON.parse(readFileSync(join(builtinLocalesDir(), file), 'utf8'))
    const keys = new Set(Object.keys(locale).filter(key => key !== 'name'))
    const missing = [...expected].filter(key => !keys.has(key))
    const extra = [...keys].filter(key => !expected.has(key))
    assert.deepEqual(extra.sort(), [], `${file}: keys not present in en.json`)
    assert.deepEqual(missing.sort(), [], `${file}: missing translations for en.json keys`)
  }
})

test('coverage: bundled locales keep en.json\u2019s {param} placeholders per key', () => {
  const placeholders = text => new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))
  const catalog = readBundledLocale('en')
  for (const file of readdirSync(builtinLocalesDir())) {
    if (!file.endsWith('.json') || file === 'en.json') continue
    const locale = JSON.parse(readFileSync(join(builtinLocalesDir(), file), 'utf8'))
    for (const [key, value] of Object.entries(locale)) {
      if (key === 'name') continue
      assert.deepEqual(
        [...placeholders(value)].sort(),
        [...placeholders(catalog[key] ?? '')].sort(),
        `${file}:${key}: {param} set diverges from en.json`,
      )
    }
  }
})
