import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectKeyFor, sessionDirFor } from '../lib/session-dir.js'

test('projectKeyFor encodes the jsonl backend project-directory name', () => {
  // Separators collapse into single dashes; leading dashes are stripped.
  assert.equal(projectKeyFor('/Users/x/my repo'), '--Users-x-my~0020repo--')
  // Non-safe characters keep the char and append uppercase zero-padded hex.
  assert.equal(projectKeyFor('/a/b~c'), '--a-b~007Ec--')
  // A root path collapses to the 'root' placeholder.
  assert.equal(projectKeyFor('/'), '--root--')
  // The empty path is refused — a derivation from it would be a decoy.
  assert.throws(() => projectKeyFor(''), /empty project path/)
  // Long paths clamp at 251 readable characters between the dashes.
  const long = '/' + 'a'.repeat(400)
  assert.equal(projectKeyFor(long).length, 2 + 251 + 2)
})

test('sessionDirFor joins root, project key and session id', () => {
  assert.equal(sessionDirFor('/root', '/w/my-proj', 'sid-1'), '/root/--w-my-proj--/sid-1')
})
