[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 pi 风格终端 UI——一套把 dsh 变成 pi 式编码代理体验的插件套件：pi-tui 的外观与交互、dsh 斜杠命令、GitHub 明/暗主题和 powerline 状态栏。

**兼容性**：已针对 dsh `0.1.1-rc.2` 测试；斜杠命令在 `dsh-commands` 的 `execute()` 签名变更（rc.8 之前的 3 参 → 当前的 4 参）下依然可用。

https://github.com/user-attachments/assets/6a7e00bb-1fd0-4bc5-9070-457f1e9fa54d

*一次真实 session 的实况录制（MP4，1.5× 速度）——todos、运行中的 subagents、think/tool 面板和 powerline footer 的实际效果。*

## ✨ 功能亮点

> 每一项都链接到下文对应小节——一句话讲清楚它能给你什么。

- [**Footer——会话实时总览**](#footer-状态栏) — provider/model、上下文压力与会话缓存命中率一眼看清，始终在视线内。
- [**Think 与 Tool 面板**](#think-与-tool-面板) — 推理和工具活动不进对话记录，对话读起来干净清爽。
- [**Subagents 子代理**](#subagents-子代理) — 每个运行中的 subagent 都有一行状态；实时观看并操控它。
- [**Ask User Question**](#ask-user-question-向用户提问) — 模型可以暂停下来向你提结构化问题，无需离开 TUI 即可作答。
- [**Dynamic context pruning (DCP)**](#dynamic-context-pruning-dcp) — 上下文自动保持在限制内，零 LLM 调用。
- [**Persistent context 持久上下文**](#persistent-context-持久上下文) — 你的基本规则随每次请求生效，热应用无需重启。
- [**模型 profile 与收藏**](#模型-profile-与收藏) — 按项目整体切换一套模型配置，并让选择器保持精简。
- [**Sessions 会话与恢复**](#sessions-会话与恢复) — 会话自动保持整洁，几次按键即可恢复。
- [**Themes 主题**](#themes-主题) — GitHub 明/暗配色，热切换；`auto` 跟随你的终端。

---

## Footer 状态栏

一个 session 所有关键数字——provider/model 路由、推理等级、上下文占用、消息与工具计数，外加实时时钟——都收在钉于屏幕底部的同一条 powerline 状态栏里，编辑器顶部边框则显示你的工作目录和 git 分支。不用离开终端，就能看到成本压力（context %、cache-hit %）和实时活动。

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

**Cache-hit（`CHxx%`）** 是会话的缓存命中率——会话全部计费输入流量中由 prompt 缓存供给的占比。它按整个 session 累计（切换 provider/model 不会重置），并且只有会话实际计费过缓存 token 后才会显示。（布局见 [ARCHITECTURE.md](ARCHITECTURE.md)。）

---

## Think 与 Tool 面板

实时推理和工具调用渲染为**钉在聊天输入框上方**的固定面板，而不是滚进对话记录，因此对话线程始终可读。面板只在有活动时才出现，高度可配置（`dsh-tui.panelHeight`：`1` 行，`5`/`7`/`10` 行带边框，或 `all`）。

---

## Subagents 子代理

运行中的 subagent 以紧凑的单行状态显示在编辑器下方——名称、上下文占用、rounds、已耗时——不用打开任何东西就能看到委派情况。`Ctrl+G`（或 `/subagents`）打开实时 transcript 查看器；在查看器内按 `Enter` 即可给子代理发消息 steer。`● Todos` 面板把你的任务树钉在输入框上方。上限（`maxAgents`、`maxRounds`，经 `/agents` → `l` 配置）防止委派失控。

---

## Ask User Question 向用户提问

模型在一轮回答进行到一半时可以暂停，通过 `ask_user_question` 工具向你提结构化问题；应答侧是停靠在输入框上方的面板——不用来回切换窗口。一次一个问题，其余收进标签页；`Ctrl+T` 把面板折叠起来，双击 `Esc` 拒绝作答。自由文本、多选、多问题确认页、bracket-paste，以及右键 / `Ctrl+Shift+C` 从系统剪贴板粘贴，全都支持。

看看 ask-question 流程的实际效果：

https://github.com/user-attachments/assets/aa36be36-a508-4f53-ba85-efe0394dab11

---

## Dynamic context pruning (DCP)

上下文自动保持在模型窗口内：[dsh-dcp](https://github.com/fan56/dsh-dcp) 压缩 session **无需调用 LLM 做摘要**。挂载一次即透明运行——footer 的 context 段随压缩回落；在 subagent 内部，每次提交的压缩都会在查看器中以 `🧹` 提示显示。

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

---

## Persistent context 持久上下文

`$DSH_HOME/APPEND_SYSTEM.md`（默认 `~/.dsh/APPEND_SYSTEM.md`，pi 约定）会追加到**主 agent** 的 system prompt 末尾并热应用——编辑文件后下一条请求就能看到，无需重启。TUI 首次运行时从模板播种该文件，幂等维护其带标记的 todo-lifecycle 段，并且绝不覆盖你的内容。子代理被刻意排除在外。

---

## 模型 profile 与收藏

`/profile-switch` 一次选择切换整套配置——默认模型、推理等级、以及每个 subagent 的模型；`p` 把某个 profile 钉到当前目录，该目录树下的每个新 session 都会加载它。`/model` 的收藏与隐藏列表让选择器保持精简。用 `/profile-cfg` 管理 profile（名录、编辑、保存当前、重命名、删除）。

---

## Sessions 会话与恢复

`/resume` 用几次按键恢复任意最近的 session（按最后更新排序），`/new` 开启新会话，`/export` 把会话日志写成 JSONL（`~/Downloads/dsh-session-<id>.jsonl`）。启动清理器（`dsh-tui.retention.*`）修剪旧的会话日志，存储不会无界增长；resume 选择器只显示工作集（`dsh-tui.resume.*`）。两者都可在 `~/.dsh/settings.yaml` 配置，并带环境变量覆盖。

---

## Themes 主题

GitHub 明/暗配色，`/theme` 热切换；`auto` 检测你的终端并跟随实时的明/暗切换。`DSH_TUI_THEME=light|dark` 钉选一套配色，`DSH_TUI_TRANSPARENT=1` 让画布透出终端背景，`DSH_TUI_MOUSE=buttons|all|off` 调节鼠标追踪。

---

## 斜杠命令

| 命令 | 功能 |
|---|---|
| `/model` | 两阶段 provider/model 选择器 + 推理等级；`f` 收藏、`h` 隐藏、`/` 过滤（持久化）。 |
| `/think` | 推理强度选择器（`Off`/`High`/`Max`）。 |
| `/session` | 只读信息：id、cwd、model、token 用量、事件数。 |
| `/resume` | 选择持久化的 session（新的在前），校验日志后恢复。 |
| `/new` | 分离当前 session；下一条 prompt 开启新会话。 |
| `/settings` | 文本式设置浏览器（命名空间、schema 遍历、密钥脱敏）。 |
| `/export` | 把当前会话日志写成 JSONL。 |
| `/permission` | 权限预设选择器（read-only / workspace-write / danger-full-access）。 |
| `/theme` | 配色选择器（`auto`/`light`/`dark`），立即生效。 |
| `/preset` | agent preset 选择器；`<name>` 直接切换，`next` 循环（同 `Tab`）。 |
| `/profile-switch` | 把模型 profile 应用到当前选择、持久化默认值和 agent 文件；`p` 钉住当前目录。 |
| `/profile-cfg` | 管理 profile：编辑默认模型 / think / 各 agent 模型，`s` 保存当前，`n` 新建，`r` 重命名，`d` 删除。 |
| `/agents` | 管理 agent markdown 文件 + subagent 上限（`maxAgents`、`maxRounds`）。 |
| `/subagents` | 选择运行中/最近的 subagent 并观看其实时 transcript；`Enter` steer。 |
| `/skills` | 管理用户 skills（已安装与可用）。 |
| `/model-sync` | 为手工声明（baseURL）的 provider 发现模型并合并进 settings。 |
| `/reload` | `pnpm build` 后从源码热重载插件。 |
| `/login` | 登录 provider（或 `/login openai`）；**Custom provider…** 添加任意 OpenAI/Anthropic 兼容网关。 |
| `/logout` | 删除 provider 的已存 key 与 profile。 |
| `/hotkeys` | 快捷键浏览器与实时编辑器。 |

其余内容作为普通 prompt 落给模型；dsh 原生命令（`plan`、`compact`、`feedback`、`goal`……）原样可用。

---

## 键盘快捷键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送 prompt |
| `Esc` | **双击停止**（单击进入待发状态；有 popup 打开时改为关闭它） |
| `Ctrl+C` | 对话中：第一次取消当前轮次，第二次退出；空闲时：清空编辑器 / 退出。长按自动重复绝不会触发退出。 |
| `Ctrl+D` | 退出（仅在编辑器为空时） |
| `Ctrl+L` | 打开 model/think 选择器 |
| `Ctrl+G` | 打开 subagent 选择器（查看器内 `Enter` 打开 steer） |
| `Ctrl+O` | 待发消息队列（`s` 立即 steer · `d` 移除） |
| `Tab` | 循环切换 agent preset |
| `↑` / `↓` | 浏览已提交消息历史 |

通过 `~/.dsh/keybindings.json`（部分 JSON 映射，实时应用）或 `/hotkeys` 交互式重映射任意 app 按键。

---

## 配置

会话存储相关的旋钮位于 `~/.dsh/settings.yaml` 的 `dsh-tui` settings 命名空间下（每个也都有环境变量覆盖，`DSH_TUI_RETENTION_*` / `DSH_TUI_RESUME_*`；优先级：settings.yaml > env > 默认值）：

```yaml
dsh-tui:
  retention:        # ~/.dsh/sessions 的启动清理器——删除旧日志。每次启动跑一次。
    maxCount: 100   # <= 0 关闭清理器
    maxAgeDays: 7
    minIdleHours: 24
  resume:           # /resume 显示过滤器——只隐藏选择器行，从不删除。
    maxAgeDays: 7
    minBytes: 20480
```

其他旋钮：`dsh-tui.panelHeight`（think/tool 面板高度）、`dsh-tui.iconSet`（`auto`/`nerdfont`/`plain`——powerline 字形自适应你的字体；用 `node scripts/install-font.mjs` 安装 Nerd Font）、`~/.dsh/keybindings.json`（按键重映射）。

---

## 安装与启用

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh plugin --profile tui add @aiwayds/dsh-subagent-registry   # optional
dsh plugin --profile tui add @aiwayds/dsh-dcp                 # optional
dsh --profile tui          # 启动（或：dsh-tui-pi）
```

过去需要手工 patch 的一切——画布背景、`@deepseek-ai` 模块闭包、compaction 后端——现在都自动完成。发版后升级现有 profile：

```sh
node scripts/dev-upgrade.mjs                  # 最新版
node scripts/dev-upgrade.mjs 1.0.0 --dry-run  # 先预览执行计划
```

---

## Companion plugins 伴生插件

- [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) —— 作为默认依赖附带；把每个 `ask_user_question` 扇出到所有应答面（TUI 面板、飞书卡片），第一个答案获胜。把它加进 profile 的 `bundles`，放在任何 UI bundle 之前即可激活。
- [@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu) —— 可选；用手机上的飞书/Lark 驱动同一个 dsh session，包括 ask-user 卡片面。想手机侧参与就装进同一个 profile。

### Feishu integration demo 飞书集成演示

桌面上的 dsh-tui-pi 与手机上的飞书/Lark 驱动（并代答）同一个 dsh session：

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

演示来自 [dsh-feishu Demos issue](https://github.com/fan56/dsh-feishu/issues/1)。

---

## 开发

```sh
pnpm check    # tsc --noEmit
pnpm build    # 输出 lib/
pnpm test     # 单元测试，node --test 对 lib/ 执行（pretest 构建；56 个文件共 1038 个测试）
```

`pi-tui` 从 npm 原样运行——无补丁、无 fork。铁律与质量门禁见 [AGENTS.md](AGENTS.md)。

---

## 文档索引

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 完整设计：进程模型、分层、数据流。
- [HANDOFF.md](HANDOFF.md) —— 会话历史与当前状态（中文）。
- [CHANGELOG.md](CHANGELOG.md) —— 发布历史。
- [AGENTS.md](AGENTS.md) —— 贡献者的工作约定与质量门禁。
- [docs/](docs/) —— 设计笔记（steer/follow-up 流程、showcase 草稿……）。

---

## 致谢

[Ask User Question](#ask-user-question-向用户提问) 交互的灵感来自 [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question)（改编自本 TUI 的停靠面板与 dsh `userQuestions` provider 架构；这里的全部代码均为原创）。
