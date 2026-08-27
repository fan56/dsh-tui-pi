English | [简体中文](README.zh-CN.md)

# dsh-tui-pi

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 pi 风格终端 UI —— 一套把 dsh 变成 pi 风格编码代理体验的 cordis 插件套件。

**兼容性**：针对 dsh `0.1.1-rc.2` 测试。斜杠命令的执行经过一个
`executeCommand()` 兼容 shim（`src/commands.ts`），在运行时探测
`dsh-commands` 的 `execute()` 参数个数——同时支持 rc.8 之前的 3 参形式
`(agent, line, signal)` 与当前的 4 参形式 `(agent, line, images, signal)`
（自 `0.1.0-rc.8` 起未再变化）。经单元测试与 tmux 真机 e2e 冒烟验证。

> 中文说明：本文件为英文 [README.md](README.md) 的简体中文翻译。

## 截图

https://github.com/user-attachments/assets/6a7e00bb-1fd0-4bc5-9070-457f1e9fa54d

一段真实 session 的终端录制（MP4，1.5× 速度）——todos、运行中的 subagent、think/tool 面板和 powerline footer 的实际效果。
（[asciinema 交互播放](https://asciinema.org/a/BE212ZO8x1zEZyZn)）

### 布局总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  Transcript（可滚动对话区）                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  💭 thinking — reasoning in progress                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ⚙ bash  python scripts/demo.py  …  ✔ bash                        │
│  ↳ 生成 2 个 todo, 每个 todo 起一个 10s 的 subagent                 │
│  ↳ ⠼ Workhorse 10s 任务 · 1.2k token · 19.0s                       │
└─────────────────────────────────────────────────────────────────────┘
┌─ ● Todos (0/8) ────────────────────────────────────────────────────┐
│ ├─ ☑ 调研 dsh-tui-pi 斜杠命令/补全机制                                │
│ ├─ ◐ 调研 harness ctx.skills API                                   │
│ └─ ☐ 实现 /skill:<name> 补全并触发 skill                             │
└─────────────────────────────────────────────────────────────────────┘
∴ working…                                                            │
~/github (Full access) │ ⎇ main                                       │
[ 请输入指令…                                                       ] │
 ↳ 第一 打slash 命令的时候 显示 /skill:<skill name> 选择后使用          │
  ↳ ⠼ 牛马狗  · 1.5m/1m · 635.7s                                      │
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%)   │
     ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools                  00:02:13     │
 Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+G: subagents · ↑↓: history   │
└─────────────────────────────────────────────────────────────────────┘
         │                       │                │
         │                       │                └─ Footer（powerline 状态栏）
         │                       └─ 运行中的 subagent（last-request 区域）
         └─ Todos 面板（有边框，固定在编辑器上方）
```

---

## 功能特性

### Footer 状态栏

固定在屏幕底部的 powerline 风格状态栏，一眼看清会话的实时状态：

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

七个分段全部从 O(1) 维护的计数器读取（从不重新扫描 session 日志）：

| 分段 | 内容 |
|---|---|
| **Provider** | 当前 `provider/model` 路由 |
| **Model** | 模型简称 |
| **Thinking** | 推理强度等级（`off` / `high` / `max`） |
| **Context** | `已用 / 上限 (百分比%)` |
| **Cache-hit** | `CHxx%` —— prompt 缓存命中率 |
| **Messages** | user + assistant 消息总数 |
| **Tools** | 工具调用总数 |
| **Clock** | 右对齐实时 HH:MM:SS（每秒刷新） |

分段用 [U+E0B0](https://www.nerdfonts.com/cheat-sheet) powerline 箭头渲染；配色随当前主题热切换。

编辑器顶部边框显示工作目录和 git 分支：

```
~/github (Full access) │ ⎇ main
```

---

### Think 与 Tool 面板

进行中的思考和工具调用渲染为**固定面板，钉在聊天输入框上方**（永远不会出现在可滚动的 transcript 里）：

```
┌─ 💭 thinking ──────────────────────────────────────────────┐
│ Actually, I can check list_agents or wait…                 │
└────────────────────────────────────────────────────────────┘
⚙ bash  python scripts/demo.py  …  ✔ bash
```

行为要点：

- **每种类型只有一个面板** —— 整个运行期间只有一个 `ThinkPanel` 和一个 `ToolPanel`；每个事件原地刷新面板，不会刷屏 transcript。
- **空 = 隐藏** —— 无活动时面板渲染 0 行并消失。
- **`dsh-tui.panelHeight`**（默认 `1`）：一行无边框（块 id + 耗时 + 最后一行内容，右截断）；`5`/`7`/`10` 渲染带边框面板；`all` 输出完整内容。
- **委派类工具**（`use_agent`、`subagent`、`workflow`、`ralph`）不打开工具面板——它们的子任务以运行中 agent 行的形式显示（见 Subagents）。

---

### Subagents 子代理

运行中的 subagent 活动显示在**编辑器下方的 last-request 区域**，每个子代理一行的紧凑状态：

```
↳ 创建 2 个 todo, 每个 todo 起一个 10s 的 subagent
  ↳ ⠼ Subagent A 10s 任务 · 1.2k token · 19.0s
  ↳ ⠼ Subagent B 10s 任务 · 562 token · 6.0s
```

每行显示：spinner + agent **名称**、重试次数（`↻N≤M`）、紧凑的**当前上下文占用**（`X/Y` —— 该子代理最近一次请求的 billed input+output 加上其后消息的 CJK 估算，除以它的上下文窗口；**不是**只增不减的累计 token 消耗）、rounds（`round N/M` —— assistant 消息数对上限，仅当 `maxRounds > 0` 时显示 `/M`）、耗时，以及策略注入（maxRounds 收尾、steer）到达子代理后的 `⚡` 标记。不显示 provider，无边框，无标题——每个运行中的子代理就一行。

**spawn 派生**与 **fork 派生**两类子代理都会被追踪——dsh 通过 `childSessionMeta` 同时写入 `origin: 'subagent'` 和 `delegationDepth` 预算，头部识别对两种标记都认得（只有预算没有 origin 的头部作为防御性兜底也会被接纳，标记为 `fork <id8>`；当前的 dsh 不会产生这种形态）。非子代理会话按**值**而非字段有无被挡在板外：jsonl 持久化后端在每条恢复出来的头部上都会物化 `delegationDepth: 0`，所以闸门要求预算严格 `> 0`。面向用户的 session fork（fork 出来的*对话*：`Session.fork` 只设 `parentSession` + `seedLength`，不带预算）刻意不进子代理面板，仍可通过 `/resume` 恢复——`/resume` 的过滤器（`isResumableSessionHeader`）恰好排除被委派的子代理（`origin: 'subagent'` 或预算 > 0）。

#### Todos 待办面板

`● Todos (done/total)` 树是一个有边框的面板，**固定在聊天输入框上方**（不随 transcript 滚动）：

```
┌─ ● Todos (0/8) ──────────────────────────────────────────┐
│ ├─ ☑ Todo 1: research subagent spawn API                 │
│ ├─ ◐ Todo 2: implement /skill:<name> autocomplete        │
│ └─ ☐ Todo 3: add settings panel skills branch            │
└───────────────────────────────────────────────────────────┘
```

图标：`☑` 已完成，`◐` 进行中，`☐` 待处理。结束的子代理从列表消失；都为空时，todo 面板与 agent 行一并折叠为 0 行。

#### 查看器与限制

`Ctrl+G`（或 `/subagents`）打开一个 80% 宽度的选择器，列出被追踪的子代理——运行中的排前面，然后是最近结束的 5 个。Enter 打开实时 transcript 查看器（约 3×/s 刷新，tail-follow 自动跟随）。

**Steering（中途转向）**：在 transcript 查看器里按 `Enter` 打开多行 steer 输入框（`Enter` 发送 · `Shift+Enter` 换行 · `Esc` 取消）。消息作为插件来源的 user 消息投递，并按子代理的实时状态路由：运行中的子代理在它的下一个 step 边界收到注入（`steer`）；空闲但尚未结束的子代理把它排队为自己的下一个 follow-up turn；已经结束的子代理不再弹出输入框——查看器改为显示 "This subagent has ended — steering unavailable"。发送失败保留草稿并给出内联错误以便重试；发送成功回到 transcript 并显示一条短提示。这些查看器按键是硬编码的，不能通过 keybindings.json 重映射。

两个上限项（通过 `/agents` → `l` 配置）：

- **`maxAgents`**（默认 4，`0` = 无限制）—— 达到上限时拒绝新的 spawn。
- **`maxRounds`**（默认 75，`0` = 无限制）—— 子代理的 assistant 消息数（每次 LLM 往返计一条，即"rounds"）达到上限后，TUI 注入一条收尾指令且从不强制终止：运行中的子代理在其下一个 step 边界收到（`steer` —— 即下一次 LLM 往返），空闲的子代理作为自己的下一个 turn 收到。注入是可见的：紧凑行、Ctrl+G 选择器行和查看器头部都会显示 `⚡` 标记，transcript 把注入的消息渲染为 `⚡ <文本>`——这样就能区分子代理 LLM 无视了收尾指令与注入从未发生这两种情况。

---

### DCP（Dynamic Context Pruning 动态上下文裁剪）

[DCP](https://github.com/fan56/dsh-dcp) 是 dsh 的独立零 LLM 压缩（compaction）插件——自动修剪上下文以保持在限制内，无需调用 LLM 做摘要。

`dsh-tui-pi` 把 `@aiwayds/dsh-dcp` 列为依赖，但**并不挂载它**——dsh-dcp 自带 `cordis.patch.yml`（自 `@aiwayds/dsh-dcp@0.2.0` 起）。启用方式：

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

挂载后 DCP 在后台透明运行。footer 的 **Context** 分段计算的是当前占用——最近一次请求的 billed context 加上其后消息的 CJK 估算——所以压缩之后下一次请求会变小，显示随之回落（百分比封顶 100，窗口是硬上限）。**Cache-hit** 分段反映当前 provider/model 路由的缓存复用率——命中率按路由分段分别计算，provider 或 model 变化时归零（在下一条 billed 消息到来前隐藏）。

在 subagent 内部，已提交的压缩同样可见：DCP 在子代理自己的日志里为每次压缩追加一行 `user/message` **notice**，Ctrl+G 的 transcript 用 `🧹` 标记渲染它（区别于通用的 `ⓘ`），选择器行的描述里带有该子代理的压缩次数（描述中的 `🧹 N×`）。DCP 的 `roundInterval` 与 TUI 的 `maxRounds` 数的是**同一样东西**——`assistant/message` 事件，每次 LLM 往返计一条——但行为不同：子代理计数达到 `maxRounds` 时 TUI 排队发一个收尾请求；会话计数达到 `roundInterval` 后 DCP 在下一个空闲边界执行压缩（修剪上下文）。一个触发工作，一个释放上下文。

---

### APPEND_SYSTEM.md

一份用户可编辑的 markdown 文件，其内容会追加到**本 TUI 创建的主 agent 的 system prompt 末尾**——借鉴 pi 的 `~/.pi/agent/APPEND_SYSTEM.md` 约定，dsh 侧对应 `$DSH_HOME/APPEND_SYSTEM.md`（默认 `~/.dsh/APPEND_SYSTEM.md`，沿用 dsh 其余部分共用的 `$DSH_HOME` 覆盖机制）。

- **热应用** —— section 提供者在每次组装 prompt 时读盘，改完文件**下一次请求**即生效：无需重启、无需 watcher、无需 `/reload`。
- **首次运行自动播种** —— 文件不存在时，TUI 启动时一次性从随包模板 `templates/APPEND_SYSTEM.md` 创建（英文版 orchestrator 身份模板：身份、核心规则、执行工作流——含「subagent 仅指已注册 subagents」的用语规则）。已有文件归用户所有——TUI 永远不会覆盖用户内容；只在文件尚未包含带标记的 todo-lifecycle section 时追加该段，以及（按短语匹配、幂等地）在尚未出现 subagents 规则措辞时追加之。
- **TUI 自有 section** —— 一个带标记的 block（`<!-- dsh-tui-pi:todo-lifecycle -->`）只追加一次，之后幂等维护，确保模型在所有条目完成时清空自己的 `todo/write` 列表。已带标记的文件后续启动保持逐字节不变。
- **旧版迁移** —— 同一段 todo block 过去是通过 `~/.dsh/AGENTS.md` 下发的。启动时 TUI 一次性把它剥掉（不存在时 no-op），避免重复下发。
- **空 / 读不到 = 无 section** —— 文件缺失或读不了时该 section 被静默丢弃。无报错，不影响 TUI 启动。

#### 作用范围：仅主 agent

该 section 注册在主 agent **带作用域**的 agent context 上（`src/session.ts` 的 `installAppendSystem`）——落在该 agent 自己的 prompt-scope 层，subagent 的 scope 不会合并它。orchestrator 身份（「调度子代理、不要自己执行」）若下发到子代理身上会自废武功，所以子代理完全看不到这个文件。机制与 `dsh-subagent-registry` 给每个子代理设置 persona 时相同。

#### 示例

```sh
# 首次启动从 templates/APPEND_SYSTEM.md 自动播种 —— 打开直接编辑即可。
$EDITOR ~/.dsh/APPEND_SYSTEM.md

# 或者完全替换为你自己的版本（TUI 仍会保留它的带标记
# todo-lifecycle section —— 缺失时会重新追加）。
cat > ~/.dsh/APPEND_SYSTEM.md <<'EOF'
# Project ground rules

- Always run `pnpm test` before claiming a task is done.
- Prefer dispatching `workhorse` for multi-step investigations.
EOF
```

没有开关此功能的斜杠命令——它始终开启，完全由文件内容控制。

---

### Ask User Question（向用户提问）

模型在一轮回答中途可以暂停下来，通过 `ask_user_question` 工具向你提出结构化问题（`@deepseek-ai/dsh-tool-ask-user`，由本 profile 的 bundle patch 挂载）。TUI 承载应答侧：一个有边框的面板钉在聊天输入框正上方（Todos 面板的槽位——不是浮动的 popup），打开期间接管键盘，工具调用保持 pending 直到你作答，你的答案作为普通的 tool result 流回模型。

看看 ask-user-question 流程的实际效果：

https://github.com/user-attachments/assets/aa36be36-a508-4f53-ba85-efe0394dab11

- **一次一个问题，其余收进标签页** —— 有多个问题时，面板恰好只显示一个问题的 block（标题行 + 辅助 `detail` 文本、选项行，外加自由输入的 `Type something.` sentinel 行）；标题下方的标签条（`[1] · 2✓ · 3` —— 方括号标出焦点 tab，✓ 表示已答）把其他问题折叠起来。`←`/`→`（以及 Tab/Shift-Tab）切换标签；单选 tab 作答后自动跳到下一个未答问题（全部答完后跳到 Confirm 行）。单选在 Enter 时替换选中项；多选为切换（`●`/`○` 标记）且从不自动跳转。
- **Ctrl+T 把面板折叠成 3 行小条** —— 你思考问题时，questions 面板可能挡住叠在其下的 transcript；Ctrl+T 把它折叠成边框 + 一行摘要（阶段、tab 位置、已答数量、如何展开），同一按键再次展开。折叠期间只有切换键和 Esc 链生效；编辑中途折叠会像 ↑↓ 离开一样提交缓冲区。
- **单问题快速通道** —— 孤立的单选问题在 Enter 时立即提交：选选项或输入自由文本回车都会立刻提交（无选项的问题靠打字即可作答）。孤立的多选问题则会得到一个 `⏎ Confirm answers` 行，让你先勾选多个选项再提交。
- **多问题确认页** —— ≥ 2 个问题时出现 `⏎ Confirm answers` 行，跳转到列出全部答案的 review 页，每一行都可原位编辑（跳回去会把焦点切回那个问题的 tab）；`Submit answers` 提交（有答案缺失时在其上按 Enter 会闪烁提示而不是静默失败）。
- **双击 Esc 表示拒绝作答** —— 200ms 内两次 Esc 返回 declined envelope（模型读到的是一条正常的回复，表示未给出答案）；长按不会误触发（低于最小间隔的按键自动重复被忽略）；工具调用被中止时也按 declined 结算。面板打开期间像打开的 overlay 一样独占键盘：Esc 永远不会进入运行任务的停止链，app 快捷键（Ctrl+L/G/O、Tab）也让位于面板。
- **节制使用引导** —— 一段 system-prompt 引导模型只在真正需要你时才提问（1–3 个问题，每个 2–4 个选项），避免 TUI 变成问卷调查。
- **键盘操作** —— `←→` 切换问题标签 · `↑↓` 导航 · `Enter` 选择/勾选/确认 · 在 sentinel 行打字输入自由文本 · `Ctrl+T` 折叠/展开面板 · 连按两次 `Esc` 拒绝作答。

灵感来自 [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question)。

---

## 斜杠命令

| 命令 | 功能 |
|---|---|
| `/model` | 两阶段 provider/model 选择器（然后选 thinking level）。实时切换并持久化；面板内按键：`f` 收藏 · `h` 隐藏 · `/` 过滤（收藏/隐藏经 settings 持久化）。 |
| `/think` | 当前模型的推理强度选择器（`Off`/`High`/`Max`）。 |
| `/session` | 只读信息面板：id、cwd、model、token 用量、事件计数。 |
| `/resume` | 选择一个持久化的 session，校验其日志后恢复。按最后更新时间排序（日志文件 mtime），新的在上；`Updated` 列显示生效时间。 |
| `/new` | 分离当前 session；下一次输入开启新 session。 |
| `/settings` | 文本式设置浏览器（命名空间、schema 遍历、内联编辑器、密钥脱敏）。 |
| `/export` | 将当前 session 日志导出为 JSONL（`~/Downloads/dsh-session-<id>.jsonl`）。 |
| `/permission` | 权限预设选择器（read-only / workspace-write / danger-full-access）。 |
| `/theme` | 配色方案选择器（`auto` / `light` / `dark`），即时生效。 |
| `/preset` | agent preset 选择器；`<name>` 直接切换，`next` 向前循环（同 `Tab`）。 |
| `/profile-switch` | 切换模型 profile——默认模型 + think level 与每个 subagent 的模型/think level 的具名快照。Enter 即应用到当前会话、持久化默认模型并写入 agent markdown 文件。`p` 把当前目录钉到某个 profile（写入 `.dsh-profile`，向上就近取文件）：该目录树下之后的新会话自动加载它，不动全局默认。内置 `work` / `personal` / `other`；存储于 `$DSH_HOME/model-profiles.json`。 |
| `/profile-cfg` | 配置模型 profile：编辑默认模型 / think / 各 subagent 模型（全是选择面板，模型选择复用 `/model` 的收藏/隐藏表格），`s` 把当前配置保存进 profile，`n` 新建，`r` 重命名，`d` 删除，`v` 查看。 |
| `/agents` | 管理 agent markdown 文件 + subagent 上限（`maxAgents`、`maxRounds`）。 |
| `/subagents` | 选择运行中/最近的 subagent 并观看其实时 transcript；在查看器内按 `Enter` 可对子代理 steer（见 Subagents）。 |
| `/reload` | 从源码热重载插件（`pnpm build` 后执行），无需重启 dsh。 |
| `/login` | 登录 provider：从目录选择（或 `/login openai` 直达），输入一个 API key。**Custom provider…** 条目（`/login custom`）打开六字段表单，接入任何 pi-ai 未内置的 OpenAI/Anthropic 兼容网关——route id、显示名、协议、base URL、模型列表、API key——写出与 Web Models 页组合出的同一种 hand-declared 路由。 |
| `/logout` | 选择一个已登录的 provider，同时删除存储的 key 和它的 provider profile。 |
| `/hotkeys` | 快捷键浏览器和实时编辑器。 |

凡不能解析为已注册命令的内容，都作为普通 prompt 落给模型。

---

## 键盘快捷键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送 prompt |
| `Esc` | **双击停止** —— 单击进入待发状态（500ms 窗口）；popup 打开时改为关闭 popup；空闲（无运行中任务）时不做任何操作 |
| `Ctrl+C` | 对话中：第一次取消当前轮次，第二次退出。空闲时：清空编辑器 / 退出。**长按自动重复绝不会触发退出。** |
| `Ctrl+D` | 退出（仅在编辑器为空时） |
| `Ctrl+L` | 打开 model/think 选择器 |
| `Ctrl+G` | 打开 subagent 选择器（有子代理运行时）；在 transcript 查看器内按 `Enter` 打开 steer 输入框（查看器按键为硬编码） |
| `Tab` | 循环切换 agent preset（footer 品牌段显示当前预设 `dsh(<name>)`） |
| `↑` / `↓` | 浏览已发送消息历史（shell 风格，500 条） |

### 自定义快捷键

通过 `~/.dsh/keybindings.json` 重映射任意 app 按键——一个部分 JSON 映射表，键为 app 按键、值为按键 id（`ctrl+letter`、`alt+letter`、命名键）。可手动编辑，或用 `/hotkeys` 交互式修改（实时生效，无需重启）。

---

## Agent presets

部署提供了 `standard` agent preset 时，TUI 启动即选中它；否则选中扫描到的第一项。这只是本地选择：在你操作 `/preset` 或按 `Tab` 之前，创建 session 时不会发送任何 `meta.agentPreset`，因此仍由服务端默认值（`agent-presets.default`）决定。footer 品牌段反映本地选择（`dsh(<name>)`）；一次切换在下一个空白 session 生效。

---

## 主题

GitHub light / GitHub dark 配色，运行时热切换：

- `/theme` —— 实时选择器；整个屏幕重绘（含背景）。
- `DSH_TUI_THEME=light|dark` —— 环境变量钉选，优先于偏好设置。
- `DSH_TUI_TRANSPARENT=1` —— 透明画布（终端背景透出）。
- `DSH_TUI_MOUSE=buttons|all|off` —— 终端鼠标追踪模式（默认 `buttons`：点击/滚轮/拖选继续可用，空闲指针移动不上报；`all` = pi-tui 的全动作追踪，cmux 下其事件突发可能漏进编辑器；`off` = 关闭鼠标）。
- `auto` 模式检测终端并跟随实时的明暗切换。

全屏画布背景随包内置——写流装饰器（`src/canvas-terminal.ts`）用主题色经 BCE 给每条擦除序列上色，无需补丁依赖。

---

## Session 管理

两组配置项共同管理 session 存储，都位于 `dsh-tui` settings 命名空间下
（`~/.dsh/settings.yaml`），各配一个环境变量逃生口：

```yaml
dsh-tui:
  # ~/.dsh/sessions 的启动清理器 —— 会删除窗口之外的整目录 session 日志。
  # 每进程启动时执行一次。
  retention:
    maxCount: 100      # 最多保留这么多 session；<= 0 关闭清理器
    maxAgeDays: 7      # 删除超过这么多天未动的日志（> 0）
    minIdleHours: 24   # 仅作用于条数规则的空闲保护（小时，>= 0）

  # /resume 显示过滤器 —— 只隐藏选择器行，从不删除。
  # 每次打开选择器时重新解析（改设置对下一次 /resume 生效，
  # 无需重启）。
  resume:
    maxAgeDays: 7      # 只显示日志活动在此窗口内的 session（> 0）
    minBytes: 20480    # 一行的最小压缩后日志大小（>= 0）
```

每个字段的优先级：settings.yaml 里的显式值 > `DSH_TUI_RETENTION_MAX_COUNT`
/ `DSH_TUI_RETENTION_MAX_AGE_DAYS` / `DSH_TUI_RETENTION_MIN_IDLE_HOURS`
与 `DSH_TUI_RESUME_MAX_AGE_DAYS` / `DSH_TUI_RESUME_MIN_BYTES`
环境变量 > 上述默认值。非法的 settings 值经由共享 notice bridge 弹出一条瞬态提示
（没有注册 TUI sink 时被静默丢弃——headless 运行永不打印）并回落到下一层；
非法的环境变量值则静默回落——一个 typo 既不会扩大也不会架空策略。`maxCount`
与 `minBytes` 在每一层都必须是整数（小数的上限或字节门槛是垃圾数据，
不是窗口）。

**完全关闭 retention** —— 对于要 read-attach 旧 session 的常驻进程
（远程 bridge、headless cron 运行），默认窗口会把它们裁掉：

```yaml
dsh-tui:
  retention:
    maxCount: 0    # 或：DSH_TUI_RETENTION_MAX_COUNT=0
```

时机：**retention 只在启动时跑一次**（从不在会话中途；`/reload`
不会重跑它——下一次冷启动才会），而 **resume 过滤器在每次 `/resume`
打开时生效**。两处 `7` 默认出自同一个「一周即工作集」决策，
但服务对象不同——retention 删除日志，resume 过滤器只隐藏行。

---

## 字体

TUI 唯一的私有区（PUA）字形是 footer 的 powerline 分隔符（U+E0B0）——
没有哪个默认终端字体自带它，没装 Nerd/Powerline 字体的终端会显示豆腐块。
`dsh-tui.iconSet` 设置（`auto` | `nerdfont` | `plain`，默认 `auto`）让危险字形
（U+E0B0、⏹、⭘）自适应终端：

- `auto` —— 启动时探测到 Nerd/Powerline 字体就用 powerline 字形，
  否则用安全的 Unicode 替代（`▸ ■ ●`）。
- `nerdfont` —— 始终用 powerline 字形（你已经设好字体了）。
- `plain` —— 始终用安全替代，无需任何字体。

**一键安装内置字体**（安装 + 把终端指过去，保留你的字号）：

```sh
node scripts/install-font.mjs
```

脚本把 `assets/fonts/dsh-tui-pi-nerd.ttf`（约 170KB 的子集：ASCII +
U+E0B0 + TUI 渲染的每一个符号）拷进用户字体目录，并尽力翻转终端设置：
macOS iTerm2（PlistBuddy，默认 bookmark）、Linux GNOME Terminal
（gsettings）以及 kitty/alacritty/wezterm（改配置文件，先备份）。
Terminal.app 被刻意跳过（它的字体是二进制 blob）——请手动设置。
每一步都有防护：失败只记录警告并继续，绝不破坏性地改动你的配置。

**或者手动设置终端字体** —— 任意 Nerd Font 家族设为终端主字体即可
（如 JetBrainsMono Nerd Font、Hack Nerd Font，或安装后的内置
`DSH TUI Nerd`）：iTerm2 → Settings → Profiles → Text → Font；
Terminal.app → Settings → Profiles → Text；kitty → `font_family`；
alacritty → `[font] family`；wezterm → `wezterm.font("…")`。
下次启动时 `auto` 就会解析成 powerline 字形。

---

## 安装（本地）

`tui` profile 从 npm registry 安装本插件——profile 的 `package.json`
钉住 `"@aiwayds/dsh-tui-pi": "<version>"`，由 pnpm 像普通依赖一样解析。
发版后升级 profile：

```sh
node scripts/dev-upgrade.mjs                  # 最新版
node scripts/dev-upgrade.mjs 0.15.1 --dry-run # 先预览执行计划
```

脚本先在 registry 校验版本存在，然后只更新
`~/.dsh/profiles/tui/package.json` 里的 `"@aiwayds/dsh-tui-pi"` 一个键
（保格式的 read-modify-write），在该目录执行 `pnpm install`，最后校验
安装副本报告的版本与目标一致。绝不碰 `~/.dsh/settings.yaml` 或
`.credentials.yaml`。重启 dsh（或在 TUI 内 `/reload`）加载新副本。

## 安装（npm）

在全新 profile 里安装完整的 dsh 插件套件：

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh plugin --profile tui add @aiwayds/dsh-subagent-registry
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

然后启动：

```sh
dsh --profile tui
```

**自动发生的事：**

- dsh 通过 `reconcilePlugins` 把三个插件注册进 `dsh.profile.bundles`。
- dsh 在 profile 的 `pnpm-workspace.yaml` 里设置 `autoInstallPeers: false`。
- 首次启动时 dsh 调用 `healProfilesModuleFallback`，在
  `~/.dsh/profiles/node_modules/@deepseek-ai/*` 下创建软链指向全局 dsh
  闭包（`$(which dsh)/../../node_modules/@deepseek-ai`）。这让所有插件共享
  同一个 `@deepseek-ai/cordis` 实例——无需手动搭建闭包。
- `compaction-basic` 被 `@aiwayds/dsh-dcp` 的补丁禁用；dsh-dcp 接管成为
  compaction 后端。

**不会自动发生的事：**

- 不再有补丁相关的事：自 0.8.0 起，仓库和 npm 包运行同一个原版
  `@earendil-works/pi-tui`——画布背景由我们自己的写流装饰器（BCE）
  绘制，随包内置，消费方 profile 不需要任何 `pnpm-workspace.yaml` 条目。

### 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| `Cannot find package '<name>' imported from ~/.dsh/profiles/...` | 某 bundle 的 `cordis.patch.yml` 的 `name` 字段与 scoped 包名不匹配。 | 更新插件；所有 `@aiwayds/*` 插件的补丁现在都用 `name: '@aiwayds/<pkg>'`。 |
| npm 安装的 dsh 报 `Cannot find package '@deepseek-ai/dsh-client-schema-form'` | npm 分发的 dsh 闭包缺这个包（上游打包缺口——[deepseek-harness discussion #3471](https://github.com/deepseek-ai/deepseek-harness/discussions/3471)）。 | 本插件自 0.8.1 起已修（辅助函数 vendored，不再 import 缺失的包）。需要它的其他插件：`cd ~/.dsh/profiles/<profile> && pnpm add @deepseek-ai/dsh-client-schema-form@next`。 |
| `Cannot read properties of undefined (reading 'prepare')` | 出现重复的 `@deepseek-ai/cordis` 模块实例（profile 树里有两份物理副本）。 | 见 AGENTS.md 铁律 8。删除物理副本 `~/.dsh/profiles/tui/node_modules/@deepseek-ai` 并让 dsh heal 兜底：`rm -rf ~/.dsh/profiles/tui/node_modules/@deepseek-ai && dsh --profile tui`（heal 会重建为软链）。 |
| pnpm 提示 `Peer dependencies that should be installed: @deepseek-ai/...` | 某插件把 `@deepseek-ai/*` 放进了普通 `dependencies` 而非 `peerDependencies`。 | 更新插件（所有 `@aiwayds/*` dsh 插件都用 optional peerDeps）。警告无害——pnpm 不会自动安装 optional peers。 |
| pnpm 提示 `Ignored build scripts: @aiwayds/dsh-tui-pi@...` | pnpm 10 默认阻止 build 脚本，tui-pi 的 postinstall（`link-dsh-closure.mjs`）被跳过。 | 这是预期且**无害**的——postinstall 只影响仓库开发流，不影响 npm 消费者。闭包链接由 dsh 的 `healProfilesModuleFallback` 处理。 |

---

## 使用

```sh
dsh --profile tui        # 或：dsh-tui-pi（bin shim）
```

---

## Companion plugins（可选）

- **[@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router)**
  （作为默认依赖附带）。独占唯一的 `ctx.userQuestions` provider 槽位，
  把每个 `ask_user_question` 扇出到绑定到提问 session 的各个交互面——
  第一个答案获胜，落败的交互面自动关闭。激活方式是在 profile 的 `bundles`
  里把 `@aiwayds/dsh-ask-router` 列在**任何 UI bundle 之前**；没有它时
  TUI 面板独自接管问题。
- **[@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu)**（可选）。
  用手机上的飞书/Lark 驱动已有的 dsh session：轮次卡片、交互式 `/resume`
  选择器，以及加入 router 扇出的 ask-user **卡片面**——桌面上提问，
  手机上作答，或两边同时呈现而第一个答案获胜。想要手机侧参与时装进同一
  profile；纯桌面环境可跳过。绝不把 router 装进 **web** profile
  （上游 web apiproxy 注册自己的 provider，不容忍重复）。

### 飞书集成演示

dsh-feishu companion 实战——桌面上的 dsh-tui-pi 与手机上的飞书/Lark
驱动（并代答）同一个 dsh session：

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

演示来自 [dsh-feishu Demos issue](https://github.com/fan56/dsh-feishu/issues/1)。

---

## 开发

```sh
pnpm check    # tsc --noEmit
pnpm build    # 输出 lib/
pnpm test     # 单元测试，node --test 对 lib/ 执行（757 个测试，pretest 构建）
```

本地类型检查通过 symlink 把 `node_modules/@deepseek-ai/*` 指向已安装的
dsh 闭包（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`）；
这些 symlink 不会打入任何 tarball。`scripts/link-dsh-closure.mjs`
（包的 `postinstall`）在每次 `pnpm install` 后重建所有链接。

**pi-tui**：npm 上的原版 `@earendil-works/pi-tui` 0.84.2——无补丁、
无 fork。全屏画布背景由我们自己的写流装饰器实现
（`src/canvas-terminal.ts`，BCE）。

---

## 目录结构

```
bin/dsh-tui-pi        launcher shim（exec dsh --profile tui）
cordis.patch.yml      bundle patch：将插件挂载为 `tui-pi`
src/
  index.ts            cordis plugin 入口：命令注册、footer、
                      git watcher、时钟、bridge、主题热切换、shutdown
  tui.ts              alt-screen 树、transcript ScrollView、dock、canvas 背景
  session.ts          DshSessionBridge：agent 创建、followup、resume、
                      O(1) 增量统计、subagent tracker
  live-widgets.ts     Todos 面板 + 运行中 agent 活动行
  messages.ts         TranscriptRenderer：session 事件 → pi-tui 组件、
                      流式 setText、高度可配置面板
  footer.ts           PowerlineFooter（7 分段 + 时钟）
  editor.ts           CwdBorderEditor（顶部边框：cwd + git 分支）
  subagent-policy.ts  maxAgents 守卫 + maxRounds 收尾注入
                     （运行中走 steer；⚡ 标记，查看器可见）
  subagent-viewer.ts  Ctrl+G 选择器 + 实时 transcript 面板 + Enter steer 注入
  ask-user.ts         Ask User Question 停靠面板：纯状态 reducer +
                      带边框 overlay UI + ctx.userQuestions provider
  steer-flow.ts       Steer / follow-up 决策层：带竞态兜底的路由投递、
                      队列操作（remove / promote）、通知
  route-dialog.ts     提交路由对话框（排队为 follow-up 还是立即 steer）：
                      纯 key reducer + 带边框 overlay
  queue-panel.ts      Ctrl+O 待发消息队列：d remove · s steer now，
                      实时刷新 overlay
  theme/              GitHub light/dark 配色 + 终端检测
test/*.test.mjs       单元测试（757 个，覆盖 44 个文件）
```

---

## 更新日志

发布历史见 [CHANGELOG.md](CHANGELOG.md)。

---

## 致谢

- [Ask User Question（向用户提问）](#ask-user-question向用户提问) 的灵感来自
  [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question) ——
  其交互设计（编号选项列表 + 自由文本 sentinel、多问题 review 页、拒绝手势；
  后来又重构为一次一个问题的 tab 视图加可折叠小条）被适配到了本 TUI 的
  停靠面板架构与 dsh `userQuestions` provider 架构上。这里的全部代码均为原创。
