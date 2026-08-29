# CONTEXT.md — terminology

Shared vocabulary for this repo. Definitions only — implementation details
live in ARCHITECTURE.md / HANDOFF.md.

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
- **Provider**: `ctx.userQuestions.registerProvider` 注册的回答端实现；
  单一活跃 provider，重复注册让位为 no-op 不崩溃
  (the answering-side implementation registered on the `userQuestions`
  capability seam; single active provider — a duplicate registration yields
  a no-op instead of crashing)
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
