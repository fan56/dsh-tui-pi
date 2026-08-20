#!/usr/bin/env node
/**
 * Regenerate the shipped terminal font subset: assets/fonts/dsh-tui-pi-nerd.ttf.
 *
 * Why this font exists: the TUI's only PUA glyph is the powerline separator
 * U+E0B0 (`src/icons.ts`), which no default terminal font ships. Setting a
 * Nerd Font as the terminal's main font fixes it, but full Nerd Fonts are
 * megabytes. This script produces a ~170KB subset that works AS A TERMINAL
 * MAIN FONT: ASCII + U+E0B0 + every symbol the TUI renders (box drawing,
 * block elements, geometric shapes, misc technical/symbols/dingbats, arrows,
 * braille) so a weak terminal without font fallback still shows them.
 *
 * Sources and their licenses (all shipped next to the TTF):
 *   - Hack Nerd Font Regular (ryanoasis/nerd-fonts v3.5.0) — the ASCII +
 *     powerline base; covers the 25xx/21xx/2580/2500/28xx blocks, U+E0B0,
 *     U+2B58. Base glyphs: Hack (MIT) + Bitstream Vera (Vera license), see
 *     LICENSE-Hack.txt; the Nerd Fonts-patched portions (incl. the powerline
 *     separator) are under the project's LICENSE-NerdFonts.txt (SIL OFL 1.1).
 *   - Noto Sans Symbols 2 (google/fonts) — covers U+23F9, U+2605, U+26A0,
 *     U+2611, U+2713, U+2718, U+2318 (OFL 1.1, LICENSE-NotoSansSymbols2.txt).
 *   - Noto Sans Symbols v1 (google/fonts, variable; instanced at wght=400) —
 *     covers U+2699, U+2387, U+24D8 (OFL 1.1, LICENSE-NotoSansSymbols.txt).
 *   No single font covers all three, so the script merges them, subsets
 *   to the project glyph set and renames the result ("DSH TUI Nerd") so the
 *   derivative does not carry Hack's reserved font name.
 *
 * Requirements: python3 with fonttools (`python3 -m pip install fonttools`,
 * or a venv — pip on a homebrew python needs a venv for PEP 668).
 *
 * Usage: node assets/fonts-gen.mjs
 * Writes assets/fonts/dsh-tui-pi-nerd.ttf plus the four license files.
 * Network is required (downloads the sources fresh).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(repoRoot, 'assets', 'fonts')
const FONT_TAG = 'v3.5.0'

/** The subset spec: ASCII + U+E0B0 + every block the TUI renders (see src/icons.ts). */
const UNICODES = [
  'U+0020-007E', // ASCII printable (a terminal main font needs the full alphabet)
  'U+00B0,U+00B7,U+00D7,U+00F7', // ° · × ÷ (footer labels)
  'U+2013,U+2014,U+2022,U+2026', // – — • … (prose/notice punctuation)
  'U+2190-21BB', // arrows (history hint, panes)
  'U+2212,U+2234,U+2264-2265', // − ∴ ≤ ≥
  'U+2300-23FF', // misc technical: ⌘ ⎇ ⏎ ⏹ …
  'U+24D8', // ⓘ
  'U+2500-25FF', // box drawing + block elements + geometric shapes (borders, ● ■ ▸ ◔ ◕ …)
  'U+2600-26FF', // misc symbols: ☁ ★ ☐ ☑ ⚙ ⚠ ⚡ …
  'U+2700-27BF', // dingbats: ✎ ✓ ✔ ✗ ✘ …
  'U+2800-28FF', // braille (the spinner frames)
  'U+2B58', // ⭘ (subagent header)
  'U+E0B0', // powerline separator (the only PUA glyph in the project)
].join(',')

const SOURCES = [
  {
    file: 'Hack.zip',
    url: `https://github.com/ryanoasis/nerd-fonts/releases/download/${FONT_TAG}/Hack.zip`,
    member: 'HackNerdFont-Regular.ttf',
  },
  {
    file: 'NotoSansSymbols2-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf',
  },
  {
    file: 'NotoSansSymbols-var.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssymbols/NotoSansSymbols%5Bwght%5D.ttf',
  },
  {
    // The Nerd Fonts project license (SIL OFL 1.1 + MIT) covering the
    // patched-font portions of Hack Nerd Font (incl. the powerline glyphs).
    file: 'LICENSE-NerdFonts.txt',
    url: 'https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/LICENSE',
  },
  {
    file: 'OFL-NotoSansSymbols.txt',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssymbols/OFL.txt',
    licenseOf: 'NotoSansSymbols',
  },
  {
    file: 'OFL-NotoSansSymbols2.txt',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssymbols2/OFL.txt',
    licenseOf: 'NotoSansSymbols2',
  },
]

/** Download a URL to a file (node 22 has global fetch). */
async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  process.stdout.write(`  downloaded ${dest.split('/').pop()} (${existsSync(dest) ? readFileSync(dest).length : 0} bytes)\n`)
}

function sh(cmd, args, opts = {}) {
  process.stdout.write(`  $ ${cmd} ${args.join(' ')}\n`)
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
}

/** python3 with fontTools on PATH, or die with an install hint. */
function resolvePython() {
  for (const candidate of [process.env.PYTHON ?? 'python3']) {
    try {
      execFileSync(candidate, ['-c', 'import fontTools'], { stdio: 'ignore' })
      return candidate
    } catch { /* try next */ }
  }
  throw new Error(
    'fonttools is required. Install it first, e.g.:\n'
    + '  python3 -m venv /tmp/ft-venv && /tmp/ft-venv/bin/pip install fonttools\n'
    + 'then re-run with PYTHON=/tmp/ft-venv/bin/python node assets/fonts-gen.mjs',
  )
}

async function main() {
  const py = resolvePython()
  const work = mkdtempSync(join(tmpdir(), 'dsh-tui-font-'))
  process.stdout.write(`Working in ${work}\n`)

  // 1. Download the sources (fresh each run).
  for (const src of SOURCES) {
    if (src.licenseOf === 'Hack') continue // Hack's license is inside its zip
    await download(src.url, join(work, src.file))
  }
  sh(py, ['-m', 'zipfile', '-e', join(work, 'Hack.zip'), join(work, 'hack')])
  // The Hack zip carries its license as LICENSE.md (Hack MIT + Vera attribution).
  writeFileSync(join(work, 'LICENSE-Hack.txt'), readFileSync(join(work, 'hack', 'LICENSE.md')))
  const hack = join(work, 'hack', 'HackNerdFont-Regular.ttf')

  // 2. Prepare the two Noto fonts: instance the variable v1 at wght=400,
  //    scale both to upem 2048 (Hack's units) and drop tables pyftmerge
  //    cannot merge (vertical metrics / variable tables).
  const preparePy = join(work, 'prepare.py')
  writeFileSync(preparePy, `
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib.instancer import instantiateVariableFont

# v1 is a variable font (wght axis) — pin the Regular instance first.
vf = TTFont('${join(work, 'NotoSansSymbols-var.ttf')}')
instantiateVariableFont(vf, {'wght': 400})
vf.save('${join(work, 'NotoSansSymbols1-static.ttf')}')

for src, dst in [
    ('${join(work, 'NotoSansSymbols2-Regular.ttf')}', '${join(work, 'NotoSansSymbols2-prep.ttf')}'),
    ('${join(work, 'NotoSansSymbols1-static.ttf')}', '${join(work, 'NotoSansSymbols1-prep.ttf')}'),
]:
    f = TTFont(src)
    scale_upem(f, 2048)          # match Hack's 2048 unitsPerEm
    for t in ('vhea', 'vmtx', 'VORG', 'GSUB', 'GPOS', 'GDEF', 'STAT', 'avar', 'cvar', 'HVAR', 'MVAR', 'VVAR'):
        if t in f: del f[t]
    f.save(dst)
    print('prepared', dst)
`)
  sh(py, [preparePy])

  // 3. Merge Hack + both Noto symbol fonts, then subset to the project set.
  //    fontTools.merge writes `merged.ttf` to its CWD — pin it to the work dir
  //    so the subset step below always finds the merged font (a prior version
  //    let it land in the invoking CWD, silently breaking the pipeline).
  sh(py, ['-m', 'fontTools.merge', hack, join(work, 'NotoSansSymbols2-prep.ttf'), join(work, 'NotoSansSymbols1-prep.ttf')],
    { cwd: work })
  const merged = join(work, 'merged.ttf')
  const subset = join(work, 'dsh-tui-pi-nerd.ttf')
  sh(py, ['-m', 'fontTools.subset', merged,
    `--unicodes=${UNICODES}`,
    '--layout-features=', '--glyph-names', '--no-hinting',
    '--drop-tables+=GDEF,GPOS,GSUB',
    `--output-file=${subset}`])

  // 4. Rename the derivative so it does not carry Hack's reserved font name.
  const renamePy = join(work, 'rename.py')
  writeFileSync(renamePy, `
from fontTools.ttLib import TTFont
f = TTFont('${subset}')
name = f['name']
records = {
    1: 'DSH TUI Nerd',    # family
    2: 'Regular',         # subfamily
    3: 'DSH TUI Nerd',    # unique id
    4: 'DSH TUI Nerd',    # full name
    6: 'DSHTUINerd',      # postscript name (iTerm2 Normal Font uses this)
    16: 'DSH TUI Nerd',   # typographic family
    17: 'Regular',        # typographic subfamily
}
# Keep only the platform 3 / encoding 1 (Windows BMP) records, with our names.
keep = []
for rec in name.names:
    if rec.nameID in records and rec.platformID == 3 and rec.platEncID == 1:
        rec.string = records[rec.nameID]
        keep.append(rec)
name.names = keep
f.save('${subset}')
print('renamed -> DSH TUI Nerd')
`)
  sh(py, [renamePy])

  // 5. Ship the subset + the license files.
  mkdirSync(outDir, { recursive: true })
  copyFileSync(subset, join(outDir, 'dsh-tui-pi-nerd.ttf'))
  copyFileSync(join(work, 'LICENSE-Hack.txt'), join(outDir, 'LICENSE-Hack.txt'))
  copyFileSync(join(work, 'LICENSE-NerdFonts.txt'), join(outDir, 'LICENSE-NerdFonts.txt'))
  copyFileSync(join(work, 'OFL-NotoSansSymbols.txt'), join(outDir, 'LICENSE-NotoSansSymbols.txt'))
  copyFileSync(join(work, 'OFL-NotoSansSymbols2.txt'), join(outDir, 'LICENSE-NotoSansSymbols2.txt'))
  const size = statSync(join(outDir, 'dsh-tui-pi-nerd.ttf')).size
  process.stdout.write(`\nWrote assets/fonts/dsh-tui-pi-nerd.ttf (${size} bytes) + 4 license files\n`)
}

main().catch(error => {
  console.error(`\nfonts-gen failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
