# dsh-tui-pi — Handoff

> 接力文档：在另一个 session 继续工作时，从这里开始读。

## 项目位置与运行方式

- 仓库：`/Users/fliu56/github/dsh-tui-pi`
- 安装：`~/.dsh/profiles/tui` 通过 `link:` 实时挂载（改 src + `pnpm build` → 重启即生效，无需重装）
- 启动：`dsh --profile tui`（`~/.zshrc` 已配别名 `dsh-tui`、`dst`）
- Node：`>=22.19`，pnpm 10.33+，本机 node 在 `/opt/homebrew/bin`

## 当前状态（2026-08-15，11 个 commit）

| Phase | 内容 | 状态 |
|---|---|---|
| A | review 修复（参数属性、错误边界、LICENSE、RESET 常量） | ✅ |
| B | TuiAltScreen + VStack dock 固定 | ✅ |
| C | 会话接线（agents.create lazy + followup + 流式 + 工具卡 + Ctrl+C 树级退出） | ✅ |
| D | slash 命令（ctx.commands.list 补全 + execute；未知命令回落模型） | ✅ |
| E | powerline footer + cwd/branch 顶边框 + last-request widget；统计全 O(1) | ✅ |
| F | `link:` + tarball 两种本地安装在全新 profile 启动验证；npm pack 35 文件 | ✅ |
| 补丁 | footer 启动即读 selection；light 主题下顶边框用 fgMuted（border 色太淡） | ✅ |
| 补丁 | 配色对齐 `~/scripts/cmux-theme.sh` GitHub 主题（canvas #f6f8fa、accent #0366d6、thinking 紫 #6f42c1） | ✅ |
| 补丁 | web 命令对齐：注册原生 `/model`（43 模型选择器 + live switch + footer 同步）、`/export`（写 JSONL） | ✅ |
| 补丁 | thinking 块独立渲染（流式尾巴 + 定稿斜体 thinking 色 Markdown）；tool 卡多行（status 色头 + args 行 + 10 行结果） | ✅ |
| G | `/settings` 文字配置浏览器：describe() 动态枚举 7 namespace + schema rehydrate → 多级钻入、cycle 行（字面量 union）、Input 行内编辑（secret 掩码、空输入=保留）、dict 加键、ReadOnlyViewer、reset 确认；mutate 串行链写回 + 失败回读；9 个纯函数单测 | ✅ |
| H | `/think`（当前模型 reasoning effort 选择器，'(provider default)' 行清除覆盖，live 切换 + footer 同步）+ `/model` 两阶段（先选模型、有 efforts 再弹 effort）+ `/models` 别名（stage-2 Esc 整体取消、overlay 交接无焦点闪跳） | ✅ |
| I | `/session` 只读信息面板（id/cwd/created/model/think/status/messages/tokens/events/parent）+ `/resume`（list 过滤 subagent/当前会话 → inspect 预校验（损坏日志不动当前会话）→ detach+resume（保事件订阅）→ firstLiveSeq 切分种子回放、chunk 跳过；transcript/stats 从零重建） | ✅ |
| J | 命令双通道分发（registerLocal：无 live agent 直发、不预热建会话）+ `/new` 改 detachCurrent（修 /new 后消息不渲染的阻断 bug）+ 两轮 review 修复（secret 空格误清除、pending 防重入、晚到 done once 化、row id JSON 编码、onCycle 失败回读、parseNumberInput decimal 白名单、/model stage-1 竞态、ensureSession 等 resuming、/export 守卫） | ✅ |
| H | backlog 清理：/think /model 持久化（saveSelection）、/theme + dsh-tui namespace（重启生效）、Ctrl+C 分级中断、命令目录审计（无需补 bundle）、footer 提示可见性修复 | ✅ |
| I | /settings 分类层级（通用/模型/插件/Agent 设置/其他，静态映射对齐 web 设置页；双语 label 保英文搜索） | ✅ |
| J | TUI 文案统一英文 + CJK/emoji 宽度安全截断（src/text.ts clipToWidth，11 处调用点） | ✅ |

40 个单测全过（theme 15 + settings 18 + text 7）、`pnpm check` 0 error；tmux e2e 全通过（/settings 枚举钻入 cycle 编辑写回、分类层级纯英文 label（General/Models/Plugins）+ Esc 链、英文搜索过滤（model→Models、general→General）、C-u 清空搜索框、中文消息 echo 与模型中文回复无乱码、中文行宽 ≤ 终端列不挤变形、/think、/model 两阶段 Off/High/Max、/session 无会话+有会话面板、/resume 31 个会话列表+恢复+统计重建、/new 后渲染、冷启动 /export 守卫、footer 提示可见、/model 重启持久化、Ctrl+C 分级中断、/theme 预选 auto、还原 V4-Flash；e2e 前后 settings.yaml 一致）。

## 当前 backlog / 待办

1. **图片渲染**（用户已说"切回文本模型，跳过图片"——**当前不做**；以后真要加，链路已具备：`pi-tui` 的 `Image` 组件 + `ctx.get('attachment').readImage(ref)` → `Buffer.from(data).toString('base64')`）。
2. **打包**：当前 `package.json` 是 `"private": true`（本地开发够用）；要发 npm 就改 `private: false` 并 `npm login` 后 `npm publish`。
3. **GitHub 仓库清理**：`gh repo create fan56/dsh-tui-pi` 建过一个空仓库但没推上代码，gh token 没有 `delete_repo` scope，删不掉——你登录 GitHub 网页手动删。

## 用户偏好 & 上下文

- **用户语言**：中文为主；commit/代码注释英文。
- **仓库位置**：`~/github/dsh-tui-pi`，git 已 init，main 分支，11 个 commit。
- **配色**：严格对齐 `~/scripts/cmux-theme.sh` 里的 GitHub Light/Dark（不要用 Primer 默认色板）。
- **TUI 文案**：UI 文案统一英文；中文内容（消息/值/路径）必须正常显示（用户 2026-08-15 明确）。
- **安装方式**：用户明确说**不用推 GitHub**，纯本地用（`link:` + tarball）。
- **goal 模式**：用户要"我只要结果，中间不要问我"——自主执行到底；只在关键决策点（切模型、是否做某功能）才反馈。
- **dsh 版本**：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` 是 0.1.0-rc.6（运行），而 `~/deepseek-harness` 是 0.1.0-rc.5（monorepo 源码）。**所有 `@deepseek-ai/*` symlink 指向 rc.6 闭包**（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）保证运行时模块实例一致。
- **`~/.dsh/settings.yaml` 当前状态**：`agent-default-model: opencode-go / deepseek-v4-flash / reasoningEffort: high`；`dsh-tui.theme: light`（e2e 还原后的终态）。如果 `OPENCODE_GO_API_KEY` 在 dsh 启动 shell 里没设，第一条 prompt 会报 key 错——立刻改回 `minimax-cn / MiniMax-M3`（同样文字模型，已验证可用）。
- **插件机制坑**（本次调研结论）：llm-deepseek 的 `thinking: disabled` 会让所有模型只暴露 `Off` 一个 effort（`/think` 列表只有 Off 的原因）；pi-tui SettingsList 的 submenu `done(undefined)` 只关不改。
- **pi-tui SettingsList 搜索只匹配 label**：`applyFilter` 用 fuzzyFilter 且只喂 `item.label`（description 不参与）——顶层分类的 label 必须自带可搜索关键词（所以分类 label 用英文「General」「Models」），别指望 description 兜底。搜索框清空：C-u（deleteToLineStart）有效；Esc 在搜索态会直接关闭整个列表（onCancel），不会只清搜索框。
- **pi-tui `truncateToWidth` 语义与我们要的不同**：它是"先留省略号宽度"（'你好世界'@4 → '你…'，永远带省略号），我们要 content-first（放得下才加 '…'）——所以自写 `clipToWidth`（src/text.ts，基于 pi-tui visibleWidth + Intl.Segmenter 按 grapheme 截断，全角 2 列）。分类 label 英文化后中文搜索词不再命中（预期，英文关键词走 label）。

## 关键文件导航

```
src/
  index.ts          cordis 插件入口 + 所有 wiring：commands 注册 (/model, /export, /think,
                    /session, /resume, /new, /settings) + footer + git watcher + 时钟 +
                    bridge + editor 分支 provider + 树级退出；/resume 里做 inspect 预校验、
                    renderer.clear() 后 firstLiveSeq 切分种子回放
  tui.ts            TUI 启动：TuiAltScreen + ScrollView (transcript) + VStack dock，
                    CwdBorderEditor（fgMuted info 色）、setLastRequest、lastRequest 容器；
                    StartTuiOptions.themePreference（'auto' 回退终端检测）
  session.ts        DshSessionBridge：构造时 eager 读 agentDefaultModel；ensureSession
                    lazy 建 agent（先等 resuming 互斥）；installModelSelection(agentCtx, mutableRef)；
                    setSelection(next) live 切换；detachCurrent()（/new 用：dispose agent 但保留
                    事件订阅 + 清 stats）；resume(sessionId)（detach + agents.resume + 
                    seedSelectionFromDefault 保 live 选择）；replay(events)（从零重建 stats、
                    chunk 跳过、幂等）；isRunning()（agent/status 镜像）+ cancelActiveTurn()
                    （agent.cancel keepInbox）；persistDefaultModel(ctx, selection)（首选
                    agentDefaultModel.saveSelection → settings.replace last-write-wins；
                    无服务时 fallback settings.mutate + 一次冲突重试）
  theme-settings.ts /theme 设置接线：registerThemeSettings（register dsh-tui namespace
                    { theme: union['auto','light','dark'] }，applies restart）、
                    readThemePreference（settings 异步挂载等待 + cap，失败降级 auto）、
                    writeThemePreference（mutate + 冲突重试）、currentThemePreference
  commands.ts       CommandService：parseCommand + ctx.commands.execute + AutocompleteProvider；
                    registerLocal(name, handler) 双通道——无 live agent 时本地直发
                    （/resume、/session 等不预热建会话）；有 agent 时仍走 ctx.commands 落盘
  messages.ts       TranscriptRenderer：applyEvent → switch 事件类型
                    - applyChunk：text-delta/reasoning-delta 流式（reasoning 尾巴 5 行斜体）
                    - finalizeStreaming + renderAssistantMessage：定稿 Markdown
                    - addToolCard/settleToolCard：Container + status 色头 + args 行 + 10 行结果
                    - renderUserMessage：source.kind 去重（echo vs session 事件）
                    - renderCommandEcho：⌘ /cmd + 结果/错误
                    - renderTodos：todo/write 快照替换
  selectors.ts      pickEffort：resolveModelInfo(p, m).reasoning.efforts → SelectList
                    （'(provider default)' 行清除 effort 覆盖、当前值预选中）；
                    pickModel：两阶段——stage-1 选模型，暴露 efforts 再弹 stage-2
                    （先 show 新 overlay 再 hide 旧的，避免焦点闪跳；stage-2 Esc 整体取消；
                    resolveModelInfo 失败跳过 stage-2）
  text.ts          宽度工具：clipToWidth（content-first 省略号、按 grapheme 截断）+ visibleWidth
                    （re-export pi-tui，east-asian 全角=2 列）；**所有自研截断必须走它，
                    禁止裸 String.length 截断**（11 处调用点：settings viewer、session panel、
                    footer model 名、transcript preview、last-request 行、export fallback id 等）
  settings.ts       `/settings` 浏览器：ctx.settings.describe() 枚举 namespace → schemastery
                    schema rehydrate（dsh-client-schema-form）→ SettingsList 多级钻入；
                    分类层（level 0）：CATEGORY_MAP 静态映射（general/models/plugins/agent，
                    对齐 web client 侧 settings.section slot）+ 纯英文 label（General/Models/
                    Plugins/Agent settings/Other，label 兼任搜索关键词）+ 未映射 ns 落
                    「Other」（空则隐藏）；
                    按节点类型分派：cycle 行（字面量 union）/ Input 行内编辑（secret 掩码、
                    空输入=保留）/ dict 加键 / ReadOnlyViewer（array/unknown）/ reset 确认；
                    写走 settings.mutate(ns, pathOps, revision) 串行链 + 失败回读服务真相；
                    11 个导出纯函数（formatValue/unionLiterals/parseNumberInput/
                    categorizeNamespaces/categoryDescription/…）
  sessions.ts       `/session` 只读信息面板（SessionInfoPanel，Esc 关闭）+ `/resume`
                    选择器（sessionPersistence.list() → 过滤 origin==='subagent' 与当前会话 →
                    SelectList；inspectPersistedSession 预校验供调用方在 detach 前验证）
  footer.ts         PowerlineFooter：buildSegments + U+E0B0 箭头 + 7 段；
                    thinking 色按级别；context 按 <50/70/90% 切色
  editor.ts         CwdBorderEditor extends Editor：render 重写第 0 行（cwd + ⎇ branch，
                    fgMuted info 色保留可读）；scrollIndicator ↑
  git.ts            GitBranchWatcher：5s 轮询 git rev-parse，unref timer
  theme/
    palette.ts      githubLight（canvas #f6f8fa + 16 角色色对齐 cmux）+ githubDark
                    （canvas #0d1117 + 16 角色色）+ detectDarkPalette (COLORFGBG 7/15→light)
    index.ts        ansiFg/ansiBg + BOLD/RESET 常量 + buildTheme + resolveTheme
test/theme.test.mjs    15 单测：ansiFg、dark blend 值、resolveTheme 优先级、buildTheme 完整性
test/settings.test.mjs 18 单测：formatValue/displayValue/unionLiterals、parseNumberInput
                    （decimal 白名单、拒 0x/0b/0o）、parseStringInput/parseUnionInput、
                    defaultValueFor（dict 加键种子）、fieldDescription、categorizeNamespaces
                    （全量/未映射/空/顺序/去重/映射无重叠）、categoryDescription
                    （60 边界截断、空成员、去重）
test/text.test.mjs     7 单测：clipToWidth（ASCII/全角中文/混合/surrogate emoji/边界
                    省略号/超宽全丢）、visibleWidth re-export
```

## 关键 API / 模式笔记

### dsh host 服务入口
```ts
ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model, reasoningEffort }, setup: agentCtx => installModelSelection(agentCtx, this.selectionRef) })
ctx.agents.resume({ resumeSessionId, agentOptions, setup })   // 恢复持久会话（bridge.resume 用）
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
ctx.on('session/event', (session, event) => ...)     // event.data per SessionEventMap
ctx.on('agent/status', ({ agent, status }) => ...)   // 'idle' | 'running'
ctx.commands.register({ name, description, input?, handler })  // host 命令注册
ctx.commands.list(agent)                              // 补全源
ctx.commands.execute(agent, line, signal)
ctx.settings.describe()                                // SettingsDescriptor[] (per namespace: ns, schema, value, revision, applies)
ctx.settings.update(ns, patch) / replace(ns, section)
ctx.settings.mutate(ns, pathOps, expectedRevision)     // 按路径写（乐观锁 revision；失败回读服务真相）
ctx.get('sessionPersistence').list() / inspect(id)     // 持久会话；SessionHeader:
                    version / id / createdAt(epoch ms) / cwd? / parentSession? / origin?
                    （origin === 'subagent' 的要过滤掉）
ctx.get('llm').resolveCallConfig({ provider, model }) / listProviders() / listModels(id) / resolveModelInfo(p, m)
llm.resolveModelInfo(p, m).reasoning.efforts           // [{ id, name, description? }] + defaultEffort
ctx.get('agentDefaultModel').currentSelection()        // { provider, model, reasoningEffort? }
ctx.get('agentDefaultModel').saveSelection(next)        // 持久化默认选择：settings.replace，last-write-wins（/think /model 用）
agent.cancel({ kind: 'user' }, { keepInbox: true })     // 中断当前 turn（web stop 同款；keepInbox 保留队列）
ctx.settings.register(ns, schema, { base?, applies? })  // 注册 namespace（applies: 'restart'）；注册在注入 fiber 异步完成
ctx.get('attachment')?.readImage(ref, signal)         // image attachment → base64 for pi-tui Image
ctx.root.fiber.dispose()                                // 树级退出（Ctrl+C 路径用）
```

### pi-tui 模式
- `TuiAltScreen(terminal, showHardwareCursor)` + `setLayoutRoot(vstackRoot)` + `tui.start()`
- `ScrollView(transcriptContainer, { follow: 'end', primary: true })`
- `VStack([{component, basis, grow, shrink, minSize}])` ——transcript=`basis:0, grow:1`，dock=`basis:'auto', grow:0`
- `CwdBorderEditor extends Editor`：override `render(width)` 替换 lines[0]
- `Loader(tui, spinnerColor, messageColor, message?, indicator?)` + start()/stop()
- `SelectList(items, maxVisible, theme)` + `onSelect`/`onCancel` + `setSelectedIndex`
- `Input` 单行编辑 + onSubmit/onEscape（settings 行内编辑用）
- `Markdown(text, paddingX, paddingY, theme, defaultTextStyle?, options?)` ——thinking 用 `{ color, italic }` 传 thinkingText 色
- `Image(base64Data, mimeType, theme, options?)` ——图片渲染（当前不做）
- `tui.showOverlay(component, { width, maxHeight })` 返回 OverlayHandle.hide()/focus()
- `editor.setAutocompleteProvider(provider: AutocompleteProvider)` ——provider 异步 getSuggestions 返回 `{ items, prefix }`

### LLM 层架构（本次调研结论，写给下个 session）
- **两个 LLM 插件包**（dsh-base 同时挂载，id 空间不重叠）：
  - `llm-deepseek` = 官方直连：唯一 provider `deepseek-official`（api.deepseek.com），静态 2 模型（v4-flash / pro），`thinking: disabled`（→ `/think` 只有 Off，见坑）。
  - `llm-pi-ai` = pi-ai 通用适配器：依赖 `@earendil-works/pi-ai ^0.82.1`，内置 37 provider（opencode、minimax、anthropic、openai…），`llm-pi-ai.providers` 可自定义路由（provider/model 的覆写映射）；零路由时包休眠不干扰。
  - **唯一冲突面**：两包共用 settings ns `llm-pi-ai`/`llm-deepseek`（不重叠），但 pi-ai 内部 providers 目录里若手写一个与内置同 id 的 provider → 报 DUPLICATE_ADAPTER（这是包内注册，不是跨包冲突）。
- **用户当前路由示例**：`opencode-go / deepseek-v4-flash` 走 llm-pi-ai → opencode.ai 网关（配置 `thinkingFormat: deepseek` 才有 effort 语义）；`/model` 选择器的模型总数 = pi-ai 静态目录 + llm-deepseek 的 2 个。
- **模型选择三张表**：web 模型页直接写 `llm-pi-ai` + `llm-deepseek` 两个 ns；会话内选择器走 `sessions.selectModel` RPC（**会话级**，不落 settings）；`agent-default-model` 只有 TUI 的 `persistDefaultModel` 在写（settings.replace last-write-wins）。
- **web 设置分类机制**：分类在 client 侧 slot（`settings.section` 元数据：general order0 / models order10 / plugins order15 / agent-presets order20），**数据面（describe()）没有 category 字段** → TUI 用静态 `CATEGORY_MAP` 对齐，新上游 ns 自动落「其他 Other」；映射表维护责任在 TUI 侧，上游加 ns 时要回来补 CATEGORY_MAP。

### 关键设计铁律
- **不重扫**：footer/stats 永远读 O(1) 维护值，绝不在 render 里跑 getBranch()/getEntries()（pi-turbo 的教训）。
- **不重复渲染**：session 事件 user/message echo 与本地 echo 用 lastEcho 去重；streaming 用 setText 在原组件上改，不要 removeChild+addChild。
- **clock tick**：`setInterval(requestRender, 1000).unref()`；只 footer 段渲染会变。
- **TS 约束**：erasableSyntaxOnly → 无参数属性；verbatimModuleSyntax → type/value import 分清；src/ 里 .ts 扩展必须有（rewriteRelativeImportExtensions 配 NodeNext）。
- **shutdown 顺序**：`bridge.dispose()` → `ui.dispose()` → `ctx.root.fiber.dispose()` → `process.exit()`，单次进入（exitTask 防重入）。
- **overlay 防闪跳**：两阶段 picker 先 `showOverlay` 新面板（拿到焦点）再 hide 旧的；stage-2 Esc = 整体取消。
- **回放切分**：resume 只回放 `seq < firstLiveSeq` 的事件——live 段会通过 session/event 订阅再次到达，重放会双计；`assistant/chunk` 跳过（定稿 message 已含全文）。
- **descriptor.value 是对象**：settings.describe() 里每个 namespace 的 value 是解析后的对象（不是原始 yaml 片段）——按 path 取字段，别当字符串 parse。
- **settings 服务异步挂载**：effect 启动时 `ctx.get('settings')` 有 ~144ms 瞬态 undefined（注入 fiber 未就绪）——不能一次 get 判缺失，要等待 + cap，失败降级。
- **footer 提示要加在 footer.clear() 之后**：tui.ts 里先 addChild 的提示会在 index.ts `ui.footer.clear()` 时被清掉（首帧前不可见）——静态提示行在 index.ts 加 PowerlineFooter 之后补。

## 验证命令速查

```sh
cd ~/github/dsh-tui-pi
pnpm check                                    # tsc --noEmit
pnpm build                                    # emit lib/
pnpm test                                     # 40 单测（theme 15 + settings 18 + text 7，pretest 自动 build）
pnpm pack                                     # → dsh-tui-pi-0.1.0.tgz
npm pack | tail -1                            # tarball 路径

# tmux 端到端
tmux kill-session -t dsh-tui 2>/dev/null
tmux new-session -d -s dsh-tui -x 140 -y 36
tmux send-keys -t dsh-tui "dsh --profile tui" Enter
sleep 10 && tmux capture-pane -t dsh-tui -p   # 看启动：footer provider/model 已显示
tmux send-keys -t dsh-tui "say hi" Enter
sleep 15 && tmux capture-pane -t dsh-tui -p   # 看流式回复
tmux send-keys -t dsh-tui "/compact" Enter
sleep 3 && tmux capture-pane -t dsh-tui -p     # 看 slash 命令
tmux send-keys -t dsh-tui "/think" Enter
sleep 3 && tmux capture-pane -t dsh-tui -p     # 看 effort 选择器（provider default / Off / High / Max）
tmux send-keys -t dsh-tui "/resume" Enter
sleep 3 && tmux capture-pane -t dsh-tui -p     # 看持久会话列表 → Enter 恢复 → transcript/stats 重建
tmux send-keys -t dsh-tui C-c; sleep 1; tmux kill-session -t dsh-tui

# 配色验证（看真实 SGR 落屏）
tmux capture-pane -e -t dsh-light -p | grep -o "38;2;111;66;193"  # thinking 紫
```

## 下一个 session 接手建议路径

剩余 backlog 只有三件：图片渲染（用户明确不做）、npm 发布（本地用不上）、GitHub 空仓库手动清理（网页删）——都不是代码活。

如果只是想 review 当前实现：先跑 `pnpm test` + tmux 端到端，然后读 `src/settings.ts`（写回链路 + pending/once 防重入）、`src/session.ts`（isRunning/cancelActiveTurn/persistDefaultModel）与 `src/theme-settings.ts`（异步挂载等待 + 冲突重试）。
```
