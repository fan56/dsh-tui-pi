#!/usr/bin/env node
// Mock TypeSafe System One (Jev) decision server for the attention e2e
// scenario (76-attention-early-stop.sh). The TUI's jev upgrade layer
// (@aiwayds/dsh-jev-core) is pointed here via JEV_ENDPOINT + a fake
// TYPESAFE_API_KEY, so the WHOLE chain runs offline: bridge reconcile tick
// -> attention board dirty tracking -> probe -> isConfigured -> classify ->
// strict validation -> applyJevScores -> spin streak -> the ladder's early
// legs.
//
// Behavior: every question is answered on the wire contract the core's
// strict validator accepts — noul questions get a configurable probability
// (default 0.95, comfortably past the spinning tag's 0.75 high-segment
// line), so `attention_<id8>` scores critical AND `spin_<id8>` tags
// spinning on every pass, arming the 2-strike early stop.
//
// Requests are appended to the log file (--log) so the scenario can assert
// the dispatch count (the 30s debounce bounds it) and inspect the state
// table that left the machine.
//
// Node stdlib only. Usage: node mock-jev.mjs --port 8643 [--noul 0.95]
// [--log /tmp/mock-jev.log]. Health probe: GET /healthz -> 200 "ok".

import http from 'node:http'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const PORT = Number(flag('port', 8643))
const NOUL = Number(flag('noul', 0.95))
const LOG = flag('log', '/tmp/mock-jev.log')
const HOST = '127.0.0.1'

let calls = 0

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    calls += 1
    let payload = null
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad json' }))
      return
    }
    const answers = {}
    for (const [id, question] of Object.entries(payload.questions ?? {})) {
      if (question.type === 'noul') {
        answers[id] = { noul: NOUL }
      } else if (question.type === 'choice') {
        // First criteria key wins; carries probabilities over the full set
        // so the core's exact-key-set and sum rules hold.
        const names = Object.keys(question.criteria ?? {})
        const probabilities = {}
        for (const name of names) probabilities[name] = name === names[0] ? 1 : 0
        answers[id] = { choice: names[0], probabilities, confidence: 1 }
      } else {
        const levels = Array.isArray(question.criteria) ? question.criteria : []
        const probabilities = {}
        levels.forEach((_, index) => { probabilities[String(index)] = index === 0 ? 1 : 0 })
        answers[id] = { score: 0, probabilities }
      }
    }
    try {
      appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), call: calls, state: payload.state, questions: Object.keys(payload.questions ?? {}) })}\n`)
    } catch {
      // A log failure must never sink the answer.
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }))
  })
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock-jev listening on http://${HOST}:${PORT} (noul=${NOUL}, log=${LOG})\n`)
})
