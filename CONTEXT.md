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
