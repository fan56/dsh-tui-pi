// Upsert keys into a settings entry's config inside the active profile's
// cordis.patch.yml (the only durable settings store since dsh 0.1.7-rc.1
// removed the ~/.dsh/settings.yaml sections — see dsh-settings'
// importLegacyDocument). Structured YAML edit, NOT text surgery: the patch
// file is a top-level array of loader patch entries and may already carry
// other rows (e.g. the llm entry a previous scenario's /login committed).
//
// Usage:
//   node patch-setting.mjs <entryId> key=value [key=value ...]
//
// The yaml module is resolved from the container's global dsh closure (same
// nested-or-flat probe as the persistence seeder in 66-retention-resume.sh).
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [entryId, ...pairs] = process.argv.slice(2)
if (!entryId || pairs.length === 0) {
  console.error('usage: patch-setting.mjs <entryId> key=value [key=value ...]')
  process.exit(2)
}

const NPM_GLOBAL_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh'
const CANDIDATES = [
  join(NPM_GLOBAL_ROOT, 'package.json'),
]
const base = CANDIDATES.find(existsSync)
if (!base) {
  console.error(`patch-setting: global dsh closure not found at ${NPM_GLOBAL_ROOT}`)
  process.exit(1)
}
const { parse, stringify } = createRequire(base)('yaml')

const patchPath = join(homedir(), '.dsh', 'profiles', 'tui', 'cordis.patch.yml')
let doc
try {
  doc = parse(await readFile(patchPath, 'utf8')) ?? []
} catch {
  doc = []
}
if (!Array.isArray(doc)) {
  console.error(`patch-setting: ${patchPath} is not a top-level YAML array`)
  process.exit(1)
}

let row = doc.find(entry => entry && entry.id === entryId && entry.insert === undefined)
if (!row) {
  row = { id: entryId, config: {} }
  doc.push(row)
}
if (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) row.config = {}
for (const pair of pairs) {
  const eq = pair.indexOf('=')
  if (eq <= 0) {
    console.error(`patch-setting: bad pair '${pair}' (expected key=value)`)
    process.exit(2)
  }
  const [key, raw] = [pair.slice(0, eq), pair.slice(eq + 1)]
  row.config[key] = parse(raw) // scalar typing: 3 stays a number, session a string
}

await writeFile(patchPath, stringify(doc), 'utf8')
console.log(`patch-setting: ${entryId} ${pairs.join(' ')} -> ${patchPath}`)
