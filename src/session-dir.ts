/**
 * Session storage directory derivation — where the jsonl backend groups a
 * cwd's sessions, used to LOCATE persisted logs (read-only remote view,
 * corrupt-log repair) without resuming the session.
 *
 * `projectDirectoryFor` is a byte-identical port of upstream `projectKey()`
 * in @deepseek-ai/dsh-session-persistence-jsonl. The derived session dir
 * additionally relies on upstream's `encodeSegment(sessionId)` being the
 * IDENTITY for dsh ids — true while ids are UUIDs (safe charset ⊇ UUID
 * charset). If upstream ever introduces non-UUID ids, port encodeSegment
 * too or derivations land beside decoy paths; update only in lockstep with
 * upstream either way.
 *
 * (Through 0.1.2 this module also vendored the cross-process pid-file
 * writer lock; 0.1.5's host-native `SessionWriteLease` kernel lock on the
 * same directories took that job over and the vendored copy was deleted —
 * see the 0.1.5 migration notes.)
 */

import { join } from 'node:path'

/**
 * Project-directory name under which the jsonl backend groups a cwd's
 * sessions — byte-identical port of upstream `projectKey()` in
 * @deepseek-ai/dsh-session-persistence-jsonl.
 */
export function projectKeyFor(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The jsonl backend's directory for one session: `<root>/<projectKey>/<id>`. */
export function sessionDirFor(root: string, cwd: string, sessionId: string): string {
  return join(root, projectKeyFor(cwd), sessionId)
}
