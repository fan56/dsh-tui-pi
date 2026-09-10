---
name: dsh-tui-pi-config
description: "dsh TUI 增强套件（@aiwayds/dsh-tui-pi）使用与配置指南。凡涉及 TUI 主题/面板/footer、子代理并发与轮数限制、模型收藏与隐藏、会话保留清理与 /resume 过滤、preset 记忆，或要配置 dsh-tui 段时先读本指南：settings.yaml 顶层 `dsh-tui:` 段 15 键（theme/panelHeight/maxAgents/maxRounds/maxRoundsGrace/disableSubagent/registeredOnly/footerHints/cacheHitMode/iconSet/rememberPreset/favoriteModels/hiddenModels/retention/resume）、DSH_TUI_* 环境变量、ask_user_question 快速上手向导、keybindings.json 与 /hotkeys。触发词：tui、主题、theme、面板、footer、收藏模型、隐藏模型、保留策略、panelHeight、resume、preset。"
---

# dsh-tui-pi 使用指南（TUI 主题 / 子代理治理 / 会话管理）

> pi 风格终端 UI 全套体验增强：主题与活动面板、footer 快捷键提示、`/model` 收藏与隐藏、
> `/history` 回看与 fork、`/preset` 预设切换、会话保留清理、子代理并发治理。
> 本插件同时是 `ask_user_question` 的 TUI 应答面——下面的向导交互在本 TUI 里原生成立。

## 配置入口（settings.yaml 顶层 `dsh-tui:` 段）

在 `~/.dsh/settings.yaml` 写顶层 `dsh-tui:` 段（注意段名是 `dsh-tui`，不是 `dsh-tui-pi`）。
主题 / 面板高度 / footer 提示 / 图标集为 `applies: 'live'`——保存提交即热生效，无需重启。

| 键 | 类型 | 默认 | 作用 |
|----|------|------|------|
| `theme` | `'auto'\|'light'\|'dark'` | `auto` | 配色方案；`auto` 跟随终端明暗（`/theme` 写回同一段） |
| `panelHeight` | `'1'\|'5'\|'7'\|'10'\|'all'` | `'1'` | think/tool 固定面板高度；`all` = 完整内容（推理 200 行尾随、工具结果 2000 行封顶） |
| `maxAgents` | 非负整数 | `4` | 并发子代理上限，`0` = 不限 |
| `maxRounds` | 非负整数 | `75` | 每个子代理 assistant 消息数上限，到达后注入收尾请求；`0` = 不限 |
| `maxRoundsGrace` | 非负整数 | `7` | 收尾请求后的宽限轮数，超出即强制终止（one-shot cancel / continuable 保留会话可续聊）；`0` = 仅警告不终止 |
| `disableSubagent` | 布尔 | `true` | 禁原生 `subagent` 工具，委派改走 `~/.dsh/agents/*.md` 注册代理（`use_agent`）；`subagent_fork`/`workflow`/`ralph` 不受影响 |
| `registeredOnly` | 布尔 | `false` | 仅 `use_agent` 可派生（子代理必须由 `~/.dsh/agents/*.md` 注册代理承载）；`subagent`/`subagent_fork`/`workflow`/`ralph` 全部拒绝 |
| `footerHints` | 7 个布尔 | 全 `true` | footer 快捷键提示分段开关：`send`/`stop`/`quit`/`quitEmpty`/`subagents`/`search`/`history` |
| `cacheHitMode` | `'lastMessage'\|'session'` | `lastMessage` | footer CH 段口径：最新一条消息的命中率（pi-tui 语义）或全会话累计 |
| `iconSet` | `'auto'\|'nerdfont'\|'plain'` | `auto` | 风险字形集；`auto` 按启动时字体探测选 nerdfont/plain |
| `rememberPreset` | 布尔 | `true` | 记住每个工作区（目录）最后一次 `/preset` 的选择，下次在同目录启动直接用它（替代服务端默认）；`false` 恢复始终用服务端默认。记忆存 `$DSH_HOME/workspace-presets.json` |
| `favoriteModels` | string[] | `[]` | 收藏模型（`provider/id` 键），钉在 `/model` 选择器顶部 |
| `hiddenModels` | string[] | `[]` | 隐藏模型（`provider/id` 键），移入 `/model` 的 Hidden 区 |
| `retention.maxCount` | 数字 | `100` | 启动清理器：最多保留这么多会话日志，`<= 0` 关闭清理器；下次启动生效 |
| `retention.maxAgeDays` | 数字 | `7` | 清理超过这么久未活动的日志（真删除）；下次启动生效 |
| `retention.minIdleHours` | 数字 | `24` | 按条数规则清理时的空闲保护小时数；下次启动生效 |
| `resume.maxAgeDays` | 数字 | `7` | `/resume` 选择器只显示这么新内的会话（显示口径，不删数据）；每次打开选择器生效 |
| `resume.minBytes` | 数字 | `20480` | `/resume` 选择器的最小压缩日志体积（显示口径）；每次打开选择器生效 |

### DSH_TUI_* 环境变量

| 变量 | 作用 |
|------|------|
| `DSH_TUI_RETENTION_MAX_COUNT` / `_MAX_AGE_DAYS` / `_MIN_IDLE_HOURS` | retention 三键的 env 兜底 |
| `DSH_TUI_RESUME_MAX_AGE_DAYS` / `_MIN_BYTES` | resume 两键的 env 兜底 |
| `DSH_TUI_THEME` | `light`/`dark` 硬钉显示配色（优先于偏好设置） |
| `DSH_TUI_TRANSPARENT` | `1` 恢复透明终端背景 |
| `DSH_TUI_MOUSE` | `buttons`（默认）\|`all`\|`off`，鼠标跟踪模式 |
| `DSH_TUI_COPY_ON_SELECT` | `0` 让拖选仅视觉选中、不自动复制（默认开） |
| `DSH_TUI_BTW_CONTEXT_MESSAGES` | `/btw` 侧问快照的最近消息条数 |
| `DSH_TUI_SKIP_HOST_CHECK` | `1` 跳过宿主版本下限检查（测试用） |

retention/resume 组的优先级：**settings.yaml 显式值 > env > 默认**（只看 settings.yaml 里
实际写下的键，未写的键回落 env，再回落默认）。

## 交互式快速上手（ask_user_question）

新用户说"帮我配置 TUI / 配置 dsh-tui"时，不要甩文档让对方自己读——用 `ask_user_question`
只问三题，然后代写配置：

1. **主题**：`auto`（跟随终端，推荐）／`light`／`dark`。
2. **面板高度**：`'1'`（单行摘要，推荐）／`'5'`／`'7'`／`'10'`／`'all'`（完整内容）。
3. **子代理并发**：`maxAgents` 4（默认）／8／0（不限）。

收集完把 `dsh-tui:` 段写进 `~/.dsh/settings.yaml`——**只写问过的键**，未问的键留在默认值。
用户要细调时再指向上面的全表：footerHints 分段、cacheHitMode、iconSet、
favoriteModels/hiddenModels、retention/resume。

## 命令与文件面

| 命令/文件 | 作用 |
|------|------|
| `/theme` | 选配色，写入 `dsh-tui.theme` 并即时生效 |
| `/hotkeys` | 按键重映射浏览器，写 `~/.dsh/keybindings.json`（部分 JSON 映射，实时应用） |
| `/model` | 模型/think 选择器；`f` 收藏、`h` 隐藏即写 `favoriteModels`/`hiddenModels`（收藏行拒绝 `h`，先取消收藏） |
| `/preset` | 切换 agent preset（确认对话框：fork 携带历史 / 全新开始 / 取消；`/preset next` 循环）；默认按工作区记忆上次选择（`rememberPreset`） |
| `/history` | 只读回看会话逐轮历史；`f` 在选中轮 fork 新会话，`/history <id>` 冷读任意存档 |
| `/resume` | 恢复持久会话（受 `resume.*` 显示窗口过滤；`--resume <id>` 启动参数同源） |
| `/agents` | 管理 `~/.dsh/agents/*.md`；`l` 进 limits 面板热调 `maxAgents`/`maxRounds`/`maxRoundsGrace`/`disableSubagent`/`registeredOnly`（`r` 快捷切换 registered-only 栅栏） |
| `/profile-switch` / `/profile-cfg` | 模型配置档，存储于 `$DSH_HOME/model-profiles.json` |
| `~/.dsh/APPEND_SYSTEM.md` | 用户可编辑的主 agent system prompt 追加文件（不作用于子代理） |

## 排障

1. **图标乱码** → `iconSet: 'plain'`（或 `node scripts/install-font.mjs` 安装 Nerd Font 后用 `auto`/`nerdfont`）。
2. **/resume 看不到老会话** → `resume.maxAgeDays`/`minBytes` 只是选择器显示口径，会话没丢；
   放宽这两个键（settings.yaml 显式值或 env）即可看到。
3. **会话目录（~/.dsh/sessions）膨胀** → retention 三键治理；注意清理器**真删除**，
   与 resume 的"只隐藏"是两回事。
4. **/model 选择器太长** → 把不用的挑进 `hiddenModels`；常用的钉顶 `favoriteModels`。
5. **footer 提示太多/太少** → `footerHints` 七段各自独立开关。
6. **双 Esc 后还在烧 token** → 双 Esc 现弹"停止一切"确认框（列明正在跑的主 turn 与子代理数），
   Enter 才真停，Esc 维持运行；后台子代理会被逐个取消。单个子代理的停止入口在
   Ctrl+G 查看器里按 `x ×2`。
7. **/preset 每次启动都回到默认** → 检查 `rememberPreset` 是否被设为 `false`；记忆按工作区
   目录各自独立，存于 `$DSH_HOME/workspace-presets.json`，关掉再开不会丢。
