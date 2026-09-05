# 0003 — /history 是线性列表回看器，不是 tree

pi 上游有 `/tree`（单 session 文件内消息级分支：每 entry 带 `id`/`parentId`，
内存 leaf 指针，双击 Esc 打开），而本插件 keymap 刻意不映射它（双击 Esc 已被
「停止任务」占用）。评估过把 tree 做进 dsh 后确认：dsh 的 session 日志是
seq 主键的线性 append-only log，**没有消息级 parent 指针**，pi 式文件内消息树
在宿主格式里无根；宿主原生支持的是 session 级谱系（`parentSession` +
`inheritedEventCount` + `fork(boundary)`），且日常会话几乎全部独立 `/new`，
谱系树退化为列表。因此 `/history` 定位为**只读回看器**：左栏用户消息线性列表
（seq 序），右栏该轮 LLM 回复，仅查看与 copy（回填编辑器，不重发、不分叉）。
这样零宿主改动、纯消费现有事件与 `sessionPersistence.inspect()` 冷读 API。

## Considered options

- **pi 式文件内消息树** — 拒绝：需要 dsh-session 格式升版本加 per-entry
  parent，影响所有 surface，成本与「回看」需求不成比例。
- **session fork 合成树**（UI 呈现消息树，底层 `ctx.sessions.fork(source,
  boundary)` 按 seq 边界种出新 session，切分支 = resume）— **推迟而非拒绝**：
  这是「分叉」功能本身，超出回看范围；/history 的左列表右详情骨架是它的子集，
  未来若做分叉，左栏升级为谱系树、UI 骨架不变。术语见 CONTEXT.md
  History browser 条目。

## Update (2026-09-05)

/history 增加了 fork at turn（`f`）：按选中轮把当前会话前缀 seed 进新 session
并切换——仍是一次 **session 级 fork**（seed 到选中轮 `turn/end`，宿主
`agents.create({ seed })` 机制），不是 pi 式消息级树；本决策的核心（不做
per-entry parent / 不升格式版本）不变，且当初推迟的「分叉」由此以子集形态落地。
