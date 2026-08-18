# dsh-tui-pi

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 pi 风格终端 UI 插件 —— 把 dsh 变成 pi 风格的编码代理体验。

> English version: [README.md](README.md)

## 截图

![dsh-tui-pi 演示](./dsh-tui-pi-demo.gif)

真实会话的终端录制——Todos、运行中的 subagent、思考/工具面板和 powerline footer 一览。（[asciinema 交互播放](https://asciinema.org/a/BE212ZO8x1zEZyZn)）

### 布局总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  对话区（可滚动）                                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  💭 thinking — 推理进行中                                    │    │
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
         │                       │                └─ Footer（状态栏）
         │                       └─ 运行中的 subagent（last-request 区域）
         └─ Todos 面板（有边框，固定在输入框上方）
```

---

## 功能特性

### Footer 状态栏

底部固定显示当前会话的实时状态：

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

七个分段，全部从 O(1) 维护的计数器读取（从不扫描会话日志）：

| 分段 | 内容 |
|---|---|
| **Provider** | 当前 `provider/model` 路由 |
| **Model** | 模型简称 |
| **Thinking** | 推理强度等级（`off` / `high` / `max`） |
| **Context** | `已用 / 上限 (百分比%)` |
| **Cache-hit** | `CHxx%` —— prompt 缓存命中率 |
| **Messages** | 用户 + 助手消息总数 |
| **Tools** | 工具调用总数 |
| **Clock** | 右对齐实时 HH:MM:SS（每秒刷新） |

分段用 [U+E0B0](https://www.nerdfonts.com/cheat-sheet) powerline 箭头渲染，配色随主题切换。

编辑器顶部边框显示工作目录和 git 分支：

```
~/github (Full access) │ ⎇ main
```

---

### 思考面板 & 工具面板

运行中的思考和工具调用渲染为**固定面板，固定在输入框上方**（不会出现在可滚动的对话区）：

```
┌─ 💭 thinking ──────────────────────────────────────────────┐
│ Actually, I can check list_agents or wait…                 │
└────────────────────────────────────────────────────────────┘
⚙ bash  python scripts/demo.py  …  ✔ bash
```

行为要点：

- **每种类型一个面板** —— 整个运行期间只有一个 `ThinkPanel` 和一个 `ToolPanel`；每次事件刷新同一个面板，不会产生对话区刷屏。
- **空 = 隐藏** —— 无活动时面板渲染 0 行并消失。
- **`dsh-tui.panelHeight`**（默认 `1`）：1 行无边框（块标识 + 耗时 + 最后一行内容，右截断）；`5`/`7`/`10` 带边框面板；`all` 输出全部内容。
- **委派工具**（`use_agent`、`subagent`、`workflow`、`ralph`）不打开工具面板 —— 它们的子进程在底部的运行子代理行中显示。

---

### Subagents 子代理

运行中的子代理在**编辑器下方的 last-request 区域**显示为每行一条的紧凑状态：

```
↳ 创建 2 个 todo, 每个 todo 起一个 10s 的 subagent
  ↳ ⠼ Subagent A 10s 任务 · 1.2k token · 19.0s
  ↳ ⠼ Subagent B 10s 任务 · 562 token · 6.0s
```

每行显示：spinner + 代理**名称**，重试次数（`↻N≤M`），token 数（+ 上下文占比），耗时。不显示 provider，无边框，无标题。

#### Todos 待办面板

`● Todos (done/total)` 树是一个有边框的面板，**固定在输入框上方**（不随对话区滚动）：

```
┌─ ● Todos (0/8) ──────────────────────────────────────────┐
│ ├─ ☑ 调研 dsh-tui-pi 斜杠命令/补全机制                      │
│ ├─ ◐ 调研 harness ctx.skills API                         │
│ └─ ☐ 实现 /skill:<name> 补全并触发 skill                   │
└───────────────────────────────────────────────────────────┘
```

图标：`☑` 已完成，`◐` 进行中，`☐` 待处理。子代理完成后从列表消失；当面板和子代理行都为空时，整个区域折叠隐藏。

#### 子代理查看器 & 限制

`Ctrl+G`（或 `/subagents`）打开 80% 宽度的子代理选择器 —— 运行中的排在前面，然后是最近完成的 5 个。Enter 打开实时对话查看器（~3×/s 刷新，自动跟随尾部）。

两个限制项（通过 `/agents` → `l` 配置）：

- **`maxAgents`**（默认 4，`0` = 无限制）—— 超过上限时拒绝新的子代理创建。
- **`maxRounds`**（默认 50，`0` = 无限制）—— 子代理完成轮次达到上限后，TUI 排队发送一个收尾请求，从不强制终止。

---

### DCP 动态上下文裁剪

[DCP](https://github.com/fan56/dsh-dcp) 是 dsh 的零 LLM 上下文裁剪插件 —— 自动修剪上下文以保持在限制内，无需调用 LLM 做摘要。

`dsh-tui-pi` 将 `@aiwayds/dsh-dcp` 列为依赖，但**不自动挂载** —— dsh-dcp 自带 `cordis.patch.yml`（自 `@aiwayds/dsh-dcp@0.2.0` 起）。要启用：

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

挂载后 DCP 在后台透明运行。Footer 中的 **Context** 和 **Cache-hit** 分段实时反映裁剪效果。

---

## 斜杠命令

| 命令 | 功能 |
|---|---|
| `/model` | 两阶段选择 provider/model（然后选推理等级），实时切换并持久化。 |
| `/think` | 当前模型的推理强度选择（`Off`/`High`/`Max`）。 |
| `/session` | 只读信息面板：id、cwd、模型、token 用量、事件计数。 |
| `/resume` | 选择已保存的会话，验证日志后恢复。 |
| `/new` | 分离当前会话；下一次输入开启新会话。 |
| `/settings` | 文本式设置浏览器（命名空间、schema 遍历、内联编辑器、密钥脱敏）。 |
| `/export` | 将当前会话日志导出为 JSONL（默认 `~/Downloads/dsh-session-<id>.jsonl`）。 |
| `/permission` | 权限预设选择器（read-only / workspace-write / danger-full-access）。 |
| `/theme` | 配色方案选择器（`auto` / `light` / `dark`），实时生效。 |
| `/agents` | 管理 agent markdown 文件 + 子代理限制（`maxAgents`、`maxRounds`）。 |
| `/subagents` | 选择运行中/最近的子代理，查看其实时对话。 |
| `/reload` | 从源码热重载插件（`pnpm build` 后执行，无需重启 dsh）。 |
| `/hotkeys` | 快捷键浏览器和实时编辑。 |

不是已注册命令的内容会作为普通提示词发送给模型。

---

## 快捷键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送提示词 |
| `Esc` | **双击停止** —— 单击进入等待窗口（500ms）；弹窗打开时关闭弹窗；空编辑器时双击打开 `/session` |
| `Ctrl+C` | 对话中：第一次取消当前轮次，第二次退出。空闲时：第一次清空编辑器，第二次退出。**长按自动重复不会触发退出。** |
| `Ctrl+D` | 退出（仅在编辑器为空时） |
| `Ctrl+L` | 打开模型/推理强度选择器 |
| `Ctrl+G` | 打开子代理选择器（有运行中的子代理时） |
| `Tab` | 自动补全 |
| `↑` / `↓` | 浏览历史消息（shell 风格，保留 500 条） |

### 自定义快捷键

通过 `~/.dsh/keybindings.json` 重新映射任意按键 —— JSON 格式的按键映射表。可手动编辑后 `/reload`，或用 `/hotkeys` 交互式修改（实时生效，无需重启）。

---

## 主题

GitHub light / GitHub dark 配色方案，运行时热切换：

- `/theme` —— 实时选择器，整个屏幕重绘（含背景）。
- `DSH_TUI_THEME=light|dark` —— 环境变量钉选，优先于偏好设置。
- `DSH_TUI_TRANSPARENT=1` —— 透明画布（终端背景可见）。
- `auto` 模式自动检测终端并跟随实时明暗切换。

---

## 安装（本地）

```sh
# 一步构建 + 打包 + 安装到 profile
node scripts/dev-install.mjs        # pnpm build → pnpm pack → 刷新 profile 副本

# 或手动：
pnpm pack                            # → aiwayds-dsh-tui-pi-<version>.tgz
dsh plugin --profile tui add /path/to/aiwayds-dsh-tui-pi-<version>.tgz
```

Profile 的 `package.json` 包含两个指向同一 tarball 的键：
`dsh-tui-pi`（dsh 通过此名称解析 bundle）和
`@aiwayds/dsh-tui-pi`（`cordis.patch.yml` 中的 loader 入口）。

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

**自动完成的事：**

- dsh 将三个插件注册到 `dsh.profile.bundles`（通过 `reconcilePlugins`）。
- dsh 在 profile 的 `pnpm-workspace.yaml` 里设置 `autoInstallPeers: false`。
- 首次启动时 dsh 调用 `healProfilesModuleFallback`，在
  `~/.dsh/profiles/node_modules/@deepseek-ai/*` 创建软链指向全局 dsh
  闭包。所有插件共享同一个 `@deepseek-ai/cordis` 实例——无需手动建闭包。
- `@aiwayds/dsh-dcp` 的补丁禁用 `compaction-basic`，dsh-dcp 接管上下文压缩。

**不会自动完成的事：**

- pi-tui patchedDependencies（编辑器补全边框、SelectList 全行背景）
  **不会**为 npm 消费者自动应用——需要在 profile 的
  `pnpm-workspace.yaml` 里手动添加条目。这是**纯外观**问题：TUI 不打
  补丁照样启动，只是未选中行不会渲染全行背景。

### 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| `Cannot find package '<name>' imported from ~/.dsh/profiles/...` | 某个 bundle 的 `cordis.patch.yml` 的 `name` 字段与 scoped 包名不匹配 | 更新插件（所有 `@aiwayds/*` 插件已修复补丁 `name` 字段） |
| `Cannot read properties of undefined (reading 'prepare')` | profile 树里出现两个 `@deepseek-ai/cordis` 物理副本（模块重复安装） | 见 AGENTS.md 铁律 8。删掉物理副本：`rm -rf ~/.dsh/profiles/tui/node_modules/@deepseek-ai && dsh --profile tui`（dsh 会重新 heal 为软链） |
| pnpm 提示 `Peer dependencies that should be installed: @deepseek-ai/...` | 某个插件把 `@deepseek-ai/*` 放在 `dependencies` 而非 `peerDependencies` | 更新插件（所有 `@aiwayds/*` dsh 插件已改用 optional peerDeps），警告无害 |
| pnpm 提示 `Ignored build scripts: @aiwayds/dsh-tui-pi@...` | pnpm 10 默认阻止 build 脚本，tui-pi 的 postinstall 被跳过 | **正常且无害**——postinstall 只影响仓库开发流，npm 消费者由 dsh 的 `healProfilesModuleFallback` 处理闭包链接 |

---

## 使用

```sh
dsh --profile tui        # 或：dsh-tui-pi（bin shim）
```

---

## 开发

```sh
pnpm check    # tsc --noEmit
pnpm build    # 输出 lib/
pnpm test     # 单元测试，node --test 对 lib/ 执行（296 个测试，pretest 自动构建）
```

本地类型检查通过 symlink `node_modules/@deepseek-ai/*` 指向已安装的 dsh 闭包（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`）；这些 symlink 不会打入 tarball。`scripts/link-dsh-closure.mjs`（`postinstall`）在每次 `pnpm install` 后重新创建所有 symlink。

**pi-tui 补丁**：对 `@earendil-works/pi-tui` 0.84.2 的一个小补丁（`pnpm-workspace.yaml`，补丁文件在 `patches/`）添加了 `unselectedText` 和 `selectedPrefix` SelectListTheme 钩子以及编辑器自动补全边框。

---

## 目录结构

```
bin/dsh-tui-pi        启动器 shim（执行 dsh --profile tui）
cordis.patch.yml      bundle 补丁：将插件挂载为 `tui-pi`
src/
  index.ts            cordis 插件入口：命令注册、footer、git 监控、时钟、bridge、主题热切换、关闭
  tui.ts              alt-screen 树、对话区 ScrollView、dock、canvas 背景
  session.ts          DshSessionBridge：agent 创建、followup、resume、O(1) 增量统计、子代理追踪
  live-widgets.ts     Todos 面板 + 运行子代理活动行
  messages.ts         TranscriptRenderer：会话事件 → pi-tui 组件、流式 setText、可配置高度面板
  footer.ts           PowerlineFooter（7 分段 + 时钟）
  editor.ts           CwdBorderEditor（顶部边框：cwd + git 分支）
  subagent-policy.ts  maxAgents 守卫 + maxRounds 收尾请求注入
  subagent-viewer.ts  Ctrl+G 选择器 + 实时对话面板
  theme/              GitHub light/dark 配色 + 终端检测
test/*.test.mjs       单元测试（296 个，覆盖 24 个文件）
```

---

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
