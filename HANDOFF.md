# dsh-tui-pi — Handoff

> 接力文档：在另一个 session 继续工作时，从这里开始读。

## 项目位置与运行方式

- 仓库：`/Users/fliu56/github/dsh-tui-pi`
- 安装：`~/.dsh/profiles/tui` 通过 `link:` 实时挂载（改 src + `pnpm build` → 在 TUI 里 `/reload` 即生效，无需重启 dsh；reload 会 dispose 当前会话，可用 `/resume` 接回）
- 启动：`dsh --profile tui`（`~/.zshrc` 已配别名 `dsh-tui`、`dst`）
- Node：`>=22.19`，pnpm 10.33+，本机 node 在 `/opt/homebrew/bin`

## 当前状态（2026-08-15，16 个 commit；本轮 O/P/Q/R/S 变更在工作区未提交）

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
| H | `/think`（当前模型 reasoning effort 选择器，'(provider default)' 行清除覆盖，live 切换 + footer 同步）+ `/model` 两阶段（先选模型、有 efforts 再弹 effort；stage-2 Esc 整体取消、overlay 交接无焦点闪跳） | ✅ |
| I | `/session` 只读信息面板（id/cwd/created/model/think/status/messages/tokens/events/parent）+ `/resume`（list 过滤 subagent/当前会话 → inspect 预校验（损坏日志不动当前会话）→ detach+resume（保事件订阅）→ firstLiveSeq 切分种子回放、chunk 跳过；transcript/stats 从零重建） | ✅ |
| J | 命令双通道分发（registerLocal：无 live agent 直发、不预热建会话）+ `/new` 改 detachCurrent（修 /new 后消息不渲染的阻断 bug）+ 两轮 review 修复（secret 空格误清除、pending 防重入、晚到 done once 化、row id JSON 编码、onCycle 失败回读、parseNumberInput decimal 白名单、/model stage-1 竞态、ensureSession 等 resuming、/export 守卫） | ✅ |
| H | backlog 清理：/think /model 持久化（saveSelection）、/theme + dsh-tui namespace（重启生效）、Ctrl+C 分级中断、命令目录审计（无需补 bundle）、footer 提示可见性修复 | ✅ |
| I | /settings 分类层级（通用/模型/插件/Agent 设置/其他，静态映射对齐 web 设置页；双语 label 保英文搜索） | ✅ |
| J | TUI 文案统一英文 + CJK/emoji 宽度安全截断（src/text.ts clipToWidth，12 处调用点） | ✅ |
| K | 移除 /models 别名（/model 单一入口；/settings Models 管路由配置层） | ✅ |
| L | footer 左侧固定 dsh 品牌段（POWERLINE.brand #4D6BFE）+ `/reload` 热重载（src/reload.ts：仿 cordis-plugin-hmr partialReload — 清 ESM loadCache + CJS cache → 重新 import 入口 → registry.delete + 换 fiber；旧 fiber 全量 unload（TUI/bridge/agent 都 dispose，会话留档可 /resume）→ 新代码 apply；失败回滚缓存 + 重启旧代码；re-entrancy guard；runTui disposer 改 async 保证旧 TUI 先停再起新 TUI） | ✅ |
| L+ | **/reload 输入死锁修复（阻断级，gatekeeper e2e 复现）**：根因 = reload.ts 对旧 fiber 二次 dispose —— `ctx.registry.delete()` 内部已同步调 `fiber.dispose()`（第一次，返回完整清理 promise），allSettled 里再调第二次，cordis effect wrapper 对已 disposing 的调用走 early-return 直接返回 `void 0`（cordis lib/index.js `if (!runner.epoch) return setupFailed ? inFlight : void 0`），allSettled 瞬间 resolve；而旧 fiber 真实 teardown（`await bridge.dispose()`（agent 在跑时数百 ms~数秒）→ `tui.stop()`）仍在后台，落到新 TUI `start()` **之后** —— 旧 stop 把新终端的 raw mode 关掉、stdin pause 掉、留下孤儿 data listener → 渲染活着但输入全死（Esc 回显 `^[`、Enter 不提交、Ctrl+C 走 exit 130）。修复两处：① src/reload.ts:166-172 —— registry.delete 后 `setImmediate` 让 async ctx.plugin() effect 的清理先跑起来，再 `Promise.allSettled(oldFibers.map(f => f.await()))` 等 fiber 生命周期 inertia（`fiber.await()` 是 cordis 官方等 unload 的钩子）；② src/index.ts:532-539 —— disposer 里 `handle?.dispose()`（tui.stop）**移到** `await bridge.dispose()` 之前，任何 fire-and-forget 销毁路径（含 dsh 自带 HMR）旧 TUI 都先让出终端。tmux 复验：agent 运行中 /reload、连续两次 /reload、reload 后发消息/Esc/运行中 Ctrl+C（⏹ canceling 提示）全通过；pi-tui 日志确认旧 `TuiBase.stop` 恒在新 `TuiBase.start` 之前 | ✅ |
| M | 选择弹层底色：selectList（src/theme/index.ts:90-98）与 SettingsBrowser.listTheme（src/settings.ts:527-535）五 fn 全部包 canvasSubtle 背景；已知限制（pi-tui 0.84.2 无 hook，接受）：SettingsList 搜索 Input 行（enableSearch 首行）与 SelectList 未选中行的 value 部分是裸文本（select-list.js renderItem `return prefix + truncatedValue`），无底色 | ✅ |
| N | /settings Models 分类改 provider 行 + Add-provider 流程（src/settings.ts + 新 src/provider-catalog.ts）：Models 不再显示 llm-pi-ai 原始 namespace 字段——每行 = providers 一个 key（label = displayName ?? 目录名 ?? id；value = 首模型 / N models / catalog（目录/llm 目录判定）；desc = API key set/missing（process.env 探测，纯展示不强求准确）；Enter 只读查看 profile）；保留 DeepSeek (official) 与 Default model 行（子菜单进原字段编辑）；底部 + Add provider…。流程仿 pi /login：内置目录选择（10 条 catalog 路由，搜索 + oauth-selector 风格标题）→ 只输 API key（复用 EditField secret 机制）→ 写 llm-pi-ai.providers.<id> = {apiKeyEnv: deriveKeyRef(id)}（走现有 mutate 写链）→ ctx.credentials.set 存 key（对齐 web；无 credentials 服务降级为提示 export）→ 重建列表出新行。**opencode-go 实为 pi-ai catalog 路由**（用户 settings.yaml 只有 apiKeyEnv，baseURL/models 由 pi-ai 目录提供），故目录全为 catalog 路由；hand-declared 写路径保留并单测覆盖 | ✅ |
| N+ | Models 行两处显示修复：① **0 models 误报** —— 运行时 resolved profile 自带 schemastery 隐式 `models: []`，旧逻辑 `models !== undefined` 分支吞掉 catalog 判定 → providerRowView（src/provider-catalog.ts:160-175）改为 `models.length > 0` → 首个模型；否则 catalogRoute → `catalog`（空/缺省列表 = pi-ai 内置目录）；hand-declared 显式空列表仍 `0 models`（保留真实零模型场景，测试注释说明边界）。② **API key 状态误报** —— 状态列原先只查 process.env + 本会话 justStoredRefs，`.credentials.yaml` 里的存量 key（如 web 加的 opencode-go）显示 `API key missing`。dsh 进程内 credentials 服务有干净读接口：`ctx.credentials.describe(ref) → Promise<{configured, source?, writable}>`（@deepseek-ai/dsh-credentials 抽象 + dsh-credentials-local 实现，describe 对未知 ref 返回 configured:false 不抛错）。CredentialSeam（src/settings.ts:79-90）加可选 `describe?` 结构接口（不硬依赖包）；打开 Models 分类时 `prefetchCredentialStatus()`（src/settings.ts:949-986）异步对 llm-pi-ai providers 的每个 apiKeyEnv ref 调一次 describe 存入 `credentialConfigured` Map，落定时若分类仍开着则重建列表——**行构建保持同步**（不把渲染重扫改异步）；`mergedEnv()`（src/settings.ts:993-1008）合并 process.env + justStoredRefs + 预取结果，刚添加的行继续用 justStoredRefs 立即显示 set | ✅ |
| O | 弹层边框（新 src/frame.ts FramedOverlay）：每个 popup 包上下两条 palette.borderDefault `─` 线 + spacer（共 4 行），框住整个 overlay root —— SettingsList submenu 换列表时边框自动保持（frame 不动，只换内部 list）；**6 个 showOverlay 包装点全部包上**（selectors.ts 3 处：effort/theme/stage-1 model；sessions.ts 2 处：/session 面板、/resume 列表；settings.ts 1 处：分类列表）；maxHeight 按站点上调：75%（effort/theme/model/resume，宽 80%）→ 80%（settings 浏览器，宽 80%）→ 100%（/session 面板，宽 70%）；24 行终端实测：13 list 行 + 4 frame 行 ≤ 18 不丢底边框（selectors.ts:66-68 注释）、settings 15 + 4 ≤ 19、/session 面板 19 + 4 ≤ 23 | ✅ |
| P | 主题调色板重设计（src/theme/palette.ts，"paper feel"）：Light = 近白 canvas #fcfdfc（淡冷绿cast）+ 清灰绿 canvasSubtle #eef3ee / canvasInset #e5ebe5 + 石墨绿正文 fgDefault #1f2a24（canvas 14.6:1）+ 钢蓝 accent #0a60b5（5.6:1）+ 淡绿 success #1e843b + 淡紫 thinking #7b4fae + 柔琥珀 attention #9a6700 + 低饱和玫瑰 danger #b64550 + accentMuted #e2eff8 等 tint 系列；**fgSubtle 加深 #637269**（canvasSubtle 上 ~4.5:1 过 WCAG AA，C1）；Dark 保持 #0d1117 家族（canvasSubtle #161b22 / canvasInset #010409），muted 填色 = 25% tint 实色混合（blend()，#203651/#1a3b25/#4a2c2e/#3e331a，terminal 无 alpha 的固态近似）；对比度 28/28 全过（theme.test.mjs 断言颜色全从常量推导，改色板不破测试） | ✅ |
| Q | 主题热切换（本轮核心，7 处协同）：① 新 src/theme-settings.ts —— 注册 dsh-tui namespace（theme union auto/light/dark，**applies 'live'**，旧 'restart' 契约作废）+ `SettingsScope.watch` 把每次 commit（/theme 选择、/settings 浏览器编辑、**外部改 settings.yaml**）推到 applyThemeRef；② tui.ts —— `themeRef` 可变绑定（所有读取走 getter）+ applyTheme：rebuildEditor 重建编辑器（保输入缓冲/onSubmit/autocomplete/branch provider，焦点安全：仅当编辑器持焦点才移焦，弹层开着不动）+ last-request/placeholder 重染色；③ messages.ts —— **ReplayOp 缓冲**（O(1)/事件 append，渲染路径永不扫）→ setTheme 唯一读方：clear + 全量重放，流式尾巴/工具卡/todos/echo/notice 按原样重建，在途流继续 setText；④ index.ts applyTheme 编排（renderer.setTheme → ui.applyTheme → footer 提示重染色 → spinner 重建，per-piece requestRender 合并成一帧无闪烁）；⑤ **DSH_TUI_THEME 钉住语义**：env 钉住显示时 /theme 诚实提示 `Theme preference saved — display is pinned by DSH_TUI_THEME=…`（偏好照常持久化，env 去掉后生效，B2）；⑥ notice/echo 全走 buffered replay（doc.clear() 重建不丢行）；⑦ readThemePreference 注册 promise + 2s cap 降级 auto（settings 服务异步挂载）；主题模块是单例，watch 回声自身写入按 bundle identity no-op | ✅ |
| R | review 修复（Q 轮 review）：**A1 /session 焦点死区** —— 面板打开期间编辑器被主题重建 → restoreFocus 必须指向当前 editor 实例（旧闭包指向被替换的编辑器，pi-tui hide 恢复焦点到过期实例会吞后续输入）；B1 弹层 maxHeight 与 frame 4 行配合（24 行不丢边框）；B2 env 钉住不谎报（/theme 文案见 Q）；B3 四处错误行重放（settings onError、submit 捕获、cancelActiveTurn 的 ⏹ notice 全走 ReplayOp 缓冲，theme-switch 重建不丢）；C1 fgSubtle 加深（见 P）；C5 注释全英文 | ✅ |
| S | **live Todos + Subagents widgets**（本轮核心，4 处协同 + 一轮重做）：① 新 src/dsh-events.ts —— 本地声明 tool-workflow/agent-start|end、subagent/descriptor、llm/retry 事件类型 + `declare module` 合并进 SessionEventMap（声明包未装进插件；守卫收窄，switch 其余走 default）+ AgentView 视图结构；② src/session.ts —— bridge 加 subagent 追踪器：session/event 火线**不按 scope 过滤**（dsh-scope 的 session/event resolver 为 null，子会话事件也会到达），父日志 tool-workflow/agent-start（runId:seq → childId，delegation 可嵌套递归）建视图、agent-end 结算；子日志 subagent/descriptor（provider）/assistant/message usage（token 累加）/llm/retry（↻N≤M）/tool/call（当前动作）/request/context（上下文窗口算百分比）折叠成 O(1) AgentView map，`onLive(排序快照)` 推给 widget；dispose/detach/resume 清空并 onLive([])；replay() 走同一折叠（resume 重建 board）；③ 新 src/live-widgets.ts —— **固定 widget（不随 transcript 滚动）钉在聊天区顶部**（tui.ts 的 root VStack 加了 basis:auto/grow:0 的 widgets 槽，有内容才占行）：renderTodos（● Todos (done/total) 树 + ├─/└─ + ☐/◐/☑，todo/write 事件由 index.ts onEvent 转发，transcript 不再渲染 todo）+ renderAgents（● Agents 板：仅**运行中**子代理一行——spinner/provider+label/↻N≤M/token(+%)/耗时/⎿ activity；结算即从板上消失，全部结束后 widget 收起=「结束就清空」）+ tickLive（AGENT_TICK_MS 100ms 转 spinner/刷耗时，无事 no-op）+ setTheme（热切换重上色，无 ReplayOp 参与）+ clear；行宽先裁后上色（todo content width-6、agent label 按实际 chrome 宽算、activity width-8）；④ src/index.ts 接 onLive/liveTimer（unref，两处 teardown 清）/applyTheme 里 setTheme//new 与 /resume 里 clear。**重做**：首版做成 transcript 底部块被用户否掉（「这 2 个是 widget，固定在聊天窗口上面」）→ 移出 transcript 进固定槽；对应移除 messages.ts 的 live 代码（renderTodos/renderAgents/tickLive/agents ReplayOp/AGENT_*）。**鲸鱼改内联**：🐳 不再独占一行，前缀到首个文本块 `🐳: 文本`（trimStart 保证同行；WHALE_COLOR 独立行渲染删除）。新增 11 单测（test/live.test.mjs：树结构/空块/单多代理行/无 provider/结算即消失/tick/no-provider/宽 80 不变量/setTheme 保内容/clear/双 section 分隔）；theme-switch.test.mjs 的 todo 重放用例改为渲染器不再渲染 todo 后的等价物 | ✅ |
| O | 固定 5 行面板：think 块 + tool 卡 = 头部 1 行（bg + 状态色）+ 内容 4 行 tail（panelBodyText 尾部保留 + SGR 垫行带 bg；settle 只 setText 不重建块）；新增 chat 角色 thinkingPanelBg/toolBodyBg（复用 canvasSubtle）；'⟡'(U+27E1) 换 '💭'（用户终端方块）；无内滚——transcript 是 leaf Container，嵌套 ScrollView 拿不到 viewport（实测 0.84.2 dist/layout.js，src/messages.ts:13-20），用户拍板 tail 式 | ✅ |
| P | review B1-B5 + C 类修复：B1 面板长行防折行（先裁纯文本后上色 clipPanelLine，cap = 终端列 - 4，回退 200；实测 clipToWidth 对 ANSI 串按 grapheme 逐段计宽会误计——裁宽+上色顺序已修正）；B2 secret 掩码渲染（EditField secret 分支：'•' 点串 + ▎ 光标 + canvasSubtle 底，值不进 render 输出，handleInput 语义不变，存量 secret 字段编辑同享）；B3 credentials.set 失败文案追加 `export <REF>=<key> to use it` 兜底 + 原地重试幂等（「查看+重存 key」两段 submenu 超 ~40 行放弃，注释说明）；B4 justStoredRefs Set（同会话连续加两个 provider 状态列都显示 key set）+ provider-catalog env 空串真值判断；B5 commitNewProvider 落定后补 refreshModelsView（写入在途 Esc 时新行不再丢）；C4 单数 '1 model'；C7 providerDirectory 过滤 settingsNs==='llm-pi-ai'；C8 删重复 refreshCategoryList；C11 降级成功改 notice 通道（EditField CommitResult {error|notice}，notice 无 ✘ 前缀） | ✅ |

S 轮新增 11 单测（live.test.mjs）后全量 **171 个单测全过**（welcome 18 + theme 17 + theme-switch 28 + settings 19 + messages 14 + frame 11 + provider-catalog 11 + live 11 + permission 9 + sessions 8 + quotes 8 + text 7 + reload 6 + theme-settings 5 = 171）、`pnpm check` 0 error；tmux e2e 全通过（/settings 枚举钻入 cycle 编辑写回、分类层级纯英文 label（General/Models/Plugins）+ Esc 链、英文搜索过滤（model→Models、general→General）、C-u 清空搜索框、中文消息 echo 与模型中文回复无乱码、中文行宽 ≤ 终端列不挤变形、/think、/model 两阶段 Off/High/Max、/session 无会话+有会话面板、/resume 31 个会话列表+恢复+统计重建、/new 后渲染、冷启动 /export 守卫、footer 提示可见、/model 重启持久化、Ctrl+C 分级中断、/theme 预选 auto、还原 V4-Flash；e2e 前后 settings.yaml 一致）。本轮新增 e2e：**/reload 阻断复验**（gatekeeper 场景 tmux 实测——/reload 后输入正常：发消息出 transcript echo + 会话日志 user/message、Esc 不回显 `^[`、连续两次 /reload 均可用、运行中 Ctrl+C 第一次显示 ⏹ canceling 提示、idle Ctrl+C 正常退出；pi-tui 插桩日志确认旧 stop 恒先于新 start；agent 运行中 reload 会等 agent teardown 完成后才换 fiber，期间屏幕冻结属预期）；**/settings → Models**：OpenCode Go 行 value 显示 `catalog`（不再是 `0 models`）、description 显示 `API key set`（与 .credentials.yaml 一致，不再是 `API key missing`）；/model 选择器开关、中文 prompt echo 回归通过。本轮新增 e2e（O/P/Q/R 验收）：**主题热切换**（/theme 选完立即整屏换色（transcript/编辑器边框/footer 提示/spinner 同帧）、外部改 settings.yaml 的 `dsh-tui.theme` 热应用、DSH_TUI_THEME 钉住时 /theme 显示 pinned 提示且显示不换、切换期间弹层外输入正常、/resume 恢复后热切换重放正确）、**弹层边框**（6 个弹层顶/底 ─ 线完整、submenu 钻入后边框保持、24 行终端底部边框不丢）、**/session A1 焦点回归**（面板打开期间热切换后 Esc 关闭焦点回到新编辑器、后续输入不吞）、**watch 链路**（commit → 外部编辑双路径都生效）；**配置逐字节还原**（e2e 前后 settings.yaml + .credentials.yaml 快照 diff 为空）。

## 当前 backlog / 待办

1. **图片渲染**（用户已说"切回文本模型，跳过图片"——**当前不做**；以后真要加，链路已具备：`pi-tui` 的 `Image` 组件 + `ctx.get('attachment').readImage(ref)` → `Buffer.from(data).toString('base64')`）。
2. **打包**：当前 `package.json` 是 `"private": true`（本地开发够用）；要发 npm 就改 `private: false` 并 `npm login` 后 `npm publish`。
3. **GitHub 仓库清理**：`gh repo create fan56/dsh-tui-pi` 建过一个空仓库但没推上代码，gh token 没有 `delete_repo` scope，删不掉——你登录 GitHub 网页手动删。
4. **存量 mutate 冲突无重试**（review C10，本次未做）：`settings.mutate` 乐观锁失败只回读不重试；persistDefaultModel 已有单次冲突重试模式可参考，将来给 `write()` 加一次重试。
5. **deriveKeyRef 碰撞**（review C5，低概率，记录）：route key 非字母数字折叠后可能撞 ref（如 `a-b` 与 `a_b`），写 profile 前不检测；将来若加检测，在 commitNewProvider 里查 providers dict 的 apiKeyEnv 是否已被别的 id 占用。
6. **tool 卡 detail 行被计数覆盖**（review C3，设计取舍接受）：长 detail 行丢行后首行显示 `… (+N lines)` 计数，detail 原文被覆盖——tail 式面板的既定行为。
7. **agent 运行中 /reload 会等 turn 完成**（本轮记录，非 bug）：commands.ts:76 的本地命令直发只在**无 live agent** 时生效；有 agent 时 /reload 走 ctx.commands.execute 进 agent 命令队列，等当前 turn 完成才执行，之后还要等旧 fiber teardown（agent dispose 也在内）——期间屏幕冻结、输入不可用（raw mode 已还原）。行为安全（不竞态、必完成），但 UX 上属于"reload 期间等 agent"，可接受；若要优化可考虑让 reload 走无 agent 通道（不改，风险大）。

## 用户偏好 & 上下文

- **用户语言**：中文为主；commit/代码注释英文。
- **仓库位置**：`~/github/dsh-tui-pi`，git 已 init，main 分支，16 个 commit（本轮 O/P/Q/R/S 变更在工作区未提交）。
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
                    /session, /resume, /new, /settings, /reload) + footer + git watcher + 时钟 +
                    bridge + editor 分支 provider + 树级退出；/resume 里做 inspect 预校验、
                    renderer.clear() 后 firstLiveSeq 切分种子回放
  reload.ts         /reload 热重载：仿 cordis-plugin-hmr partialReload——按入口 module job
                    收集 user-code 依赖闭包（跳过 node:/node_modules）→ Map.prototype 清
                    ESM loadCache + CJS require.cache → loader.import() 重导入口 → 
                    registry.delete(旧 callback)（先删 runtime，loader 的 internal/plugin
                    才不标 entry disabled）→ **不能二次调 fiber.dispose()**（cordis effect
                    wrapper 对已 disposing 的调用返回 void 0，await 会瞬间通过、旧 TUI
                    stop 与新 TUI start 竞态死锁）——改 `setImmediate` 一拍后
                    `oldFibers.map(f => f.await())` 等 fiber 生命周期 inertia 收尾 →
                    parent.registry.plugin(新代码) 并接 entry 簿记；失败回滚缓存 + 重启
                    旧代码；模块级 re-entrancy guard；
                    entryUrl 直接用 index.ts 的 import.meta.url（+realpath 兜底）
  tui.ts            TUI 启动：TuiAltScreen + ScrollView (transcript) + VStack dock，
                    CwdBorderEditor（fgMuted info 色）、setLastRequest、lastRequest 容器；
                    StartTuiOptions.themePreference（'auto' 回退终端检测）
  session.ts        DshSessionBridge：构造时 eager 读 agentDefaultModel；ensureSession
                    lazy 建 agent（先等 resuming 互斥）；installModelSelection(agentCtx, mutableRef)；
                    setSelection(next) live 切换；detachCurrent()（/new 用：dispose agent 但保留
                    事件订阅 + 清 stats + 清 subagent 追踪并 onLive([])）；resume(sessionId)
                    （detach + agents.resume + seedSelectionFromDefault 保 live 选择 + 清追踪
                    并 onLive([])）；replay(events)（从零重建 stats、chunk 跳过、幂等；同时
                    折叠父日志 tool-workflow 事件重建 board）；**subagent 追踪器**：
                    agentViews（runId:seq→AgentView）/childSessions/trackedSessions/
                    childToKey —— session/event 火线不按 scope 过滤，foldTracked 折叠
                    tool-workflow/agent-start|end（父日志）+ subagent/descriptor/
                    assistant/message usage/llm/retry/tool/call/request/context（子日志）
                    → onLive(排序快照)；isRunning()（agent/status 镜像）+ cancelActiveTurn()
                    （agent.cancel keepInbox）；persistDefaultModel(ctx, selection)（首选
                    agentDefaultModel.saveSelection → settings.replace last-write-wins；
                    无服务时 fallback settings.mutate + 一次冲突重试）
  dsh-events.ts     本地声明 tool-workflow/agent-start|end、subagent/descriptor、llm/retry
                    事件类型 + `declare module '@deepseek-ai/dsh-session'` 合并进
                    SessionEventMap（声明包 dsh-tool-workflow/dsh-subagent/dsh-llm-retry
                    未装进插件）+ isAgentStart/isAgentEnd/isSubagentDescriptor/isLlmRetry
                    守卫 + AgentView 结构
  live-widgets.ts   LiveWidgets：固定 widget（tui.ts 的 root VStack 顶部 widgets 槽，
                    有内容才占行）——renderTodos（● Todos 树）/renderAgents（● Agents 板，
                    仅运行中子代理：spinner/provider+label/↻N≤M/token(+%)/耗时/⎿ activity；
                    结算即消失、全空收起）/tickLive（100ms 转 spinner/刷耗时）/setTheme/
                    clear；todo/write 事件由 index.ts onEvent 转发（transcript 不再渲染）
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
                      （首文本块前缀 `🐳: `，鲸鱼不再独占一行）
                    - addToolCard/settleToolCard：Container + status 色头 + args 行 + 10 行结果
                    - renderUserMessage：source.kind 去重（echo vs session 事件）
                    - renderCommandEcho：⌘ /cmd + 结果/错误
                    - todo/write 不再渲染（走 live-widgets，index.ts onEvent 转发）
  selectors.ts      pickEffort：resolveModelInfo(p, m).reasoning.efforts → SelectList
                    （'(provider default)' 行清除 effort 覆盖、当前值预选中）；
                    pickModel：两阶段——stage-1 选模型，暴露 efforts 再弹 stage-2
                    （先 show 新 overlay 再 hide 旧的，避免焦点闪跳；stage-2 Esc 整体取消；
                    resolveModelInfo 失败跳过 stage-2）
  frame.ts         FramedOverlay：每个 popup 的顶/底 `─` 边框 + spacer（共 4 行），
                    包整个 overlay root → SettingsList submenu 自动继承边框；6 个
                    showOverlay 包装点（selectors 3 / sessions 2 / settings 1）
  text.ts          宽度工具：clipToWidth（content-first 省略号、按 grapheme 截断）+ visibleWidth
                    （re-export pi-tui，east-asian 全角=2 列）；**所有自研截断必须走它，
                    禁止裸 String.length 截断**（12 处调用点：settings viewer、session panel、
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
  provider-catalog.ts 内置 provider 目录（10 条 catalog 路由）+ deriveKeyRef 约定
                    （route key 大写、非字母数字 → `_`、`_API_KEY` 后缀）+ providerProfileFor
                    （catalog 路由只存 apiKeyEnv；hand-declared 带 api/baseURL/models）+
                    providerRowView（label/summary/status 纯函数，env 由调用方注入）
  sessions.ts       `/session` 只读信息面板（SessionInfoPanel，Esc 关闭）+ `/resume`
                    选择器（sessionPersistence.list() → 过滤 origin==='subagent' 与当前会话 →
                    SelectList；inspectPersistedSession 预校验供调用方在 detach 前验证）
  footer.ts         PowerlineFooter：buildSegments + U+E0B0 箭头 + 7 段；
                    thinking 色按级别；context 按 <50/70/90% 切色
  editor.ts         CwdBorderEditor extends Editor：render 重写第 0 行（cwd + ⎇ branch，
                    fgMuted info 色保留可读）；scrollIndicator ↑
  git.ts            GitBranchWatcher：5s 轮询 git rev-parse，unref timer
  theme/
    palette.ts      githubLight（2026-08 重设计：canvas #fcfdfc 近白 + canvasSubtle #eef3ee
                    清灰绿 + accent #0a60b5 钢蓝 + 淡绿/淡紫/柔琥珀/低饱和玫瑰家族；fgSubtle
                    #637269 过 4.5:1）+ githubDark（#0d1117 家族，muted = 25% tint 实色 blend）
                    + detectDarkPalette (COLORFGBG 7/15→light)
    index.ts        ansiFg/ansiBg + BOLD/RESET 常量 + buildTheme + resolveTheme（env DSH_TUI_THEME
                    > preference > detect）+ POWERLINE 段色板（theme-agnostic）
test/theme.test.mjs    15 单测：ansiFg、dark blend 值、resolveTheme 优先级、buildTheme 完整性
test/settings.test.mjs 18 单测：formatValue/displayValue/unionLiterals、parseNumberInput
                    （decimal 白名单、拒 0x/0b/0o）、parseStringInput/parseUnionInput、
                    defaultValueFor（dict 加键种子）、fieldDescription、categorizeNamespaces
                    （全量/未映射/空/顺序/去重/映射无重叠）、categoryDescription
                    （60 边界截断、空成员、去重）
test/text.test.mjs     7 单测：clipToWidth（ASCII/全角中文/混合/surrogate emoji/边界
                    省略号/超宽全丢）、visibleWidth re-export
test/frame.test.mjs    8 单测：FramedOverlay 边框行/宽度/spacer/输入与 invalidate 转发/无
                    handleInput 子组件容错/wrapFramedOverlay
test/theme-switch.test.mjs 12 单测：setTheme 重放重建（bubble/工具卡/think 面板/todos/echo/
                    notice/在途流继续 setText/同 bundle no-op/clear 后不复活/5 行形状保持/
                    turn-end/assistant markdown）
test/theme-settings.test.mjs 2 单测：register → watch → sink 链路（applies 'live' 断言、
                    未知/缺失 theme 值 narrow 到 auto）
```

## 关键 API / 模式笔记

### dsh host 服务入口
```ts
ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model, reasoningEffort }, setup: agentCtx => installModelSelection(agentCtx, this.selectionRef) })
ctx.agents.resume({ resumeSessionId, agentOptions, setup })   // 恢复持久会话（bridge.resume 用）
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
ctx.on('session/event', (session, event) => ...)     // event.data per SessionEventMap
// **不按 scope 过滤**（dsh-scope 的 session/event resolver 为 null）：所有会话
// （含 subagent 子会话）的事件都会到达，bridge 按 session.id 区分父/子折叠
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
- **web UI 同样挂 llm-pi-ai**（重要澄清，写给下个 session）：web bundles = dsh-base + dsh-web-app，而 dsh-base 同时挂载 llm-pi-ai（cordis.patch.yml:95，零路由时休眠）和 llm-deepseek（:450）——LLM 层对 TUI 和 web 完全一致。用户在 web Models 页配置的 opencode-go 路由，就是 web 写进 `llm-pi-ai.providers` 的（dsh-client-ui-settings-models 的自定义 provider 固定写 llm-pi-ai ns）；TUI 与 web 共享 `~/.dsh/settings.yaml`，路由完全一致。llm-deepseek 的 deepseek-official 是出厂默认；用户当前默认路由 opencode-go 走 llm-pi-ai。
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
pnpm test                                     # 171 单测（welcome 18 + theme 17 + theme-switch 28
                                              #   + settings 19 + messages 14 + frame 11
                                              #   + provider-catalog 11 + live 11 + permission 9
                                              #   + sessions 8 + quotes 8 + text 7 + reload 6
                                              #   + theme-settings 5，pretest 自动 build）
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
