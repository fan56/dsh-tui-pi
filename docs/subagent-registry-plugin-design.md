# dsh 自定义 subagent 注册插件 — 可行性调研与设计文档

目标：在 dsh 会话启动时，把 `~/.dsh/agents/*.md` 定义的自定义 agent 注册进 dsh 已有的
subagent 机制，让主对话 LLM 能**按名字**调用它们（如「用 workhorse 跑这个任务」）。

- 环境：`@deepseek-ai/dsh` v`0.1.0-rc.6`，CLI `dsh`。所有 `@deepseek-ai/dsh-*` 包位于
  `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（下文缩写作 `$D`）。
- 用户 profile：`~/.dsh/profiles/tui/`，`dsh.profile.bundles=["@deepseek-ai/dsh-base","dsh-tui-pi"]`，
  `dsh-tui-pi` 以 `link:` 指向 `/Users/fliu56/github/dsh-tui-pi`。
- 用户自定义 agent：`~/.dsh/agents/{workhorse,oldfox,ArtyDuck}.md`，YAML frontmatter + 正文(system prompt)。
- 规范约定："推测"= 未能在 rc.6 源码中直接证实的判断。

---

## 1. 插件开发机制（插件如何声明、如何被加载）

### 1.1 插件包声明：`dsh.bundle.patch`

- 一个可被 dsh 装进 profile 的包，其 `package.json` 需声明 `dsh.bundle.patch`。范例：
  `/Users/fliu56/github/dsh-tui-pi/package.json:42-45` 的 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`。
- 唯一有效子字段是 `patch`：`$D/dsh-app-boot/lib/index.js:548` 读 `dsh?.bundle?.patch`，
  `:549` 未声明时直接 throw。而 `dsh.profile.bundles` 属于 **profile 层**（用户 profile 的
  `package.json`），由 `dsh-app-boot/lib/index.js:546` 展开为 patch 层。
- bundle 的 `main`（如 `lib/index.js`）是插件运行时入口；`cordis.patch.yml` 负责把插件挂进装配树。

### 1.2 `cordis.patch.yml`：一块补丁层

- 它是顶层 YAML 数组，元素为 `@deepseek-ai/cordis-plugin-include` 的 patch options
  （`$D/dsh-app-boot/lib/index.js:821-845`），语法 `{insert:[{id,name,config?,disabled?}]}`，
  支持 `!!js` 表达式（`:15-28`）。
- dsh-tui-pi 的 `cordis.patch.yml:7-9` 以 `- insert: - id: tui-pi / name: '@aiwayds/dsh-tui-pi'`
  把插件行挂进装配树。
- 补丁合并算法 `applyEntryPatches`（`$D/dsh-app-boot/lib/index.js:57-106`）：`insert`+`id` 追加到组、
  无 `id` 追加顶层；`config` 覆盖补丁必须按 `id` 命中。

### 1.3 加载全过程（从「加入 profile」到「被装配」）

1. **加入 profile**：
   - `dsh plugin --profile tui ...` 是 **pnpm 薄转发器**（`$D/dsh/lib/plugin-*.js:5-16`，
     `bin.js:132-142`，分派函数 `runPlugin(...)` `plugin-*.js:78-117`）：
     首次初始化 profile → `spawnSync("pnpm", ...)` 在 profile 目录执行 → 成功后
     `reconcilePlugins()` 把声明了 `dsh.bundle.patch` 的包自动追加进 `dsh.profile.bundles`
     （`plugin-*.js:36-71`）。本地 `link:` 目录由 cwd 锚定（`anchorPathSpec` `:73-77`）。
   - 或手改 `~/.dsh/profiles/tui/package.json`：`dependencies` 加
     `"<pkg>": "link:/abs/path"`，`dsh.profile.bundles` 加包名，再 `pnpm install`。
     （当前 tui profile 正是这样 link 到 dsh-tui-pi：`~/.dsh/profiles/tui/package.json:4-13`。）
2. **启动装配**：
   - `dsh`（`bin.js`）→ `profile-boot` 的 `runProfile`（启动 compos compose）
     → `composeProfile` 收集 `[...bundlePatches, ...profilePatches, ...homePatches, ...overlays]`
     （按 `file:line`：后写赢）→ `boot()` → `mountRootInclude` 注入 root Include 的 `config.patches`
     → `Include._apply` 在空 `cordis.yml`（`[]`）上用 `applyEntryPatches` 叠加装配。
   - 各插件进入 `apply(ctx)` 时即为「插件已加载、可注册 service/工具」。
   - 热重载：手改 `cordis.patch.yml` 经 `watchUserPatches`（`$D/dsh-app-boot:760-780`）即可生效，不必重启。

### 1.4 插件代码里如何注册自定义 service / 工具

- 插件标准三件套：`export { name, inject, apply }`（`dsh-tui-pi/src/index.ts:41,44,46`；
  入口 `apply(ctx: Context)` `:46`；生命周期用 `ctx.effect(..., label)` `:53` 等）。
- **注册工具**：`ctx.tools.register(defineTool({ name, description, parameters, execute, ... }))`
  — `defineTool` 来自 `@deepseek-ai/dsh-tools`（签名 `$D/dsh-tools/lib/types/schema.d.ts:239`；
  `DefineToolOptions` `:177-229`；注册 `ctx.tools.register` `$D/dsh-tools/lib/types/index.d.ts:603`）。
  官方最规范范例：`$D/dsh-tool-todo/lib/index.js`（`export{Config,apply,inject,name}` +
  `ctx.tools.register(defineTool(...))`）；以及 `$D/dsh-tool-subagent/lib/index.js`（见 §5）。
- **注册命令**：`ctx.commands.register(...)`（`dsh-tui-pi/src/index.ts:292` 等 10 处）。
- **系统提示截面**：`ctx.systemPrompt.section({name, order, text})`
  （`dsh-tui-pi/src/index.ts:53-57`；接口 `$D/dsh-system-prompt/lib/types/index.d.ts:12`）。
- **需要 import 的包**：`defineTool` from `@deepseek-ai/dsh-tools`；
  `ctx.subagents`（启动时用）from `@deepseek-ai/dsh-subagent`（已随 dsh 依赖存在）；
  `js-yaml`（解析 .md frontmatter）；`node:fs/promises`。
- 注意：dsh-tui-pi **从不** `ctx.set`/`ctx.provide`（无匹配），纯消费者 +
  命令/设置/提示贡献者。自建 service 用 cordis `Service`/declaration merging。

---

## 2. 会话启动钩子 & 主会话可观察性

### 2.1 主会话是谁创建、何时创建

- 主会话由 dsh-tui-pi 的 `DshSessionBridge` **懒创建**（首次 prompt 时）：
  `/Users/fliu56/github/dsh-tui-pi/src/session.ts:445-469` `ensureSession()` →
  `:493-505` `createSession()` → `ctx.agents.create({...})`。
- 传给 `ctx.agents.create`：`sessionId: SessionId(crypto.randomUUID())`、
  `meta:{cwd:process.cwd()}`、`agentOptions: this.selection`、
  `setup: async agentCtx => installModelSelection(agentCtx, this.selectionRef)`（`session.ts:496-505`）。
- **不是启动时创建** —— 是首次 prompt 懒建（`session.ts:5,141-148`）。resume 走 `ctx.agents.resume`
  （`session.ts:265-272`）。

### 2.2 插件能否观察到主会话并拿到 agent 实例？—— 能（三个正交钩子）

1. **`CreateAgentOptions.setup` 回调**（创建期组合，最贴近「启动即执行」）：
   - `AgentSetup = (agentCtx: Context) => ...`（`$D/dsh-agent/lib/types/index.d.ts:57,100-117`）。
   - factory 在 mint `agentCtx` 后、插入/宣告 session/agent **前** await setup；通过 `agentCtx`
     注册的 scoped 工具/提示截面/listeners 都先于 `session/created`、`agent/created`、
     `agent/session-start` 与首次 prompt 存在（`:106-111`）。
2. **`agent/session-start` 事件**（第一个真正「启动驱动」的扩展点）：
   - `$D/dsh-agent/lib/types/runtime-types.d.ts:220-223`，payload `{agent, source}`；
     `:138` 注释明文 “`agent/session-start` is the first startup-driving extension point”。
     由 agent-loop emit（`$D/dsh-agent-loop/lib/index.js:1182`）。
3. **`agent/created` / `session/created` / `session/event`**：
   - `agent/created` payload 直接是完整 `Agent`（`runtime-types.d.ts:146-148`）；`Agent.ctx`
     已在发布后可用（`runtime-types.d.ts:60-72`）。
   - `session/created` payload 即 `Session` 实例（`$D/dsh-session/lib/types/index.d.ts:44`）。
   - 作用域语义：root 级插件 ctx 的监听能收到**所有** agent 的 scoped 事件
     （`$D/dsh-scope/lib/types/index.d.ts:86-92`）。

### 2.3 主会话的 agent 实例怎么取

- `Agent` 与 `Session` 共享**同一个 `SessionId`**（`$D/dsh-agent/lib/types/index.d.ts:61-62`）；
  `Session` 无 `agent` 反指字段（`$D/dsh-session/lib/types/index.d.ts:106-267` 无该字段），
  取 agent 用 `ctx.agents.get(sessionId)`（`$D/dsh-agent/lib/types/index.d.ts:349`）。
- **关键结论**：主会话 agent 的 ctx 上已装配 `ctx.tools`、`ctx.subagents`、`ctx.systemPrompt`,
  `ctx.sandboxPolicy`、`ctx.approval`（`dsh-base` patch，见 §5 dump；`child-agent.js:148-149`），
  唯独 **`ctx.agentPresets` 不在 tui profile 装配**（见 §6）。

---

## 3. 四种注册机制候选的逐一验证

> `SubagentProvider` 接口与 `SubagentStartRequest` 定义见
> `$D/dsh-subagent/lib/types/types.d.ts:268-307`（provider）、`:91-140`（request）。

### 方案 1：agentPresets —— 技术上存在，但**不构成「按名字发派」**，且 rc.6 未接线

- `ctx.agentPresets`：`list()/resolve()/mount(agentCtx,id?)/composeFrom(agentCtx,parentCtx)`
  （`$D/dsh-agent-presets/lib/types/index.d.ts:104,115,159,186`；Service 键 `agentPresets`）。
- preset 结构 = 一个目录（目录名 = id），内含 `agent.cordis.yml`（**cordis 插件行组合**，
  不是 markdown persona）+ 可选 `preset.yml`；`COMPOSITION_FILE`（`index.js:146`）、
  `PRESET_ID=/^[a-z0-9][a-z0-9-]*$/`（`:101`）。
- 能携带：persona（`dsh-persona` 插件行，见 `$D/dsh/config/agent-presets/standard/agent.cordis.yml`
  「persona」段）、工具集（`tool-bash`/`tool-fs`/…）、以及任何 cordis 行。
  **模型/AgentOptions 不在 preset 承载**（`AgentOptions` 是 `dsh-agent/runtime-types.d.ts:21-26`）。
- **三个硬伤**：
  1. preset 是「**整个会话**以某一组合运行」的能力层（由 `default` 选中一个），
    **不是 N 个具名 agent 的目录**，模型无法「按名调用 workhorse vs oldfox」。
  2. rc.6 **没有任何消费方调用 mount/composeFrom**：全局 grep 除 `dsh-agent-presets` 自身与
    `dsh-cordis-client-runner` 一行 UI 提示外零引用；`index.js:863-866` 的 `agent/created` 监听只 `logger.warn`。
  3. **tui profile 根本没装配 `agent-presets`**：`dsh-base/cordis.patch.yml` 无该行
    （实测 `dsh --dump-config --profile tui` 329 行中无 `agent-presets` 行，见 §6）；
    `agent-presets` 由 **`$D/dsh-web-app/cordis.patch.yml:421-422`** 装配（当前 tui profile 不含
    `dsh-web-app`）。即 `ctx.get('agentPresets')` 在此 profile 中为 `undefined`
    （`applyChildComposition` 已用 `?.` 安全降级：`child-agent.js:127`）。
- **结论**：不推荐。「按名字调用」的目标语义不符合；且 rc.6 未接线 + 未装配，最不稳。

### 方案 2：自定义 subagent provider —— 可行，最贴近现有机制，但「按名列表」需自写

- provider 接口：`{ name, capabilities:{outputSchema,depthLimit,toolFilter,persona}, inheritsParentContext, start(request), prepareContinuable? }`
  （`types.d.ts:268-307`）。注册：`ctx.subagents.registerProvider(provider)`
  （`$D/dsh-subagent/lib/types/index.d.ts:237`）；事件 `subagent/provider-added/-removed`（`:69,78`）。
- 范例：`$D/dsh-subagent-spawn-in-process/lib/index.js`（`capabilities` 全 true 含 persona，`:23-29`；
  `ctx.subagents.registerProvider(...)`，`:41`；`providerName` 由 config 指定）。
- `dsh-tool-subagent` 的 mount 逻辑：仅当 `name === config.provider` 的 provider 出现才注册工具
  （监听 `subagent/provider-added` `$D/dsh-tool-subagent/lib/index.js:276-283`，或已有 `getProvider` `:284-285`）；
  `providerWording()` 只按 `inheritsParentContext` 布尔生成**静态**描述（`:110-119`），**不动态列 agent 名**；
  工具 schema 只有 `description/prompt/run_in_background`，**无 agent 名参数**（`:142-156`）。
- **单例约束**：provider 名只能在 host-plane 注册一次（`agent-presets/standard/agent.cordis.yml`
  delegation 段注释）。所以每 agent 一个独立 provider 名需要多个 provider 实例。
- **结论**：能注册自带 `start()` 的自定义 provider，在其内按名把 `~/.dsh/agents/<name>.md`
  **正文**当作 `persona` 传给 child，model 也拆进 `agentOptions`。但「对话内按名选 agent +
  工具描述动态列出可用 agent 名」不是现成 providerWording 会做的——需要自写工具描述或每 agent 一工具。
  可作为**备选**（尤其想给不同 agent 不同工具名/独立策略时）。

### 方案 3：新工具（use_agent / run_agent）插件内 defineTool —— **首选**

- 完全走**公开且 rc.6 真实生效**的 API：`defineTool`（`$D/dsh-tools/lib/types/schema.d.ts:239`）、
  `ctx.tools.register`（`index.d.ts:603`）、`ctx.subagents.start`（`$D/dsh-subagent/lib/types/index.d.ts`
  `SubagentRuntime.start(name, request): Promise<SubagentRun>`）。
- 参考 `tool-subagent` 的 execute 构造 request 的写法（`$D/dsh-tool-subagent/lib/index.js:217-273`）：
  - `parent = exec.agent`（`:218`）；`request = { label, prompt:[{type:'text',text}], parent,
    agentOptions?, persona?, toolFilter?, maxDepth? }`（`:221-232`）。
  - 前台：`ctx.subagents.start(config.provider, {...request, signal: exec.signal})`（`:269-272`）。
  - 后台续聊：`ctx.subagents.startContinuable({provider,label,request,signal}).childId`（`:237-245`）。
- **persona 落地**：in-process driver `applyChildComposition(childCtx, parent, {persona, toolFilter})`
  （`$D/dsh-subagent-in-process-driver/lib/index.js:172-174`）把 `persona` 注册为 child 的 scoped
  `deployment:persona` prompt 截面，**SHADOWING** deployment persona，且是 `{{…}}` 模板语义
  （`child-agent.js:126-135`；`types.d.ts:132-139`）。
- spawn provider `capabilities.persona=true`（`spawn-in-process/lib/index.js:23-29`），所以
  `ctx.subagents.start('spawn', { persona, agentOptions })` **直接可行**。
- `SubagentRun.result` 给出终态：`output: ContentBlock[]` + `stopReason`（`types.d.ts:233-258`、
  `SubagentResult` `:204-223`）；`exec.agent` 里 `exec.signal` 作取消信号。
- `~/.dsh/agents/*.md` 的解析可直接复用 dsh-tui-pi 的 `src/agent-manager.ts`：
  `agentsDir()`（`:62` = `~/.dsh/agents`）、`parseAgentMarkdown(text, path)`（`:140`，
  产出 `AgentMeta{name, description, model, thinking, deep}` + `body`）、`listAgentFiles(dir)`（`:188`）。
- **结论**：改动最小、最稳、最贴合「dsh 已有 subagent 机制」（复用 spawn provider + persona）。
  工具描述里动态列出 `workhorse/oldfox/ArtyDuck`（名字 + description），模型即可按名调用。

### 方案 4：patch dsh-base 的 tool-subagent 加 persona 映射 —— **已确认无此字段，不推荐**

- `$D/dsh-tool-subagent/lib/index.js:22-38` `Config = z.object({ provider, toolName,
  enableRunInBackground, backgroundMode, agentOptions, persona: z.string(), toolFilter, maxDepth })`。
  `persona` 是**单个静态字符串**（`:32`），**无** per-child / agent名→persona 映射表。
- `SubagentStartRequest.persona?: string`（`types.d.ts:139`）同样单个字符串，无名字查找。
- **不建议直接 patch node_modules**：`dsh-tool-subagent` 是编译产物，会随升级覆盖、
  `.d.ts` 类型不一致。其诉求（按 agent 名映射 persona）正是方案 3 的新工具可直接覆盖的。

---

## 4. 综合结论与风险

### 4.1 推荐排序

| 方案 | 贴合「dsh 已有机制」 | 改动 | 稳定性(rc.6) | 是否实现「按名调用」 |
|---|---|---|---|---|
| **3 新工具 use_agent** | ★★★（复用 spawn provider + persona） | 最小（一个插件） | 高（全公开 API） | ✅ 是 |
| 2 自定义 provider | ★★★ | 中 | 中（注意 single-registration） | 需自写列表 |
| 1 agentPresets | ★（能力组合，非名册） | 中 | **低**（rc.6 未接线+未装配） | ❌ 否 |
| 4 patch tool-subagent | ★ | 改 node_modules | 低 | 需加映射字段（不存在） |

### 4.2 风险评估

- **公开/稳定**：`defineTool`、`ctx.tools.register`、`ctx.subagents.*`（start/startContinuable/
  registerProvider/getProvider）、`SubagentProvider`/`SubagentStartRequest`/`SubagentCapabilities`、
  事件 `subagent/provider-added/-removed/-start/-end`、`Agent`（`ctx.agent`/`exec.agent`/`session`）——
  均在 `.d.ts` 公开导出，rc.6 中真实生效。
- **半公开/不稳**：
  - `ctx.agentPresets.*`（mount/composeFrom/list/resolve）虽公开，但 rc.6 无消费方接线，且 tui
    profile 未装配（`ctx.get('agentPresets')` 为 `undefined`）。
  - agent-presets 用户根命名有分歧：`USER_PRESET_DIR=".agent-presets"`（`dsh-agent-presets/lib/index.js:160`）
    vs 文档写 `${DSH_HOME}/.ln/`（`$D/dsh/config/agent-presets/cordis/skills/…/SKILL.md`）。
  - `tool-subagent` 的 `providerWording()` 未导出；Config 无 persona 映射字段。
- **rc.6 可能变**：AgentOptions 字段拼接、startContinuable 参数形状、`SubagentRuntime` 方法签名。

---

## 5. 推荐设计：插件 `dsh-subagent-registry`

### 5.1 放哪 & 理由

**建议**：独立新目录 `~/github/dsh-subagent-registry/`（**不是**放 dsh-tui-pi 内）。

理由：
1. dsh-tui-pi 是纯 UI 插件（AGENTS.md「Iron rules」明确规定 UI-only 边界），把 registry 引擎塞进去会
   A. 打破「渲染不扫描」等铁律边界；B. 让该引擎被 UI 的 `/reload` 热更新波及。
2. registry 是**引擎/数据层**，与 UI 解耦后可用于其它 profile（如 headless、web），做法与
   dsh-tui-pi 的 bundle 结构一致（`cordis.patch.yml` + `src/`），装进 tui profile 是第二选择。
3. 复用 `dsh-tui-pi/src/agent-manager.ts` 的解析器时以源码拷贝/依赖形式引入，避免跨包 import。

### 5.2 目录结构 & `cordis.patch.yml`

```
~/github/dsh-subagent-registry/
├── package.json            # "dsh":{"bundle":{"patch":"./cordis.patch.yml"}}, main: lib/index.js
├── cordis.patch.yml        # - insert: - id: dsh-subagent-registry / name: '<pkgname>'
├── tsconfig.json
└── src/
    ├── index.ts            # export { name, inject, apply }
    ├── agents-dir.ts       # agentsDir() + parseAgentMarkdown()（从 dsh-tui-pi/agent-manager 摘取）
    └── tool-run-agent.ts   # defineTool(use_agent)
```

`cordis.patch.yml`（照 dsh-tui-pi：`dsh-tui-pi/cordis.patch.yml:7-9`）：
```yaml
- insert:
    - id: dsh-subagent-registry
      name: 'dsh-subagent-registry'   # 与 package.json name 一致的包名
      config:
        agentsDir: '~/.dsh/agents'     # 可配置
        provider: 'spawn'              # 复用 dsh-base 已装配的 spawn provider
        toolName: 'use_agent'
```

### 5.3 核心代码骨架（关键函数签名 + 基于真实 API 的片段）

`src/index.ts` —— 插件三件套（对齐 `dsh-tool-subagent/lib/index.js:14-19,128` 与
`dsh-tui-pi/src/index.ts:41-46`）：
```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-subagent-registry'
export const inject = ['tools', 'subagents']        // 与 tool-subagent 的 inject（:15-19）一致

export function apply(ctx: Context, config: Config): void {
  // 注册一个全局工具。这与 dsh-tool-subagent 在 apply/mount 时 ctx.tools.register(...)
  // 一致（dsh-tool-subagent/lib/index.js:139,285），因此对主会话所有 agent 模型可见，
  // 无需 hook 主会话创建。
  ctx.effect(() => ctx.tools.register(runAgentTool(ctx, config)), 'dsh-subagent-registry: run_agent')
}
```
> 注册全局工具的等价性：`tool-subagent` 在插件 apply / 或 `subagent/provider-added` 时
> `ctx.tools.register(defineTool(...))`（`dsh-tool-subagent/lib/index.js:139,276-285`），
> 工具对所有 agent 可见，故**无需**改动主会话创建流程。若想只在根会话注入能力提示，可在
> apply 里 `ctx.on('agent/session-start', ...)` / `ctx.on('agent/created', ...)` 按 agent.ctx
> 再注册 scoped 段（`runtime-types.d.ts:220,146`）。

`src/tool-run-agent.ts` —— 工具定义（对齐 `dsh-tool-subagent` 的 execute/request 构造）：
```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAgentMarkdown, agentsDir } from './agents-dir.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export function runAgentTool(ctx: Context, cfg: Config) {
  const dir = expandHome(cfg.agentsDir)

  // 可用 agent 目录：name + description（供模型按名选）
  function listAgents(): { name: string; description?: string }[] {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => parseAgentMarkdown(readFileSync(join(dir, e.name), 'utf8'), e.name))
      .filter(r => r.ok)
      .map(r => ({ name: r.info.meta.name, description: r.info.meta.description }))
  }

  const agents = listAgents()
  const roster = agents.map(a => `- ${a.name}: ${a.description ?? ''}`).join('\n')

  return defineTool({
    name: cfg.toolName,                                  // 'use_agent'
    // 动态列出可用 agent 名，让主 LLM 知道能按名调用谁（弥补 providerWording 静态描述的问题）
    description: `Call one of the locally-defined custom agents by name. Available agents:\n${roster}\n` +
                 'Pass the agent name and a self-contained prompt; the agent runs as its own subagent with its own system prompt and returns its result.',
    parameters: {
      agent: { type: 'string', required: true, description: 'One of [' + agents.map(a => a.name).join(', ') + ']' },
      prompt: { type: 'string', required: true, description: 'The complete standalone task for this agent.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, const: 'agent-result' },
      output: { type: 'array', required: true, items: { type: 'json' } },
    } }, render: (_a, v) => [{ type: 'text', text: textOf(v.output) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('use_agent requires a calling agent (exec.agent undefined)')
      const parsed = parseAgentMarkdown(readFileSync(join(dir, `${args.agent}.md`), 'utf8'), args.agent)
      if (!parsed.ok) throw new Error(`unknown agent "${args.agent}": ${parsed.error}`)
      const { meta, body } = parsed.info

      // persona = 文件的正文（system prompt）；model 路由 provider/model 拆进 agentOptions
      const request = {
        label: args.agent,
        prompt: [{ type: 'text', text: args.prompt }] as const,
        parent,
        persona: body,
        ...(meta.model ? splitModel(meta.model) : {}),   // { agentOptions: { provider, model } }
      }
      // 前台等结果并返回 output（对应 dsh-tool-subagent :269-272）
      const run = await ctx.subagents.start(cfg.provider, { ...request, signal: exec.signal })
      const result = await run.result
      const text = textOf(result.output)
      run.dispose()                                       // 前台一定要 dispose（:90-96）
      // 非 completed → 当作工具错误回传（:55-75 stopReasonError 语义）
      if (result.stopReason !== 'completed') throw new Error(`agent ${args.agent} failed: ${result.stopReason}\n${text}`)
      return { kind: 'agent-result', output: result.output }
    },
  })
}
```
- `splitModel('provider/model')` → `{ agentOptions: { provider, model } }`（`AgentOptions`
  `runtime-types.d.ts:21-26`）。
- `textOf` = 抽取 `ContentBlock` 中的 `type:'text'`（对齐 `dsh-tool-subagent/lib/index.js:40-42`）。
- 若需「后台续聊」，改走 `ctx.subagents.startContinuable({ provider, label, request, signal })`
  返回 `childId`（`:237-245`），留作 v2（与 tool-subagent 的 `backgroundMode:continuable` 一致）。

### 5.4 安装到 tui profile

- **推荐**（自动维护 bundles）：在 `~/github/dsh-subagent-registry` 同级目录执行
  ```bash
  dsh plugin --profile tui add /Users/fliu56/github/dsh-subagent-registry
  ```
  —— `dsh plugin` 转发给 pnpm 写入 `link:` 依赖，随后 `reconcilePlugins` 自动把声明了
  `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`（`$D/dsh/lib/plugin-*.js:36-71`）。
  本地 link 以调用 cwd 锚定（`:73-77`），注意在合适目录调用或写绝对 path。
- 或手改 `~/.dsh/profiles/tui/package.json`：
  - `dependencies` 加 `"dsh-subagent-registry": "link:/Users/fliu56/github/dsh-subagent-registry"`；
  - `dsh.profile.bundles` 追加 `"dsh-subagent-registry"`；
  - 在 profile 目录 `pnpm install`。
- 改 `cordis.patch.yml` 热重载即可（`$D/dsh-app-boot:760-780`），无需重启。

### 5.5 验证

1. **装配可见**：
   ```bash
   dsh --dump-config --profile tui | grep -A2 'dsh-subagent-registry'
   ```
   —— 应出现该行（如同基准 dump 中可见 `subagent`(:214)/`tool-subagent`(:228) 行；实测 329 行）。
2. **工具出现在主会话**：起 TUI（`dsh --profile tui`），`ctx.commands.list(agent)` 或
   检查工具描述，应新增 `use_agent`。
3. **工具描述列出 3 个 agent**：`use_agent` 的 `description` / `agent` param 应显式列出并描述
   workhorse / oldfox / ArtyDuck（来自 `~/.dsh/agents/*.md` 的 frontmatter）。
4. **按名端到端**：对主对话说「用 workhorse 跑这个任务」→ 模型调用 `use_agent(agent=workhorse,…)`
   → execute 读 `~/.dsh/agents/workhorse.md` 正文作 persona、model 拆进 agentOptions →
   `ctx.subagents.start('spawn', …)` 起孩子 → 结果回传主对话。

---

## 6. 附：关键证据速查（file:line）

- plugin/bundle 声明：`dsh-tui-pi/package.json:42-45`；profile bundles
  `~/.dsh/profiles/tui/package.json:4-13`；`dsh-app-boot/lib/index.js:546,548,821-845,57-106`。
- cordis.patch.yml 语法范例：`dsh-tui-pi/cordis.patch.yml:7-9`。
- `dsh plugin` / reconcile：`$D/dsh/lib/plugin-*.js:5-16,36-77,78-117`；`bin.js:132-142`。
- defineTool / ctx.tools.register：`$D/dsh-tools/lib/types/schema.d.ts:239,177-229`；
  `$D/dsh-tools/lib/types/index.d.ts:603`。
- 主会话创建：`dsh-tui-pi/src/session.ts:493-505,445-469,141-148`。
- setup 钩子/AgentSetup：`$D/dsh-agent/lib/types/index.d.ts:57,100-117`。
- 事件：`agent/session-start` `runtime-types.d.ts:220-223`；`agent/created` `:146-148`；
  `session/created` `$D/dsh-session/lib/types/index.d.ts:44`；scoped 向上流 `dsh-scope/…:86-92`。
- 主会话 ctx 已装配：`ctx.tools`/`ctx.systemPrompt`/`ctx.subagents`（`child-agent.js:126-135`；
  `dsh-subagent/lib/types/index.d.ts:61`）；tui profile **无** `ctx.agentPresets`
  （`$D/dsh-web-app/cordis.patch.yml:421-422` 装配，仅 web；实测 `dump-config` 329 行无该行）。
- agentPresets 方法/结构：`$D/dsh-agent-presets/lib/types/index.d.ts:104,115,159,186`；
  `lib/index.js:146,101,806,851-866,988`。rc.6 无消费方接线。
- provider 接口 / request：`$D/dsh-subagent/lib/types/types.d.ts:268-307,91-140,204-258`；
  `registerProvider` `dsh-subagent/lib/types/index.d.ts:237`；事件 `:69,78`。
- spawn provider capabilities：`$D/dsh-subagent-spawn-in-process/lib/index.js:15-29,41`。
- tool-subagent 参考实现：`$D/dsh-tool-subagent/lib/index.js:128-292`（request 构造 `:217-232`，
  start `:269-272`，continuable `:237-245`，Config 无 persona 映射 `:22-38`，providerWording `:110-119`）。
- persona 落地：`$D/dsh-subagent-in-process-driver/lib/index.js:172-174`；
  `$D/dsh-subagent/lib/types/child-agent.js:126-135`。
- 解析 agents/*.md（可复用）：`dsh-tui-pi/src/agent-manager.ts:62,140,188`。
- 用户 agent 文件：`~/.dsh/agents/{workhorse,oldfox,ArtyDuck}.md`。

---

### 备注（推测处）
- `dsh plugin ... add` 对本地 `link:` 目录的确切行为以目标版本 pnpm + `dsh` 实测为准
  （本地 link 的 cwd 锚定见 `plugin-*.js:73-77`）；若不确定可退回「手改 package.json + pnpm install」。
- `splitModel` 的字符串拆分假设 model 形如 `provider/model`（与 dsh-tui-pi `convertZcodeModel`
  `agent-manager.ts:267` 一致，个别 zcode 形态需预处理）。
