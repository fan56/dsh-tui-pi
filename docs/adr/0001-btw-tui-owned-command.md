# 0001 — /btw is a TUI-owned command, not an independent plugin

本仓库约定 plugin-owns-its-commands：独立 dsh 插件经 `ctx.commands` 注册自己的
slash 命令，dsh-tui-pi 不代劳。该约定有一个隐含前提——命令的交付物是数据效果，
任何 UI surface 都能执行并展示其返回文本。`/btw` 不满足这个前提：它的交付物是
终端 overlay、单飞队列、会话切换时的取消、最近对话的只读快照，全部绑在只有
dsh-tui-pi 持有的渲染循环与会话状态上。因此 `/btw` 是 TUI 自有命令（同
`/model`、`/theme`、`/agents` 一族），由 dsh-tui-pi 注册与渲染，不适用该约定。

## Considered options

- **独立 dsh-btw 插件 + 在 dsh-tui-pi 开「旁路问答渲染」缝** — 拒绝：插件能
  持有的只有命令注册，overlay 无法渲染；缝的成本等于先把 btw 的全部 TUI 代码
  写进 tui-pi 再借出去，功能未立先付抽象债。
- **若未来 Web UI 也想要 btw**：同 `/model` 的 Web-surface parity 先例——Web
  端实现自己的渲染器，两侧 autocomplete 目录对齐；这是届时抽公共层的触发
  条件，不构成今天先做缝的理由。
