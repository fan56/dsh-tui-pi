# dsh-tui-pi

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 pi 风格终端 UI 插件 —— 把 dsh 变成 pi 风格的编码代理体验。

**兼容性**：支持 dsh `0.1.0-rc.7` 与 `0.1.0-rc.8`。斜杠命令执行在运行时自适应两个版本的 `dsh-commands` `execute()` 签名（rc.8 在 `signal` 前插入了 `images` 参数；TUI 探测参数个数后按对应形式调用）。rc.8 下经单元测试 + tmux 真机冒烟验证；rc.7 调用路径与升级前的直接调用完全一致。

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

每行显示：spinner + 代理**名称**，重试次数（`↻N≤M`），当前上下文占用（`X/Y` —— 子代理最近一次请求的 billed input+output 加上其后消息的 CJK 估算，除以它的上下文窗口；**不是**只增不减的累计 token 消耗），rounds（`round N/M` —— assistant 消息数对上限，`maxRounds > 0` 时才显示 `/M`），耗时。不显示 provider，无边框，无标题。

**spawn 派生**与 **fork 派生**两类子代理都会被追踪——dsh 通过 `childSessionMeta` 同时写入 `origin: 'subagent'` 和 `delegationDepth` 预算，头部识别对两种标记都认得（只有预算没有 origin 的头部作为防御性兜底也会被接纳，标记为 `fork <id8>`；当前 dsh 不会产生这种形态）。非子代理会话按**值**而非字段有无被挡在板外：jsonl 持久化后端在每条恢复的头部上都会物化 `delegationDepth: 0`，所以闸门要求预算严格 `> 0`。面向用户的会话 fork（fork 出的*对话*：`Session.fork` 只设 `parentSession` + `seedLength`，不带预算）刻意不进子代理面板，仍可通过 `/resume` 恢复——`/resume` 的过滤器（`isResumableSessionHeader`）恰好排除被委派的子代理（`origin: 'subagent'` 或预算 > 0）。

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
- **`maxRounds`**（默认 75，`0` = 无限制）—— 子代理的 assistant 消息数（每次 LLM 往返计 1 round）达到上限后，TUI 排队发送一个收尾请求，从不强制终止。

---

### DCP 动态上下文裁剪

[DCP](https://github.com/fan56/dsh-dcp) 是 dsh 的零 LLM 上下文裁剪插件 —— 自动修剪上下文以保持在限制内，无需调用 LLM 做摘要。

`dsh-tui-pi` 将 `@aiwayds/dsh-dcp` 列为依赖，但**不自动挂载** —— dsh-dcp 自带 `cordis.patch.yml`（自 `@aiwayds/dsh-dcp@0.2.0` 起）。要启用：

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

挂载后 DCP 在后台透明运行。Footer 的 **Context** 分段计算的是当前上下文占用 —— 最近一次请求的 billed context 加上其后消息的 CJK 估算 —— 所以裁剪后下一次请求会变小，显示随之回落（百分比封顶 100，窗口是硬上限）。**Cache-hit** 分段反映会话累计的缓存复用。

在子代理内部，已提交的裁剪同样可见：DCP 在子代理自己的日志里为每次裁剪追加一行 `user/message` **notice**，Ctrl+G 的对话查看器用 `🧹` 标记渲染它（区别于通用的 `ⓘ`），选择器行的描述里带有该子代理的裁剪次数（`🧹 N×`）。DCP 的 `roundInterval` 与 TUI 的 `maxRounds` 数的是**同一样东西**——`assistant/message` 事件，每次 LLM 往返计 1——但行为不同：子代理计数达到 `maxRounds` 时 TUI 排队发一个收尾请求；会话计数达到 `roundInterval` 后 DCP 在下一个空闲边界执行裁剪（修剪上下文）。一个触发工作，一个释放上下文。

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
| `/preset` | Agent 预设选择器；`<name>` 直接切换，`next` 向前循环（同 `Tab`）。 |
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
| `Esc` | **双击停止** —— 单击进入等待窗口（500ms）；弹窗打开时关闭弹窗；空闲（无运行中任务）时不做任何操作 |
| `Ctrl+C` | 对话中：第一次取消当前轮次，第二次退出。空闲时：第一次清空编辑器，第二次退出。**长按自动重复不会触发退出。** |
| `Ctrl+D` | 退出（仅在编辑器为空时） |
| `Ctrl+L` | 打开模型/推理强度选择器 |
| `Ctrl+G` | 打开子代理选择器（有运行中的子代理时） |
| `Tab` | 循环切换 agent 预设（footer 品牌段显示当前预设 `dsh(<name>)`） |
| `↑` / `↓` | 浏览历史消息（shell 风格，保留 500 条） |

### 自定义快捷键

通过 `~/.dsh/keybindings.json` 重新映射任意应用按键 —— 一个部分 JSON 映射表，键为应用按键、值为按键 id（`ctrl+letter`、`alt+letter`、命名键）。可手动编辑，或用 `/hotkeys` 交互式修改（实时生效，无需重启）。

---

## Agent 预设

当部署提供了 `standard` 预设时，TUI 启动即选中它；否则选中扫描到的第一项。这只是本地选择：在你操作 `/preset` 或按 `Tab` 之前，创建会话时不会发送任何 `meta.agentPreset`，因此仍由服务端默认值（`agent-presets.default`）决定。footer 品牌段反映本地选择（`dsh(<name>)`）；一次切换会在下一个空白会话生效。

---

## 主题

GitHub light / GitHub dark 配色方案，运行时热切换：

- `/theme` —— 实时选择器，整个屏幕重绘（含背景）。
- `DSH_TUI_THEME=light|dark` —— 环境变量钉选，优先于偏好设置。
- `DSH_TUI_TRANSPARENT=1` —— 透明画布（终端背景可见）。
- `auto` 模式自动检测终端并跟随实时明暗切换。

全屏画布背景随包内置 —— 由写流装饰器（`src/canvas-terminal.ts`）用主题色
经 BCE 给每条擦除序列上色，无需补丁依赖。

---

## 字体

TUI 中唯一的私有区（PUA）字形是 footer 的 Powerline 分隔箭头（U+E0B0）——
默认终端字体都不含它，不装字体就会显示豆腐块。`dsh-tui.iconSet` 设置
（`auto` | `nerdfont` | `plain`，默认 `auto`）让危险字形（U+E0B0、⏹、⭘）
自适应终端：

- `auto` —— 启动时探测到 Nerd/Powerline 字体就用 Powerline 字形，否则用
  安全 Unicode 替代（`▸ ■ ●`）。
- `nerdfont` —— 始终用 Powerline 字形（你已经自己设好字体）。
- `plain` —— 始终用安全替代，无需任何字体。

**一键安装内置字体**（拷贝字体 + 尽量把终端切过去，保留原字号）：

```sh
node scripts/install-font.mjs
```

脚本把 `assets/fonts/dsh-tui-pi-nerd.ttf`（约 170KB 子集：ASCII + U+E0B0 +
本项目渲染的全部符号）拷进用户字体目录，并尽力改终端：macOS iTerm2
（PlistBuddy，定点改默认 bookmark）、Linux GNOME Terminal（gsettings）与
kitty/alacritty/wezterm（改配置文件，先备份）。Terminal.app 明确跳过（其
字体是二进制 blob）——请手动设置。每一步都带防护：失败只打警告并继续，
绝不动坏你的配置。

**或手动设终端字体**——任意 Nerd Font 家族作为终端主字体即可（如
JetBrainsMono Nerd Font、Hack Nerd Font，或安装后的内置 `DSH TUI Nerd`）：
iTerm2 → Settings → Profiles → Text → Font；Terminal.app → 设置 →
描述文件 → 文本；kitty → `font_family`；alacritty → `[font] family`；
wezterm → `wezterm.font("…")`。下次启动时 `auto` 就会解析成 Powerline 字形。

---

## 安装（本地）

`tui` profile 通过 npm registry 安装本插件——profile 的 `package.json` 钉
`"@aiwayds/dsh-tui-pi": "<version>"`，由 pnpm 像普通依赖一样解析。发版后
升级 profile：

```sh
node scripts/dev-upgrade.mjs                  # 最新版
node scripts/dev-upgrade.mjs 0.15.1 --dry-run # 先预览执行计划
```

脚本先在 registry 上校验版本存在，然后只更新
`~/.dsh/profiles/tui/package.json` 里的 `"@aiwayds/dsh-tui-pi"` 一个键
（保格式的 read-modify-write），在该目录执行 `pnpm install`，最后校验安装
副本的版本与目标一致。绝不碰 `~/.dsh/settings.yaml` 和
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

**自动完成的事：**

- dsh 将三个插件注册到 `dsh.profile.bundles`（通过 `reconcilePlugins`）。
- dsh 在 profile 的 `pnpm-workspace.yaml` 里设置 `autoInstallPeers: false`。
- 首次启动时 dsh 调用 `healProfilesModuleFallback`，在
  `~/.dsh/profiles/node_modules/@deepseek-ai/*` 创建软链指向全局 dsh
  闭包。所有插件共享同一个 `@deepseek-ai/cordis` 实例——无需手动建闭包。
- `@aiwayds/dsh-dcp` 的补丁禁用 `compaction-basic`，dsh-dcp 接管上下文压缩。

**不会自动完成的事：**

- 不再有任何补丁相关的事：自 0.8.0 起，仓库和 npm 包运行的是同一个
  原版 `@earendil-works/pi-tui`——画布背景由我们自己的写流装饰器（BCE）
  绘制，随包内置，消费方 profile 无需任何 `pnpm-workspace.yaml` 条目。

### 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| `Cannot find package '<name>' imported from ~/.dsh/profiles/...` | 某个 bundle 的 `cordis.patch.yml` 的 `name` 字段与 scoped 包名不匹配 | 更新插件（所有 `@aiwayds/*` 插件已修复补丁 `name` 字段） |
| npm 安装的 dsh 报 `Cannot find package '@deepseek-ai/dsh-client-schema-form'` | npm 分发的 dsh 闭包缺这个包（上游打包缺口——[deepseek-harness discussion #3471](https://github.com/deepseek-ai/deepseek-harness/discussions/3471)） | 本插件自 0.8.1 起已修（辅助函数内置，不再 import 缺失的包）。其他需要它的插件：`cd ~/.dsh/profiles/<profile> && pnpm add @deepseek-ai/dsh-client-schema-form@next` |
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
pnpm test     # 单元测试，node --test 对 lib/ 执行（541 个测试，pretest 自动构建）
```

本地类型检查通过 symlink `node_modules/@deepseek-ai/*` 指向已安装的 dsh 闭包（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`）；这些 symlink 不会打入 tarball。`scripts/link-dsh-closure.mjs`（`postinstall`）在每次 `pnpm install` 后重新创建所有 symlink。

**pi-tui**：npm 上的原版 `@earendil-works/pi-tui` 0.84.2——无补丁、无 fork。全屏画布背景由我们自己的写流装饰器实现（`src/canvas-terminal.ts`，BCE）。

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
test/*.test.mjs       单元测试（541 个，覆盖 37 个文件）
```

---

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
