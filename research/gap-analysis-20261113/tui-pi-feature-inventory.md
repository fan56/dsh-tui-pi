# dsh-tui-pi 功能底账盘点（静态分析）

- 盘点对象：`~/repo/dsh-tui-pi`（真实路径 `/Users/qingguee/repo/dsh-tui-pi`）
- 盘点方式：纯代码/文档静态分析，不跑 TUI、不做与 dsh-opentui 的对比判断
- 盘点日期：2026-11-14
- 代码规模：`src/` 83 个 TS 文件，约 34,205 行（`wc -l src/*.ts`）
- 架构要点：TUI 是 dsh 宿主的一个插件（pi-tui 渲染层），斜杠命令主体委托 dsh 宿主命令注册表，仅 TUI 自有命令本地注册（`src/commands.ts:1-16`）

---

## 1. 斜杠命令全集

### 1.1 TUI 自有命令（本地注册，`registerLocalCommand`，见 src/index.ts:1118-1129）

| # | 命令 | 参数 | 功能 | 注册位置 |
|---|------|------|------|----------|
| 1 | `/btw` | `[问题] [@provider/model]` | By-the-way 侧问：工具无关的一次性模型调用，流式渲染到 overlay，不入会话日志；裸 `/btw` 回看上次结果 | src/index.ts:1216（ADR docs/adr/0001） |
| 2 | `/model` | 无 | 模型选择器（跨 provider 聚合目录，收藏 f / 隐藏 h，搜索过滤），选中即生效并持久化 | src/index.ts:1247；picker src/selectors.ts:263 |
| 3 | `/agents` | `[名称]` | Agent 定义 markdown 管理器（model / think level / spawn depth，frontmatter 编辑），可选参数预选 | src/index.ts:1262；src/agents.ts:256 |
| 4 | `/subagents` | 无 | 子代理查看器（Ctrl+G 命令孪生）：选运行中/已结束子代理看实时 transcript（80% viewer） | src/index.ts:1271 |
| 5 | `/think` | 无 | 循环/选择当前模型 reasoning effort（不换模型），无会话也可设 | src/index.ts:1314；picker src/selectors.ts:142 |
| 6 | `/preset` | `[name\|next]` | Agent preset 切换：picker / 直接命名 / next 轮换；有活会话先确认（fork 或新开），带 fork-at-turn 携带历史；记忆到 workspace-presets.json | src/index.ts:1453；picker src/selectors.ts:532；确认 src/preset-dialog.ts:212 |
| 7 | `/session` | 无 | 会话信息面板：id、cwd、创建时间、模型/effort、消息/工具数、token 明细、整体 TPS、分路由 TPS、父会话、标题（可 /rename 内嵌改名） | src/index.ts:1544；面板 src/sessions.ts:330 |
| 8 | `/resume` | 无（boot: `--resume <id>`） | 持久化会话选择器：校验日志→换活 agent→重建 transcript+统计；坏日志走修复确认；写锁被占降级只读 watch | src/index.ts:1714；picker src/sessions.ts:909 |
| 9 | `/search` | 无 | 跨会话全文搜索 overlay（sessionQuery FTS 索引）；命中 Enter 直接 resume，子会话命中转 `/history <id>` 只读浏览 | src/index.ts:1741；overlay src/search.ts:369 |
| 10 | `/history` | `[sessionId]` | 只读双栏回看器（ADR 0003）：左栏已完成 turn 列表，右栏该 turn 回复；Enter/c 回填编辑器；`s` 换浏览会话；支持 fork-at-turn | src/index.ts:1819；src/history.ts:931 |
| 11 | `/export` | `[path]` | 导出当前会话事件为 JSONL（默认 ~/Downloads/dsh-session-<id8>.jsonl）；无会话时本地报错不预热会话 | src/index.ts:1885-1913 |
| 12 | `/new` | 无 | 脱钩当前会话清屏，下一条消息开新会话（取消在跑 btw） | src/index.ts:1968 |
| 13 | `/settings` | 无 | 设置浏览器：分类→命名空间→字段三层钻取，cycle 行、内联编辑、dict 加键、reset；含自定义 provider 添加/编辑流 | src/index.ts:2011；src/settings.ts:937 |
| 14 | `/plugins` | 无 | 插件管理面板：Enter 启/停，d 卸载（确认），i 安装（inspect 预览），`/` 过滤 | src/index.ts:2029；src/plugins.ts:468 |
| 15 | `/skills` | 无 | 技能浏览器：Installed/Available 双模式，Enter/Space 切换或符号链接，Tab 换视图 | src/index.ts:2038；src/skills-manager.ts:713 |
| 16 | `/theme` | 无 | 主题选择器：auto/light/dark 常驻行 + 注册主题（内置+用户 `$DSH_HOME/themes`），带实时预览面板，热切换并持久化 | src/index.ts:2078；src/theme-preview.ts:244 |
| 17 | `/language` | `[id]` | 切 UI 语言：裸命令走 ask-user 面板选择，带参直切；热生效并持久化 | src/index.ts:2135；src/language-ask.ts:148 |
| 18 | `/reload` | 无 | 热重载本插件（重 import 模块换 runtime）；重载后自动 resume 原会话（stash 机制，src/index.ts:1701-1725） | src/index.ts:2146 |
| 19 | `/hotkeys` | 无 | 按键绑定浏览器：列出 app 键，Enter 打开编辑器写 `~/.dsh/keybindings.json` 并实时生效 | src/index.ts:2159；src/hotkeys.ts:250+ |
| 20 | `/login` | `[provider]` | Provider 凭据注册：可搜索 provider 目录 + 掩码 API key 编辑器，提交 provider profile + 凭据 | src/index.ts:2190；src/login.ts:351 |
| 21 | `/logout` | 无 | Provider 退订：列出有凭据的 provider，移除 key + profile 条目（模型即刻离开 /model） | src/index.ts:2234；src/login.ts:434 |

### 1.2 宿主透传命令

- 机制：`CommandService.tryExecute` → `ctx.commands` 注册表（`src/commands.ts:153-213`）；未注册名回退为普通 prompt（src/commands.ts:186-199）
- 宿主命令（plan、compact、feedback、export、permission、goal 等，注释列举于 src/commands.ts:7-10）在 TUI 内原样可用
- 用户技能原生手势：`/skill-name` 直接作为 prompt 落给模型，tool-skill 前置注入技能内容（src/commands.ts:189-197）；`/` 补全混合命令+技能项，按使用频次排序（src/commands.ts:248-264）

条目数：TUI 自有 21 条 + 宿主透传机制 1 项 + 技能手势 1 项。

---

## 2. UI 面板/视图全集

### 2.1 交互式 overlay/panel（dsh-opentui 对应「审批面板/todo 面板」等维度）

| # | 面板 | 名称/类 | 触发方式 | 交互方式 | 位置 |
|---|------|---------|----------|----------|------|
| 1 | Ask-user 问题面板 | docked 面板（挂 `ui.askUser` dock） | 模型调 `ask_user_question` 工具（dsh-ask-router 分发） | 停靠在输入框上方（Todos 面板样式），占用焦点，支持选项+自定义输入+超时自动应答 | src/ask-user.ts:1455；接线 src/index.ts:1023-1054 |
| 2 | 审批面板 | `openApprovalPanel` | 工具审批请求（registerApprovalProvider） | 与 ask-user 同 dock 通道，走同一 DialogQueue 排队 | src/approval.ts:36,109；src/index.ts:1063 |
| 3 | 对话队列（DialogQueue） | `DialogQueue` | 多个 ask/approval 并发 | 单飞行队列，先答先赢 | src/dialog-queue.ts:4 |
| 4 | /btw overlay | `BtwOverlayPanel` + `BtwOverlayWire` | `/btw` | 框式 overlay 流式输出；单飞行 + 有界 FIFO 队列（可取消） | src/btw-overlay.ts:41,186；队列 src/btw.ts:185+ |
| 5 | 待发消息队列面板 | `PendingQueuePanel` | Ctrl+O | steer / followup 管理：查看、移除、改路由 | src/queue-panel.ts:100,250 |
| 6 | 提交路由对话框 | `RouteDialogPanel` | 编辑器有内容时提交且会话在跑 | 选 steer（注入当前 turn）/ followup（下 turn 首条） | src/route-dialog.ts:89,154；决策层 src/steer-flow.ts |
| 7 | /history 回看器 | `HistoryBrowserPanel` + `TurnDetailPane` | `/history [id]` | 双栏：左 turn 列表 / 右回复详情；Enter/c 回填编辑器；`s` 换会话；f fork | src/history.ts:535,931,291 |
| 8 | Fork-at-turn 确认框 | `ForkAtTurnPanel` | /history 中 fork | 确认对话框（冷浏览时提示 live 会话将被脱钩） | src/history-fork.ts:113,185 |
| 9 | 跨会话搜索 overlay | `SearchPanel` | `/search` 或 Ctrl+Alt+F | 输入查询→结果表→Enter resume（子会话转只读 /history） | src/search.ts:164,369 |
| 10 | 设置浏览器 | `SettingsBrowser`（内部 `SettingsListPanel`） | `/settings` | 分类→命名空间→字段钻取；cycle/内联编辑/重置；Models 类目特化视图 | src/settings.ts:944,937；框架 src/panels.ts:757 |
| 11 | 自定义 provider 添加/编辑流 | `AddProviderFlow` + `CustomProviderFlow` | /settings Models 类目 | 多字段表单（id/名称/协议/baseURL/模型列表/API key） | src/settings.ts:747；src/custom-provider.ts:41+ |
| 12 | 插件管理面板 | `PluginsPanel` + `PluginConfirm` | `/plugins` | Enter 切换、d 卸载（确认）、i 安装预览、/ 过滤 | src/plugins.ts:222,468,183 |
| 13 | 技能管理面板 | `SkillsManagerPanel` | `/skills` | Installed/Available 双模式，Enter/Space 切换或 symlink，Tab 换视图，Esc 退出 | src/skills-manager.ts:253,713 |
| 14 | 子代理查看器 | `SubagentViewerPanel` + `LiveSubagentTable` | Ctrl+G 或 `/subagents` | 80% 大窗实时 transcript；80% 宽 viewer；含 stop/steer 入口 | src/subagent-viewer.ts:587,966,448 |
| 15 | 子代理 steer 输入面板 | `SteerInputPanel` | viewer 内 steer | 向运行中子代理注入消息 | src/subagent-viewer.ts:865 |
| 16 | 停止全部确认框 | `StopConfirmPanel` | viewer / Esc 双击 | 确认停止全部运行中子代理 | src/stop-dialog.ts:139,204 |
| 17 | Agent 管理器 | `openAgentManager`（select-panel 风格） | `/agents [name]` | 列 agent markdown 文件，编辑 model/think/depth frontmatter；zcode agents 迁移种子 | src/agents.ts:256；文件层 src/agent-manager.ts:63-323 |
| 18 | Preset 确认对话框 | `PresetConfirmPanel` | `/preset` 选中后 | fresh 新开 / fork 携带 / cancel 三选；建议 /handoff | src/preset-dialog.ts:147,212 |
| 19 | 模型选择器 | `pickModel`（TablePanel） | Ctrl+L 或 `/model` | 全 provider 聚合表；`/` 过滤；f 收藏 / h 隐藏（即时持久化） | src/selectors.ts:263；行构建 src/model-list.ts:108 |
| 20 | Effort 选择器 | `pickEffort` | `/think` | 当前模型支持的 effort 档位列表 | src/selectors.ts:142 |
| 21 | 主题选择器 | `ThemePickerOverlay` + `ThemePreviewPane` | `/theme` | 主题列表 + 右侧实时预览（色板样张），选中即热切换 | src/theme-preview.ts:244,219,45 |
| 22 | 会话信息面板 | `showSessionInfo`（FieldPanel/ViewerPanel） | `/session` | 字段面板 + 内嵌 rename 编辑；只读降级（无 sessionTitle 服务） | src/sessions.ts:330；框架 src/panels.ts:573,663 |
| 23 | Resume 选择器 | `pickPersistedSession` | `/resume` / `--resume` | 表格（时间/大小窗口过滤）+ 坏日志修复入口 + 写锁只读降级 | src/sessions.ts:909；修复框 src/repair-dialog.ts:93,154 |
| 24 | 坏日志修复确认框 | `RepairConfirmPanel` | resume 校验失败 | 明确确认后才重写磁盘日志 | src/repair-dialog.ts:93,154 |
| 25 | Hotkeys 管理面板 | `openHotkeysManager` | `/hotkeys` | 字段列表 + Enter 进入按键编辑器，写 keybindings.json 实时生效 | src/hotkeys.ts:250+（PanelHost 260） |
| 26 | 登录流程 | `openLoginFlow` | `/login [provider]` | provider 目录搜索 + 掩码 key 编辑器 | src/login.ts:351 |
| 27 | 登出流程 | `openLogoutFlow` | `/logout` | 有凭据 provider 列表 + 确认移除 | src/login.ts:434 |
| 28 | 语言选择 ask | `askLanguageChoice` | 裸 `/language` | 复用原生 ask-user 面板 | src/language-ask.ts:148,60 |
| 29 | Workflow overlay | `WorkflowOverlayPanel` | Ctrl+K | dsh-workflow 运行的 phase tab + per-phase 树 | src/workflow-overlay-panel.ts:77,141 |

### 2.2 常驻 live 面板/组件

| # | 组件 | 功能 | 位置 |
|---|------|------|------|
| 1 | `TodosPanel` | todo/write 事件驱动的 todo 表（最多 5 行），停靠输入框上方 | src/live-widgets.ts:127（TODO_MAX_ROWS :88） |
| 2 | `ThinkPanel` | 思考状态面板（高度可配 '1'/'5'/'7'/'10'/'all'） | src/activity.ts:298 |
| 3 | `ToolPanel` | 工具调用状态面板（流式尾部 200 行 / 全量 2000 行上限） | src/activity.ts:403；常量 src/activity.ts:63,69 |
| 4 | 运行中 agent 行 | 桥 onLive 折叠的子代理紧凑行（含 round N/M、spinner） | src/live-widgets.ts:214-336 |
| 5 | `●` last-request 行 | 编辑器下方单行最近请求回显 | src/live-widgets.ts:287-316 |
| 6 | `ExternalWidgetFile` | 外部插件 widget 文件桥：`$DSH_HOME/tui-widgets/<pluginId>.lines`（dsh-workflow 等接入） | src/live-widgets.ts:574-618 |
| 7 | Powerline footer | 模型/effort、context%（50/70/90 分级变色）、缓存命中率 CH、消息数、工具数、preset、git 分支、时钟 | src/footer.ts:209,240-279 |
| 8 | FooterHint | 可配置快捷键提示条（7 段开关） | src/footer.ts:107,40-92 |
| 9 | `CwdBorderEditor` | 带 cwd 边框的编辑器（含权限 preset 徽章 provider、分支 provider） | src/editor.ts:35；接线 src/index.ts:2246-2272 |
| 10 | 欢迎横幅 | 像素鲸鱼 + DSH 字标（94×10 网格，窄终端降级） | src/welcome.ts |
| 11 | 每日一言 | 100 条中文一句话池，每次会话随机一条 | src/quotes.ts |
| 12 | `FramedOverlay` | 通用框式 overlay 容器 | src/frame.ts:46 |
| 13 | `RemoteSessionTail` | 只读远端会话尾随渲染（watch 模式） | src/remote-tail.ts:66 |
| 14 | `AttentionBoard` | 子代理注意力排名板（heuristic+可选 jev 层） | src/attention.ts:167；jev 源 src/index.ts:1004-1010 |

面板框架层：`ListController`（src/panels.ts:180）、`TablePanel`（:358）、`FieldPanel`（:573）、`ViewerPanel`（:663）、`SettingsListPanel`（:757）、`PanelHost`（:948）。

条目数：交互式 overlay/panel 29 + 常驻组件 14。

---

## 3. 配置面

### 3.1 /settings 分类结构（CATEGORY_MAP，src/settings.ts:137-166）

| 分类 | 命名空间 |
|------|----------|
| TUI | `dsh-tui`（单命名空间直接钻入字段） |
| General | `permission` |
| Models | `llm-deepseek`, `llm-pi-ai`, `agent-default-model` |
| Plugins | `bash-sandbox`, `pwsh-sandbox`, `agent-loop`, `web-search-deepseek`, `dsh-mcp-adapter`, `dsh-topics-memory`, `dsh-vault`, `dsh-model-sync`, `dsh-feishu`, `dsh-llm-proxy` |
| Agent Presets | `agent-preset-registry`（selectedDefault / modeSelectionEnabled） |
| Other | 未映射命名空间兜底 |

### 3.2 `dsh-tui` entry 配置项全集（Config schema，src/theme-settings.ts:202-380；均为 volatile 热生效）

| 键 | 类型 | 默认 | 说明（定义行） |
|----|------|------|----------------|
| language | string | en | UI 语言（:202） |
| theme | string | auto | 主题偏好（:207） |
| panelHeight | '1'\|'5'\|'7'\|'10'\|'all' | '1' | think/tool 面板高度（:212） |
| maxAgents | natural | 4 | 子代理并发上限（:219） |
| maxRounds | natural | 75 | 子代理轮数上限（:225） |
| maxRoundsGrace | natural | 7 | 轮数宽限（:231） |
| disableSubagent | boolean | true | 禁用子代理围栏（:237） |
| registeredOnly | boolean | false | 仅注册 agent 可 spawn（:243） |
| jevAttention | 'auto'\|'off' | auto | 注意力 jev 层开关（:250） |
| footerHints.send/stop/quit/quitEmpty/subagents/search/history | 7×boolean | true | footer 提示条分段开关（:256-264） |
| cacheHitMode | 'lastMessage'\|'session' | lastMessage | footer 缓存命中率口径（:267） |
| iconSet | 'auto'\|'nerdfont'\|'plain' | auto | 图标集（:272） |
| rememberPreset | boolean | true | preset 记忆开关（:278） |
| favoriteModels | string[] | [] | /model 收藏（:284） |
| hiddenModels | string[] | [] | /model 隐藏（:290） |
| retention.maxCount / maxAgeDays / minIdleHours | 3×number | RETENTION_* | 会话日志保留清理（:296-309） |
| resume.maxAgeDays / minBytes | 2×number | RESUME_* | /resume 显示窗口过滤（:312-323） |
| askUser.idleMinutes / absoluteMinutes | 2×number | ASK_USER_*_DEFAULT | ask-user 超时（:326-337） |
| idleReleaseSec | number | 600 | 空闲放锁秒数（跨 surface 接管） |

计：18 个顶层键（footerHints 内 7 子键、retention 3、resume 2、askUser 2），共 26 个可配置值。

### 3.3 虚拟字段分组（UI 显示层，src/settings.ts:209-226）

- `dsh-tui` 命名空间根：subagent 组（maxAgents/maxRounds/maxRoundsGrace/disableSubagent/registeredOnly 折叠为一行钻取）

### 3.4 theme 主题系统

- 主题文件化：内置 `themes/*.json` 20 个（ayu-light、catppuccin-latte/mocha、dracula(-light)、github-dark/light、gruvbox-dark/light、material-light、monokai、nord-dark/light、one-dark/light、solarized-dark/light、synthwave、tokyo-night(-light)）；用户目录 `$DSH_HOME/themes` 同名覆盖（src/theme/registry.ts:1-10）
- 文件契约：`name` + `dark` + 13 必需色（canvas/canvasSubtle/canvasInset/fgDefault/fgMuted/fgSubtle/borderDefault/borderMuted/accent/success/danger/attention/thinking，#rrggbb）+ 8 个可选派生色（src/theme/registry.ts:14-24）
- 硬编码 githubDark/githubLight 优先于同名 JSON（e2e 依赖，src/theme/registry.ts:8-10）
- 实时预览：ThemePickerOverlay 右侧 ThemePreviewPane 样张（src/theme-preview.ts:45,244）
- 热切换：`settings/document-updated` 订阅 → 同步重应用（含 DSH_TUI_THEME env pin 检测），无重启（src/theme-settings.ts:474-505；src/index.ts:2078-2111）
- 自动派生 muted/panel 色（palette.ts `deriveDefault` / `blend`）

### 3.5 配置文件位置

| 文件 | 内容 | 位置 |
|------|------|------|
| profile patch 的 `dsh-tui` entry `config:` 段 | 上述 18 键（/settings 就地读写） | profile cordis.patch.yml；指引 skills/dsh-tui-pi-config/SKILL.md |
| `~/.dsh/keybindings.json` | 按键覆盖（部分合并） | src/hotkeys.ts:122+；src/keymap.ts:377-396 |
| `$DSH_HOME/workspace-presets.json` | 工作区 preset 记忆（按项目 key 分组） | src/workspace-presets.ts；src/index.ts:1399-1413 |
| `$DSH_HOME/model-profiles.json` | 模型 profile 存储（本插件只读侧） | src/index.ts:1381-1387 |
| `$DSH_HOME/APPEND_SYSTEM.md` | 主 agent 系统提示追加（热生效，首run模板种子） | src/append-system.ts；docs/features/persistent-context.md |
| `$DSH_HOME/locales/*.json` | 用户语言文件 | src/i18n/registry.ts:3-8 |
| `$DSH_HOME/themes/*.json` | 用户主题 | src/theme/registry.ts:3 |
| `$DSH_HOME/tui-widgets/*.lines` | 外部插件 widget | src/live-widgets.ts:588 |
| 命令使用频次表 | `$DSH_HOME` 下持久化（/reload 存活） | src/usage.ts:169；src/index.ts:1131-1133 |
| `~/.dsh/agents/`（含 legacy 迁移、zcode agents 种子） | agent markdown 定义 | src/agent-manager.ts:63-323 |

### 3.6 DSH_TUI_* 环境变量全集

`DSH_TUI_THEME`、`DSH_TUI_MOUSE`（buttons/all/off，src/mouse-mode.ts:19,35）、`DSH_TUI_COPY_ON_SELECT`、`DSH_TUI_TRANSPARENT`、`DSH_TUI_RETENTION_MAX_COUNT/MAX_AGE_DAYS/MIN_IDLE_HOURS`、`DSH_TUI_RESUME_MAX_AGE_DAYS/MIN_BYTES`、`DSH_TUI_ASK_USER_IDLE_MINUTES/ABSOLUTE_MINUTES`、`DSH_TUI_IDLE_RELEASE_SEC`、`DSH_TUI_BTW_CONTEXT_MESSAGES`、`DSH_TUI_SKIP_HOST_CHECK`（grep src 汇总）。

条目数：settings 分类 6 + dsh-tui 配置 18 键(26 值) + 主题系统 5 项 + 配置文件 10 处 + 环境变量 15 个。

---

## 4. 按键绑定（全局）

默认表 `DEFAULT_KEYBINDINGS`（src/keymap.ts:139-150），可经 `~/.dsh/keybindings.json` 部分覆盖（src/keymap.ts:377-396）：

| 键 | 动作 | 说明（行号） |
|----|------|--------------|
| Esc | 停止当前任务（运行中）/ 清编辑器 | keymap.ts:139；双击窗 src/keymap.ts:70-101 |
| Ctrl+C | 运行中：取消；空闲：清编辑器；窗口内双击：退出（最小间隔防抖 QUIT_MIN_GAP_MS） | keymap.ts:140,193-196,296-301 |
| Ctrl+D | 编辑器为空时退出 | keymap.ts:141,308 |
| Ctrl+L | 模型选择器 | keymap.ts:142 |
| Ctrl+G | 子代理查看器/选择器 | keymap.ts:143 |
| Ctrl+O | 待发消息队列面板 | keymap.ts:144 |
| Ctrl+K | Workflow overlay（dsh-workflow） | keymap.ts:145 |
| Alt+W | Workflow widget 在活动 run 间轮换 | keymap.ts:147 |
| Alt+Left / Alt+Right | Workflow widget 水平视口平移 | keymap.ts:148-149 |
| Ctrl+Alt+F | 跨会话全文搜索 overlay（刻意不用 Ctrl+Shift+F，避让 pi-tui 内置 transcript 搜索，keymap.ts:127-135） | keymap.ts:150 |
| Ctrl+Shift+C（ask 编辑器） | 写系统剪贴板（OSC 52 + 本地命令梯） | src/clipboard.ts:10-17 |
| 鼠标 | 按钮模式为默认（clicks/wheel/拖选/滚动条），DSH_TUI_MOUSE 可切 all/off | src/mouse-mode.ts:19-49 |

pi-tui 内置层：transcript 搜索（Ctrl+Shift+F 归 pi-tui，keymap.ts:127 注释）、编辑器删字（delete/ctrl+d 前向删除，keymap.ts:52）、bracketed paste。/hotkeys 可视化管理上述 app 键。

条目数：app 级绑定 11 + 鼠标模式 1 + pi-tui 内置层 3。

---

## 5. 宿主对接能力（与 dsh 宿主集成点）

| # | 集成点 | 说明 | 证据 |
|---|--------|------|------|
| 1 | 会话持久化 | DshSessionBridge：ensure/resume/detach/fork；resume 校验日志；写锁（SessionAlreadyOwnedError）降级只读 watch；fork-at-turn 携带 completed-turn seed | src/session.ts:304,1576；src/index.ts:1560-1650 |
| 2 | session/event firehose | 非范围过滤事件流：折叠子代理创建/结束（tool-workflow/agent-start|end）、subagent/descriptor、llm/retry、todo/write、dcp 压缩通知、插件注入 | src/dsh-events.ts:22-30,70-133；src/session.ts:542-700 |
| 3 | 子代理发现双通道 | firehose + 每 600ms 宿主 sessions.list() 对账（补丢失事件） | src/session.ts:663-700 |
| 4 | Approval waterfall | registerApprovalProvider 接宿主审批请求 → dock 面板 + DialogQueue 串行 | src/approval.ts:109；src/index.ts:1063 |
| 5 | ask_user_question provider | 宿主 dsh-tool-ask-user 调 ctx.userQuestions.ask()，TUI 承接；ask-surface 按 session id 认领（dsh-feishu 等跨 surface 先答先赢） | src/index.ts:1023-1054 |
| 6 | Cron（被动） | 无 cron 管理面板；仅会识别 cron 产生的注入/提示（btw 快照排除 cron 注入；/resume 列表过滤 cron 回撤提示） | src/btw.ts:148；src/sessions.ts:747 |
| 7 | Todo | 折叠 todo/write 全量快照 → TodosPanel；会话切换清空 | src/messages.ts:37-40,239；src/live-widgets.ts:127 |
| 8 | Subagents 面板 | 子代理实时视图/查看器/steer/stop + maxAgents 准入治理（admitted/denied/pruned 计数） | src/subagent-policy.ts；src/subagent-viewer.ts |
| 9 | `subagent_status` 模型工具 | 只读子代理看板工具（模型可查 cap 余量、逐子进度、准入计数） | src/subagent-status-tool.ts；注册 src/index.ts:985-995 |
| 10 | Attachments | 图片附件：每消息最多 8 张，`$DSH_HOME` attachmentsRoot 存储，编码图片随命令执行传入（rc.8 execute 4 参） | src/attachments.ts:34-73；src/commands.ts:53-57 |
| 11 | Preset | agent preset roster 切换（新会话生效）、fork 携带、workspace 记忆、agent spawn 时 frontmatter⊕profile 组合 | src/index.ts:1399-1453；src/agent-runtime.ts |
| 12 | Session title seam | 宿主 dsh-session-title：/session 面板内 rename（SessionTitleInvalidError 契约） | src/index.ts:1517-1540 |
| 13 | sessionQuery FTS | 本 bundle patch 覆写 stock session-query-sqlite 行启用全文索引，/search 使用 | src/index.ts:1706-1710 |
| 14 | sessionPersistence | 日志定位/校验/修复（repairSessionLog） | src/log-repair.ts；src/index.ts:1626-1660 |
| 15 | 会话保留清理 | 启动后延迟、可中止的 retention 清理（窗口外 jsonl 会话目录），保护在跑 /resume 目标 | src/retention.ts:166；src/index.ts:364-398 |
| 16 | Plugin manager | /plugins 面板走宿主 pluginManager 服务（enable/disable/install/uninstall） | src/plugins.ts:468；src/index.ts:2022-2033 |
| 17 | Skills registry | ctx.skills.list（scope=agent+cwd）→ /skills 面板 + / 补全混合技能项 + 使用计数 | src/commands.ts:296-322；src/skills-manager.ts |
| 18 | Settings 服务 | ctx.settings.describe()/mutate 路径写（/settings 浏览器唯一写通道） | src/settings.ts:95-104,1019 |
| 19 | LLM 服务 | llm.listProviders/listModels/resolveModelInfo/resolveCallConfig/stream（/model、/think、/btw、/login、/logout） | src/selectors.ts:263-300；src/index.ts:1125-1145 |
| 20 | 权限 preset 徽章 | permissionPresets.current(session) → footer/编辑器徽章（web 显示惯例：danger-full-access→Full access） | src/index.ts:2254-2272 |
| 21 | systemPrompt 注入 | ask_user_question 使用约束段（占 PTC_ONLY 位）；APPEND_SYSTEM.md 追加 | src/index.ts:1067-1090；src/append-system.ts |
| 22 | 外部 widget 文件协议 | 兄弟插件（dsh-workflow 等）写 `$DSH_HOME/tui-widgets/<id>.lines` 停靠 todosDoc | src/live-widgets.ts:574-618 |
| 23 | 远端接管 | idleReleaseSec 空闲放锁 + watchRemote 只读尾随（手机/feishu 接管会话） | src/session.ts:1070-1114；theme-settings.ts:340-350 |
| 24 | Profile patch 显式覆盖 | dsh-tui.resume/retention 等可在 profile patch 显式声明，settings/env/defaults 逐层解析 | src/index.ts:1666-1670,392-395 |
| 25 | 可选 MCP adapter / DCP | 伴生插件 @aiwayds/dsh-mcp-adapter（/mcp 命令）与 dsh-dcp（零 LLM 压缩、footer context 段跟随） | docs/features/mcp-adapter.md；docs/features/dcp.md |

条目数：25。

---

## 6. i18n

- 支持语言（bundled `locales/`，每语言一个 JSON）：**en / ja / ko / zh-CN**（locales/en.json、ja.json、ko.json、zh-CN.json；`locale/` 目录为旧目录同为 4 语言）
- 用户扩展：`$DSH_HOME/locales/<id>.json` 放一个文件即新增语言，无需改码（src/i18n/registry.ts:3-8）
- 语言切换：/language（ask 面板或直参）、/settings `dsh-tui.language`，均热生效；footer 提示、hotkeys 描述、settings 标签等全部 t() 渲染时解析（src/footer.ts:76-92；src/hotkeys.ts:41-54；src/settings.ts:169-186）
- i18n 覆盖守卫：字面 t() call site 枚举（src/settings.ts:230-238）

条目数：4 语言 + 用户扩展机制 + 热切换机制 = 3 项。

---

## 7. 其他用户可感功能（杂项）

| # | 功能 | 说明 | 位置 |
|---|------|------|------|
| 1 | TPS/decode 统计 | 主会话+逐子代理累计 decode 窗口速率（首 token→事件时间）；/session 面板整体 TPS + 分路由 TPS | src/tokens.ts:39-46；src/session.ts:272,387,402,1756,2037 |
| 2 | footer 缓存命中率 | CH 段：lastMessage（默认）/session 两种口径，per-route 段内累计 | src/session.ts:248；src/footer.ts:260-266 |
| 3 | footer context 段 | context%/窗口 token（resolveModelInfo），50/70/90% 分级变色；DCP 压缩跟随 | src/footer.ts:202-206,240-249 |
| 4 | /rename | /session 面板内嵌会话改名（sessionTitle seam） | src/index.ts:1533-1546 |
| 5 | 跨会话搜索 | sessionQuery FTS（Ctrl+Alt+F / /search） | src/search.ts |
| 6 | pi-tui transcript 搜索 | 内置（刻意避让，见 keymap.ts:127） | pi-tui |
| 7 | 选区图片搜索/粘贴 | search-selection-images：搜索命中/选择图片进消息 | docs/features/search-selection-images.md；src/attachments.ts |
| 8 | 剪贴板桥 | OSC 52 + pbcopy/wl-copy/xclip/xsel/clip 梯子；64KiB 上限 | src/clipboard.ts |
| 9 | 鼠标模式治理 | buttons/all/off 三态（修 cmux 下 pi-tui all-motion 解析 bug） | src/mouse-mode.ts |
| 10 | 透明背景 | DSH_TUI_TRANSPARENT；canvas 不涂背景（终端默认色透出） | src/welcome.ts:22-25 |
| 11 | Nerd Font 检测 | font-detect 探测 → iconSet auto 降级 plain | src/font-detect.ts；src/index.ts:413-415 |
| 12 | 命令频次记忆 | 命令/技能使用计数持久化，/ 补全按频次排序，/reload 存活 | src/usage.ts:169；src/index.ts:1128-1133 |
| 13 | 每日一言 | 100 条中文开局语录（会话级随机） | src/quotes.ts |
| 14 | 像素鲸鱼横幅 | 94×10 网格品牌横幅，窄终端降级仅鲸鱼 | src/welcome.ts |
| 15 | git 分支监视 | GitBranchWatcher → footer/编辑器 | src/git.ts:9 |
| 16 | 启动信息 | startup-info 汇总（boot resume 失败缓冲提示） | src/startup-info.ts；src/index.ts:1734-1755 |
| 17 | 会话窗口过滤 | /resume 列表按 maxAgeDays/minBytes 窗口，隐藏全部时提示可调参数 | src/index.ts:1685-1703 |
| 18 | 只读远端尾随 | watchRemote：另一进程持有会话时进入只读视图（轮询延迟最终回复，拒绝输入） | src/session.ts:1070-1114 |
| 19 | 自动重载续会话 | /reload stash 会话 id → 新 fiber 自动 resume；`--resume` boot intent | src/index.ts:1701-1725,1734-1755 |
| 20 | 硬退出看门狗 | setImmediate 退出 + Worker SIGKILL 看门狗（防 libuv 挂死） | src/hard-exit.ts |
| 21 | 注意力排名 | heuristic 评分（critical/warn 阈值 0.6/0.35、stall 60-600s）+ 可选 jev 层（debounce） | src/attention.ts:52-118；src/attention-jev.ts |
| 22 | 子代理治理 | maxAgents 准入拒绝、轮数宽限、registeredOnly 围栏、deny 消息指向 subagent_status 工具 | src/subagent-policy.ts；src/subagent-status-tool.ts |
| 23 | 外部 widget 协议 | `$DSH_HOME/tui-widgets/*.lines` 兄弟插件停靠行（mtime 帧检测） | src/live-widgets.ts:574-618 |
| 24 | Canvas 终端 | CanvasTerminal 渲染层（半块像素映射） | src/canvas-terminal.ts:64 |
| 25 | Agent 迁移 | legacy agents 目录迁移 + zcode agents 种子导入 | src/agent-manager.ts:80,98,293 |
| 26 | 配置技能 | 内置 skill `dsh-tui-pi-config`：18 键配置指南（模型可读） | skills/dsh-tui-pi-config/SKILL.md |
| 27 | Volatile 热生效 | 全部 dsh-tui 配置 .volatile()：/settings 提交即生效，fiber 不重挂 | src/theme-settings.ts:9-16,155-180 |
| 28 | 退出安全 | Esc/Ctrl+C 双击窗、Ctrl+D 空编辑退出、hard-exit 看门狗 | src/keymap.ts；src/hard-exit.ts |

条目数：28。

---

## 汇总（各维度条目数）

| 维度 | 条目数 |
|------|--------|
| 1. 斜杠命令 | TUI 自有 21 + 透传机制/技能手势 2 = 23 |
| 2. UI 面板/视图 | 交互式 29 + 常驻 14 = 43 |
| 3. 配置面 | 分类 6 + 配置键 18(26 值) + 主题 5 + 配置文件 10 + 环境变量 15 = 54 |
| 4. 按键绑定 | app 级 11 + 鼠标 1 + 内置层 3 = 15 |
| 5. 宿主对接 | 25 |
| 6. i18n | 4 语言 + 2 机制 = 6 |
| 7. 杂项 | 28 |
