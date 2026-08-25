#!/usr/bin/env node
// Mock OpenAI-compatible chat/completions server for the ask-user e2e
// scenario (68-ask-user.sh). It stands in for a real LLM so the FULL agent
// chain runs offline: user message -> dsh agent loop -> pi-ai
// openai-completions adapter -> ask_user_question tool call -> the docked
// questions panel -> tool result -> final assistant text.
//
// Behavior is keyed on the request body, not arrival order:
//   - body carries E2E_ASK_TRIGGER and no tool message yet
//       -> stream one ask_user_question tool call (3 questions: two
//          single-select + one multiSelect, exercising the tab strip,
//          auto-advance and the Confirm row);
//   - body carries E2E_ASK_TRIGGER and a tool message (the answers came back)
//       -> stream the fixed final text E2E-ASK-FLOW-COMPLETE;
//   - anything else -> stream a short ignore text (keeps stray turns alive
//     without consuming the scripted phases).
//
// Wire shape: standard chat.completion.chunk SSE events terminated by
// [DONE], which is exactly what @earendil-works/pi-ai's openai-completions
// parser (the openai SDK stream) consumes. Non-streaming requests get the
// equivalent complete completion JSON. Node stdlib only — the e2e container
// has no registry access for extra dependencies.
//
// Usage: node mock-llm.mjs --port 8642
// Health probe: GET /healthz -> 200 "ok" (used by the scenario's readiness
// poll; curl ships in the e2e image).

import http from 'node:http'

const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 8642
const HOST = '127.0.0.1'

const TRIGGER = 'E2E_ASK_TRIGGER'
const TOOL_NAME = 'ask_user_question'
const TOOL_CALL_ID = 'call-e2e-ask-1'
const MODEL = 'mock-chat'
const FINAL_TEXT = 'E2E-ASK-FLOW-COMPLETE — all three answers received and recorded. Nothing else to do.'
const IGNORE_TEXT = 'E2E mock: no scripted behavior for this request.'

// The three questions handed to ask_user_question: two single-select (auto-
// advance applies) and one multiSelect (stays put), matching the assertions
// in 68-ask-user.sh.
const QUESTIONS = {
  questions: [
    {
      id: 'deploy-target',
      question: 'Where should the e2e bundle be deployed?',
      header: 'Deploy target',
      options: [
        { label: 'staging', description: 'Safe e2e staging area.' },
        { label: 'production', description: 'Ship it to everyone.' },
      ],
    },
    {
      id: 'verbosity',
      question: 'How verbose should the deploy log be?',
      header: 'Verbosity',
      options: [
        { label: 'quiet', description: 'Errors only.' },
        { label: 'chatty', description: 'Every step narrated.' },
      ],
    },
    {
      id: 'extras',
      question: 'Which extra checks should run?',
      header: 'Extras',
      multi_select: true,
      options: [
        { label: 'lint', description: 'Static checks first.' },
        { label: 'smoke', description: 'Quick runtime probe.' },
      ],
    },
  ],
}

let requestCount = 0
const log = (message) => {
  console.log(`${new Date().toISOString()} ${message}`)
}

const sseChunk = (delta, finishReason) => JSON.stringify({
  id: `chatcmpl-mock-${++requestCount}`,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const usageChunk = () => JSON.stringify({
  id: `chatcmpl-mock-${++requestCount}`,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: MODEL,
  choices: [],
  usage: { prompt_tokens: 64, completion_tokens: 24, total_tokens: 88 },
})

const completionMessage = (delta, finishReason) => ({
  id: `chatcmpl-mock-${++requestCount}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: finishReason }],
  usage: { prompt_tokens: 64, completion_tokens: 24, total_tokens: 88 },
})

/** Decide the scripted phase for one chat request body. */
function decidePhase(bodyText) {
  const hasTrigger = bodyText.includes(TRIGGER)
  // The openai SDK serializes without spaces; be lenient about formatting.
  const hasToolResult = bodyText.includes('"role":"tool"') || bodyText.includes('"role": "tool"')
    || bodyText.includes('tool_call_id')
  if (hasTrigger && hasToolResult) return 'final'
  if (hasTrigger) return 'ask'
  return 'ignore'
}

function handleChat(req, res, body) {
  let bodyText = ''
  try {
    bodyText = String(body)
    JSON.parse(bodyText) // reject malformed bodies early
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
    return
  }
  const phase = decidePhase(bodyText)
  const wantsUsage = bodyText.includes('include_usage')
  const stream = bodyText.includes('"stream":true') || bodyText.includes('"stream": true')
  log(`chat path=${req.url} phase=${phase} stream=${stream}`)

  if (!stream) {
    const message = phase === 'ask'
      ? { tool_calls: [{ id: TOOL_CALL_ID, type: 'function', function: { name: TOOL_NAME, arguments: JSON.stringify(QUESTIONS) } }] }
      : { content: phase === 'final' ? FINAL_TEXT : IGNORE_TEXT }
    const finishReason = phase === 'ask' ? 'tool_calls' : 'stop'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(completionMessage(message, finishReason)))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  const events = []
  if (phase === 'ask') {
    events.push(sseChunk({
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id: TOOL_CALL_ID,
        type: 'function',
        function: { name: TOOL_NAME, arguments: JSON.stringify(QUESTIONS) },
      }],
    }, null))
    events.push(sseChunk({}, 'tool_calls'))
  } else {
    const text = phase === 'final' ? FINAL_TEXT : IGNORE_TEXT
    events.push(sseChunk({ role: 'assistant', content: text }, null))
    events.push(sseChunk({}, 'stop'))
  }
  for (const event of events) {
    res.write(`data: ${event}\n\n`)
  }
  if (wantsUsage) {
    res.write(`data: ${usageChunk()}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  const isChat = req.method === 'POST'
    && (req.url === '/chat/completions' || req.url === '/v1/chat/completions')
  if (!isChat) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no such route: ${req.method} ${req.url}` } }))
    return
  }
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => handleChat(req, res, Buffer.concat(chunks).toString('utf8')))
  req.on('error', () => res.destroy())
})

server.listen(PORT, HOST, () => {
  log(`ready http://${HOST}:${PORT}`)
})
