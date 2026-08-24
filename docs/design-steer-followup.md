# Steer / Follow-up 消息的 TUI 处理与展示设计（v1）

背景：dsh-tui-pi 目前对 steer message 和 follow-up message 没有专门的 TUI 显示设计；主会话输入硬编码走
`followup()`（src/session.ts:505），运行中发的消息永远不会 steer 当前轮，与上游 web 客户端行为不一致。
本设计补齐路由选择、pending 展示与撤销能力。

## 一、术语定义

- **Steer message**：agent 运行中提交、于当前 turn 的下一个 step 边界注入的消息（core 原语
  `agent.steer()`，target `'next-step'`）。
- **Follow-up (queued) message**：排队等待、在下一 turn 开始时作为首条消息投递的消息（core 原语
  `agent.followup()`，target `'next-turn'`）。
- **Pending**：已提交但尚未被 inbox 领取的消息；唯一可撤销/可改道的阶段。
- **Claimed (consumed)**：已被 inbox 领取并落盘为普通 `user/message`（无任何 steer/followup 标记字段）；
  此后不可撤、不特殊标注。
- **Promote (strict steer)**：把排队的 follow-up 移出队列、立即 steer 注入当前轮（host 语义即
  `session.updateQueue {kind:'steer'}` = remove + steer）。

### 关键运行时事实（调查已证实，作为约束写进文档）

- 领取后的消息落盘为普通 `user/message`，`source.kind === 'user'`，无类型字段；唯一显式区分是 pending
  阶段 `agent/inbox/spliced` 事件的 `target: 'next-step' | 'next-turn'`。
- 因此特殊展示只能可靠覆盖 pending 阶段；这是「claimed 后回归普通样式」决策的根因。

## 二、行为设计

### 1. 提交路由（自动 + 弹窗选择）

- agent 空闲 → 直接发送（steer/followup 等价，均唤醒新 turn），不弹窗。
- agent 运行中 → 提交时弹双选项 overlay 弹窗：
  - 「Queue as follow-up」/「Steer now」两个选项；
  - ↑↓ 或数字键选择，Enter 确认；
  - Esc 取消且草稿保留回输入框（消息不发送）。

### 2. 竞态兜底

用户选 Steer now 但 turn 恰好结束（steer-unavailable）→ 自动降级为排队 follow-up，
并弹 notice 说明实际走向。

### 3. 撤销

仅 pending 可撤。快捷键打开「待发送队列」overlay 面板，条目上按 `d` = remove
（core `Inbox.remove(messageId)`，removed 记 outcome `'canceled'`）。
已 claimed 的消息不可撤（v1 不做上下文回滚）。

### 4. Promote

同一队列面板条目上按 `s` = strict-steer；同样兜底 steer-unavailable 自动降级。

### 5. v1 明确不做

- 编辑已排队消息（core 有 `inbox.replace` / host updateQueue edit 能力，留 v2）；
- 撤销已消费消息；
- resume/replay 后对历史消息按 seq 位置推断标注（对齐上游 web 做法：只对 pending 特殊显示，
  领取后回归普通 bubble）。

## 三、展示设计

- Pending 行内 bubble + badge：`⏳ queued` 前缀（follow-up）/ `↪ steer` 前缀（steering），
  badge 标注路由走向。（注意：badge 字符属于 TUI 显示文本，最终实现时须遵守仓库 AGENTS.md 的
  UI 文本 English-only 约束——如需英文 badge 文案如 "queued" / "steer"，符号前缀可保留。）
- Claimed 后原位回归普通 user bubble 样式。
- Resume/replay 加载历史：一律普通 bubble，不做位置推断。
- 降级/promote 成败等事件复用现有 notice 机制提示（renderer.renderNotice，buffered，
  经受主题切换 rebuild）。

## 四、实现锚点（均已核实存在）

### 路由出口

src/session.ts:505 `prompt()` 现无条件 `handle.agent.followup(message)`
（`createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })` 后直接
followup）。改为按弹窗结果分流 `steer()` / `followup()`；消息构造保持不变。

### overlay 面板模板

src/subagent-viewer.ts 的 SteerInputPanel（约 650-780 行）+ `resolveInjectionRoute`
（112-157 行，按 `agent.status === 'running'` 路由，idle → followup，其余 fail-closed 为 ended）
——主会话弹窗与队列面板直接复用此模式。可复用的既有机制：

- SteerInputPanel 用 pi-tui `Editor` 包 `disableSubmit` 让 Enter 到达面板而非清空编辑器；
  发送延迟到 microtask（keypress 栈外）并带 pending guard，失败显示行内 ✘ 并保留文本可重试——
  主会话双选项弹窗沿用同样的 deferred-delivery / 单次终态 guard 结构。
- `resolveInjectionRoute` 是纯函数（AgentView + SteerableAgent in，route out），
  主会话提交路径可直接调用做「空闲直发 / 运行中弹窗」的判定。
- 子代理路径的 `deliverSubagentSteer` 已演示 try/catch 把原语抛错折叠为
  `{ outcome: 'error' }` 的兜底形态；主会话 steer-unavailable 降级照此处理。

### 按键注册

- src/keymap.ts app 层：`DEFAULT_KEYBINDINGS` / `mergeKeyBindings` /
  `resolveKeyAction`（307 行起，先于 editor 组件消费按键），队列面板快捷键在此注册；
  双击类状态机常量（DOUBLE_PRESS_MS 等）已有先例。
- src/hotkeys.ts：`keybindings.json` 可重映射契约（`loadKeyBindings` 校验、
  `appHotkeyRows` 展示、`/hotkeys` HotkeysManager 编辑）——新按键须进该契约才可被用户重映射。

### API

TUI 进程内直连 agent handle（bridge.ensureAgent() 已暴露同步句柄访问），撤销/promote 直接调
`agent.inbox.remove(id)` / 移除后 `agent.steer(msg)`，无需经 host RPC。
错误码 `queue-item-not-found` / `steer-unavailable` 需兜底：
前者说明条目已被领取或已被移除（刷新队列面板即可）；后者触发自动降级为 follow-up + notice。

### 渲染现状

- src/messages.ts:299-321 `renderUserMessage` 仅区分 `kind === 'user'`（bubble，
  `▎ ` 前缀逐行渲染）与 inject（`ⓘ` 单行截断预览）；本地 echo 在 index.ts:1311
  `renderPromptEcho` 先行渲染、靠 `lastEcho` 与 session echo 去重（同文本回声到达时置空并跳过）。
- Pending badge 需与该去重机制协同：pending 提交时本地 echo 带 badge 渲染，
  session 回声若文本一致仍走 lastEcho 折叠；claimed 后的正式落盘事件按普通 bubble 渲染。
  badge 只存在于本地 echo 与 pending 期间的事件视图，不进入持久化文本。

## 五、决策记录（含被否选项）

| 决策点 | 采用 | 被否选项及原因 |
|--------|------|----------------|
| 撤销边界 | 仅 pending 可撤 | 已注入可撤/回滚；撤销=重新编辑 |
| 路由控制 | 自动判断 + 运行中弹窗显式选择 | 纯自动、纯手动每次都选、修饰键手势 Alt/Ctrl+Enter——键位调查显示 Ctrl+Enter 无 legacy 回退、Alt+Enter 在 tmux 下有透传风险，且基类 Editor 会把 `\x1b\r` 吃成换行，故改用弹窗方案 |
| Promote | v1 就做 | 初判缓做，后因确认 core/host API 现成且成本极低而推翻 |
| Pending 展示 | 行内 bubble + badge | 独立 QueueDock 区块、仅计数指示 |
| 撤销入口 | 队列 overlay 面板 | 行内循环选中、斜杠命令 |
| Claimed 后 | 回归普通样式，resume 不推断 | 淡痕迹保留、seq 位置推断 |
| 竞态兜底 | 自动降级 + notice | 退回输入框重发 |
