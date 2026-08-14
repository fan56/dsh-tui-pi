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

- Phase A：✅ check/test 0 error，LICENSE、.gitignore、错误边界、无死代码
- Phase B：✅ TuiAltScreen + VStack；dock 固定，transcript 独立滚动（tmux 18 条消息验证）
- Phase C：✅ 真实 prompt → 流式回复 → markdown；bash 工具卡 ✔；Ctrl+C 树级退出
- Phase D：✅ `/` 补全（5 个注册命令）；`/compact`、`/plan` 执行成功；未知命令回落模型
- Phase E：✅ powerline 全分段实时（provider/model+thinking/context/CH%/msgs/tools/clock）；
  editor 顶边框 📁 cwd（git 仓库内加 ⎇ branch）；`↳ last-request`；统计全 O(1)
- Phase F：✅ `link:` 与 tarball 两种本地安装在全新 profile 验证启动；`npm pack` 35 文件
- 最终审核：✅ 完成（2026-08-14），交付物 = `dsh --profile tui`（用户 tui profile 已装 link: 版）

> 交付调整：用户决定不发布 GitHub（本地使用），git 安装路径不做；空仓库
> `fan56/dsh-tui-pi` 留待用户自行删除。
