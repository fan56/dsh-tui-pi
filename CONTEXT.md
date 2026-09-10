# CONTEXT.md — terminology

Shared vocabulary for this repo. Definitions only — implementation details
live in ARCHITECTURE.md / HANDOFF.md.

- **Closure（宿主闭包）**: 随 dsh CLI 一起安装的 `@deepseek-ai/*` 子包集合；
  插件类型与运行时的唯一真源——源码 import 的所有 `@deepseek-ai/*` 都经
  `scripts/link-dsh-closure.mjs` 软链解析到同一个 closure 实例，typecheck
  看到的类型图就是宿主运行的那份
  (the set of `@deepseek-ai/*` sub-packages installed alongside the dsh CLI;
  the single source of truth for the plugin's types and runtime — every
  `@deepseek-ai/*` import resolves through symlink to that one closure
  instance, so tsc sees exactly the type graph the host runs)
- **Floor**: peer 声明中本插件要求的宿主最低版本，`>=` 语义——不精确钉，
  随宿主滚动线向上（当前 `dsh-user-questions >= 0.1.2-rc.1`）
  (the minimum host version a peer declaration requires, `>=` semantics —
  deliberately not an exact pin; it only ratchets up along the host's
  rolling line, currently `dsh-user-questions >= 0.1.2-rc.1`)
- **Era**: rc/alpha 双路径兼容模式——插件同时支撑两条宿主形状分支、运行时
  feature-detect 选路。**已废弃**：2026-09-01 起 single-target，2026-09-03
  起目标线为 rc/stable（`0.1.2-rc.1+`），alpha 路径退役，双路径分支与其测试
  一并删除（ADR 0002，已被 rc/stable 目标取代）
  (the rc/alpha dual-path compatibility mode — supporting two host shapes
  with runtime feature-detection. **Deprecated**: single-target since
  2026-09-01, retargeted to the rc/stable line (`0.1.2-rc.1+`) on
  2026-09-03 — the alpha path is retired and the dual branches plus their
  tests are gone, see ADR 0002)
- **Favorite**: 用户标记为收藏的模型，以 provider/id 标识，持久意图，置顶显示
  (a model the user starred; identified by its provider/id composite key,
  persisted, pinned to the top of the picker)
- **Hidden model**: 用户隐藏的模型，从主列表移入底部 Hidden 区，可恢复
  (a model the user hid; moved out of the main list into the dim Hidden
  section at the bottom, restorable)
- **Filter**: 会话内临时子串过滤，不持久，每次打开面板重置
  (a session-local substring filter over the model list; never persisted,
  reset every time the panel opens)
- **Divider row**: 收藏区与普通区之间的不可选中分隔行
  (the full-width unselectable separator line between the Favorites section
  and the normal section)
- **Ask user question**: 模型回合中通过 `ask_user_question` 工具向人发起的
  结构化提问；工具调用挂起直到用户作答，答案以规范信封作为工具结果返回
  (a structured question the model asks the human mid-turn through the
  `ask_user_question` tool; the tool call stays pending until answered, and
  the canonical answer envelope returns as the tool result)
- **Provider**: 回答端实现——挂在 Agent-scoped 的 `'user-questions/request'`
  cordis waterfall 上（返回即认领，`next()` 即让渡）；alpha 起这是宿主唯一
  的回答端注册方式，`registerProvider` 单槽已删除。单一活跃 TUI 答端，
  不属于本会话的 ask 经 `next()` 让渡
  (the answering-side implementation — composed on the Agent-scoped
  `'user-questions/request'` cordis waterfall (return to claim, `next()` to
  delegate). Since alpha this is the host's only answerer registration; the
  `registerProvider` slot is gone. One active TUI answerer; asks from other
  sessions delegate through `next()`)
- **Sentinel row**: 每个问题选项列表末尾的「Type something.」自由输入行，
  已写入自定义答案时显示 `✎ <text>`
  (the free-text input row appended after every question's option list;
  shows `✎ <text>` once a custom answer was written into it)
- **Review phase**: 多问题（≥2）提交前的复核页——逐题列出当前答案、可就地
  改答，Submit answers 行才真正提交
  (the pre-submit page for multi-question overlays — every answer listed,
  each row editable in place; only the Submit answers row commits)
- **Double-Esc decline**: 200ms 窗口内连按两次 Esc 拒答——返回全题 declined
  信封；overlay 被外部关闭（主题切换 / `/reload` / abort）同样按拒答结算
  (two Esc presses within 200 ms decline the overlay — every question gets
  the declined envelope; an externally closed overlay settles as declined too)
- **Steer message**: agent 运行中提交、于当前 turn 的下一个 step 边界注入的消息
  （core 原语 `agent.steer()`，target `'next-step'`）
  (a message submitted while the agent is running, injected at the next step
  boundary of the current turn)
- **Follow-up message**: 排队等待、在下一 turn 开始时作为首条消息投递的消息
  （core 原语 `agent.followup()`，target `'next-turn'`）
  (a queued message delivered as the first input of the next turn)
- **Pending**: 已提交但尚未被 inbox 领取的消息；唯一可撤销/可改道的阶段
  (submitted but not yet claimed from the inbox; the only phase where a
  message can be undone or rerouted)
- **Claimed (consumed)**: 已被 inbox 领取并落盘为普通 user 消息；此后不可撤销，
  无特殊展示
  (taken from the inbox and persisted as a plain user message; no longer
  undoable, no special display)
- **Promote (strict steer)**: 把排队的 follow-up 移出队列并立即 steer 注入当前轮
  (removing a queued follow-up from the inbox and immediately steering it
  into the current turn)
- **Badge terminal state**: 路由回显徽标的终态——撤销→淡色删除线
  `✕ canceled`、投递失败→`✘ not delivered`、abort 后已不在 inbox 的消息同样按
  canceled 收尾；⏳/↪ 不允许永久残留
  (the end state of a routed-echo badge — a revoke shows a faded
  struck-through `✕ canceled`, a failed delivery shows `✘ not delivered`,
  and an abort resolves echoes whose message left the inbox as canceled; a
  ⏳/↪ badge may never linger as a ghost)
- **Btw**: 主线 agent 运行中用户以 `/btw <问题>` 发起的顺带提问，by the
  way——空闲时不可用，被拒并指引正常提问；不占用主线、不落盘
  (a by-the-way question posed while the main agent is running; rejected when
  idle, where a normal prompt is strictly better; never touches the main line
  or the session log)
- **Side call**: 回答 btw 的独立单次模型调用：无工具、带最近对话的只读快照，
  与主线互不感知；默认同当前会话模型，可临时覆盖
  (the tool-less one-shot model call that answers a btw, running over a
  read-only snapshot of recent conversation; same model as the session unless
  overridden)
- **Btw overlay**: 呈现 btw 问答的浮层；不落盘，关闭后 resume/重启不可恢复
  (the overlay presenting a btw exchange; never persisted — gone on
  resume/restart)
- **Last-btw slot**: 进程内单槽缓存最近一次 btw 问答，供 `/btw` 空参回看；
  随进程消亡，仍不落盘
  (the in-process single slot holding the most recent btw exchange, reopened
  by bare `/btw`; dies with the process, still never persisted)
- **Queued btw**: btw 在跑时新提交的请求，单并发下排队依次执行；主线变故
  （切会话 / `/new` / abort）时在跑与排队的一并取消
  (a btw submitted while another is in flight, queued behind it; a main-line
  disruption — session switch / `/new` / abort — cancels running and queued
  alike)
- **History browser (/history)**: 只读回看器——左栏当前 session 的用户消息
  线性列表（按 seq 序；是列表不是树，session 日志无消息级分支），右栏显示
  选中轮的 LLM 回复；查看与 copy（回填编辑器），不重发、不定位主
  transcript；唯一例外是 fork at turn（`f`）：按选中轮分叉新 session 并
  切换（仍为 session 级 fork，非消息级树）。live 浏览下原会话不动；
  cold 浏览（被浏览 ≠ live）时被 detach 的是 live 会话（仍可 /resume），
  被浏览会话本身永远不动
  (a read-only look-back viewer — left pane lists the current session's user
  messages linearly in seq order (a list, not a tree: the session log has no
  message-level branching), right pane renders the selected turn's LLM reply;
  view and copy (refill the editor), no resend, no transcript jump — with
  one exception, fork at turn (`f`): branch a new session at the selected
  turn and switch to it (still a session-level fork, not a message-level
  tree). Live browse: the original session is untouched. Cold browse (the
  browsed session ≠ live): the LIVE session is the one detached, still
  resumable via /resume; the browsed session is never touched)
- **Cold read (冷读)**: 经宿主 persistence API 只读查看未激活 session 的事件
  日志——不取写所有权、不 resume、不激活 agent
  (read-only viewing of an inactive session's event log through the host
  persistence API — no write ownership, no resume, no agent activation)
- **Wrap-up 注入（wrap-up injection）**: 子代理到达轮数上限时 policy 注入的一条
  插件源 user 消息，要求立即收尾不再调工具。软限制——child LLM 可以无视；每个
  child 只注入一次，全程以 `⚡` 标记可见
  (the plugin-sourced user message the policy injects when a child reaches its
  round cap, demanding an immediate finish with no further tool calls. Soft —
  the child LLM may ignore it; exactly one per child, always visible as the
  `⚡` marker)
- **宽限（grace）**: wrap-up 注入后允许 child 继续烧的轮数；默认 7，`0` = 关闭
  硬停退回纯软模式（历史行为）
  (rounds a child may keep burning after the wrap-up injection before the
  policy stops asking; default 7, `0` disables hard stop entirely — pure-soft
  mode, the historical behavior)
- **硬停（hard stop）**: 达 `cap + grace` 轮时代码强制终止 child，不再请求
  child LLM 同意。child 转录以 `⏻` 标记。不是处决：会话保留，continuable
  child 可 Ctrl+G 查看、可续聊；one-shot child 同名下次派发自动 resume 续跑
  (at `cap + grace` rounds the code forcibly stops the child — no consent
  asked from the child LLM. Marked `⏻` in the child transcript. Not an
  execution: the session persists; a continuable child stays inspectable
  (Ctrl+G) and resumable; a one-shot child's next same-name dispatch resumes
  its partial work)
- **Prune**: 超员兜底——live children 已占满 cap 时新到达的 child 被 cancel
  （杀最新）。被杀 child 的部分工作持久可 resume，prune 是回收不是浪费
  (the over-cap backstop at `subagent/start`: a newcomer arriving while live
  children fill the cap is cancelled — kill the newest. Its partial work
  persists and is resumable; pruning is recovery, not waste)
- **Surface 标记（surface marker）**: cordis scope 键，标记本 TUI 创建/恢复的
  agent；一切 enforcement 判定的锚点；无标记 caller fail-open，祖先链回溯除外
  (the cordis scope key marking an agent as created/resumed by this TUI; the
  anchor for every enforcement decision; unmarked callers fail open, except
  through the ancestor walk)
- **祖先链回溯（ancestor walk）**: spawn caller 无标记时，guard 沿
  `parentSession` header 逐级查进程内活祖先的标记——链上任一级带标记，整棵
  TUI 派生树纳入 enforcement；外来根会话（如 feishu 创建）维持 fail-open
  (when a spawn caller carries no marker, the guard walks `parentSession`
  headers through live agents — any marked ancestor puts the whole
  TUI-descended tree under enforcement; a foreign root (e.g. a feishu-created
  session) stays fail-open)
- **对账（reconcile-projection）**: 用宿主权威后代清单周期性校正 firehose 折叠
  的 live 视图——同治 burst 欠账与"child 事件不上浮"的计数死 0；校正值只上
  不下（双账本 max 合并）
  (periodically correcting the firehose-folded live view against the host's
  authoritative descendant listing — fixes burst under-counting and the
  dead-at-zero count of children whose events never bubble up; corrections
  only move counts up, dual-ledger max-merge)
- **模型路线（model route）**: child 的生效 LLM 路线——`provider/model` +
  thinking 等级，派发时合成（frontmatter 基线 + profile pin 覆盖）。与
  **subagent provider**（传输层，如 `spawn`）是两个概念：旧 UI 曾混用同一
  `provider` 字段，viewer 现分开呈现（路线行 vs. 行尾 `spawn`）
  (the child's effective LLM route: `provider/model` + thinking level,
  composed at dispatch (frontmatter baseline, profile pin override). Distinct
  from the subagent provider (the transport, e.g. `spawn`) — the old UI
  conflated the two under one `provider` field; the viewer now names them
  separately)
- **Per-agent cap**: agent 文件 frontmatter 的 `maxRounds` 键，覆盖全局
  `dsh-tui.maxRounds` 对该 agent 派发 children 的适用；解析惰性（首次触顶时
  label→roster 反查）且 fail-closed 到全局——任何查找失败都落到全局值。
  `maxAgents` 恒为全局——并发是整棵树的预算，永不 per-agent 化
  (a `maxRounds` frontmatter key on an agent file overriding the global
  `dsh-tui.maxRounds` for children dispatched under that agent; resolution is
  lazy (label→roster lookup at first cap crossing) and fails closed to the
  global cap. `maxAgents` stays global-only — concurrency is a whole-tree
  budget, never per-agent)
