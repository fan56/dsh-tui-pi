/**
 * Offline verification of the APPEND_SYSTEM.md scoping, using the REAL closure
 * packages (cordis + dsh-system-prompt + dsh-scope).
 *
 * Old wiring (the bug): the TUI registered its section from the plugin's own
 * unscoped ctx -> GLOBAL prompt layer -> EVERY assembly merged it, so every
 * subagent also received the user's "I am an orchestrator" identity.
 *
 * New wiring: the section is registered through the MAIN agent's scoped ctx
 * (agent setup receives agentCtx; cordis binds service calls to the caller
 * ctx) -> the agent's OWN scope layer. Subagent scopes are minted without a
 * parent binding, so their chains never include the parent's layer.
 *
 * This script reproduces both wirings and asserts:
 *   - parent assembly contains the section (both wirings)
 *   - a child-like scope does NOT see it (new wiring only)
 */
// The @deepseek-ai closure to verify against: DSH_CLOSURE_DIR override first
// (dev against an unreleased dsh line), then the global dsh install's own
// nested closure — same resolution order as scripts/link-dsh-closure.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
function findClosure() {
  if (process.env.DSH_CLOSURE_DIR) return realpathSync(process.env.DSH_CLOSURE_DIR)
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') {
      const nested = `${realpathSync(bin)}/../../node_modules/@deepseek-ai`
      if (existsSync(`${nested}/cordis`)) return realpathSync(nested)
    }
  } catch { /* dsh not on PATH */ }
  return '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
}
const closure = findClosure()

const { Context } = await import(`file://${closure}/cordis/lib/index.js`)
const { default: SystemPrompt } = await import(`file://${closure}/dsh-system-prompt/lib/index.js`)
const { createScope } = await import(`file://${closure}/dsh-scope/lib/index.js`)

// One app per wiring so the layers stay independent.
let loopCtxRef
async function boot() {
  const app = new Context({})
  await app.plugin(SystemPrompt, {})
  const loopPlugin = (ctx) => { loopCtxRef = ctx }
  loopPlugin.inject = ['systemPrompt']
  await app.plugin(loopPlugin, { name: 'fake-agent-loop' })
  return app
}

const SECTION = { name: 'dsh-tui-pi:append-system', order: 200, text: () => 'APPEND_SYSTEM_CONTENT_MARKER' }
const assemble = (loopCtx, key) => loopCtx.systemPrompt.assemble({ agent: key, scope: key })

// --- old wiring: section registered from an unscoped plugin ctx (global) ---
{
  const app = await boot()
  const tuiPlugin = (ctx) => { ctx.systemPrompt.section(SECTION) }
  tuiPlugin.inject = ['systemPrompt']
  await app.plugin(tuiPlugin, { name: 'fake-tui-global' })
  const parentKey = {}
  createScope(loopCtxRef, parentKey)
  const childKey = {}
  createScope(loopCtxRef, childKey)
  const parentNames = (await assemble(loopCtxRef, parentKey)).sections.map(s => s.name)
  const childNames = (await assemble(loopCtxRef, childKey)).sections.map(s => s.name)
  console.log('[old wiring] parent sees section:', parentNames.includes(SECTION.name))
  console.log('[old wiring] CHILD sees section :', childNames.includes(SECTION.name), '(the reported bug)')
}

// --- new wiring: section registered through the agent's scoped ctx ---
{
  const app = await boot()
  const loopCtx = loopCtxRef
  const parentKey = {}
  const parentScope = createScope(loopCtx, parentKey)
  // The setup contract hands the agent its scoped ctx (scope.ctx.extend in
  // ReactLoopAgent); registering through it lands in the agent's own layer.
  const parentAgentCtx = parentScope.ctx.extend({ agent: { id: 'parent' } })
  parentAgentCtx.systemPrompt.section(SECTION)
  const childKey = {}
  createScope(loopCtx, childKey)
  const parentNames = (await assemble(loopCtx, parentKey)).sections.map(s => s.name)
  const childNames = (await assemble(loopCtx, childKey)).sections.map(s => s.name)
  const okParent = parentNames.includes(SECTION.name)
  const okChildAbsent = !childNames.includes(SECTION.name)
  console.log('[new wiring] parent sees section:', okParent)
  console.log('[new wiring] child sees section :', !okChildAbsent ? 'YES (BROKEN)' : 'no (fixed)')
  process.exitCode = okParent && okChildAbsent ? 0 : 1
}
