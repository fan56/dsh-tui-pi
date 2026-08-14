# dsh-tui-pi 任务拆分与验收标准

交付物：一个可通过 **本地 npm 路径** 或 **代码仓库（git）** 安装、随后在 **terminal 中直接使用** 的 pi 风格 dsh TUI。

## 关键节点（里程碑）与验收标准

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **A. 清理** | 修 review 发现的问题 | `pnpm check` 0 error；无未用 import；无死代码；`LICENSE` 存在；`.gitignore` 含 `.DS_Store`；smoke test 正常启动退出 |
| **B. 布局** | TuiAltScreen + VStack，dock 固定底部 | tmux 里：transcript 增长时 dock 不动，transcript 独立滚动 |
| **C. 会话** | agents.create + followup + session/event 渲染 | 发 prompt → 流式出 assistant 回复 → 工具调用渲染成卡片 → idle/working 状态正确 |
| **D. slash 命令** | ctx.commands.list 补全 + execute | 敲 `/` 出补全菜单；`/compact`、`/plan` 等执行成功并渲染 flow 节点；保留 dsh 全部已注册命令 |
| **E. footer** | powerline 分段 + cwd/branch 顶边框 + last-request | 分段色与 pi-powerline-footer 一致；时钟每秒走；长会话无 Enter 卡顿（增量统计） |
| **F. 打包验收** | npm 本地安装 + dsh plugin add + terminal 实跑 | `dsh plugin --profile tui add <path>` 成功；`dsh --profile tui` 启动并可用；`npm install /path` 能装 |

## 自主执行约定

- 中间不再询问用户，按上表推进。
- 每个阶段完成后跑 `pnpm check` + tmux 实测。
- 全部完成后做一轮完整 review & 审核，收集证据，再标记 goal 完成。

## 进度记录

- Phase A：进行中
