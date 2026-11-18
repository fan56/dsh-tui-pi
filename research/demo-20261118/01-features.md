# dsh-tui-pi 产品介绍 Demo — 功能面盘点（01-features）

- 调研日期：2026-11-18
- 仓库实际路径：`/Users/qingguee/repo/dsh-tui-pi`
- **最新版本（npm 实测，2026-11-18）：`2.38.1`**，包名 `@aiwayds/dsh-tui-pi`（无 scope 的 `dsh-tui-pi` 返回 404）。详见 **B2. 版本状态核实**。
- 仓库本地 `package.json` 仍为 **2.37.1**（CHANGELOG.md:27）；2.38.x 的功能代码已在 main（commit `a431121` 等），但版本记账（package.json / CHANGELOG 发布段 / tag）未合回 main。本文功能面以已发布的 2.38.1 + main HEAD 代码为准。
- CHANGELOG 顶部的 **Unreleased** 段（CHANGELOG.md:7-25）所列改动已随 2.38.1 发布，不再视为「未发布」。
- 来源约定：文中 `README.md:行号` / `CHANGELOG.md:行号` 指上述仓库内文件；`docs/features/xxx.md` 指对应特性文档。

---

## A. 产品定位

dsh-tui-pi 是 DeepSeek Harness（dsh，上游 `deepseek-ai/deepseek-harness`）的 pi 风格终端 UI 插件套件：它把 dsh 变成 pi 式 coding-agent 体验，提供 history 回看/按轮 fork、preset 切换、live subagent steer、model profile、20+ 主题和 powerline footer 等能力（README.md:3-5）。

与宿主 dsh 的关系（严格按 README/CHANGELOG）：

- **bin 是启动器/转发器，不是产品本体**：`dsh-tui-pi`（及短别名 `dst`，2.32.0 引入）是全局 bin shim，负责开机自检、首次装机（onboarding）、profile 挂载版本跟随、影子包守卫与 projcache 预迁移，随后 `exec dsh` 进入宿主（README.md:41-43、56-60；CHANGELOG.md:83-85、827）。
- **profile 机制**：插件与 9 个默认 companion plugin 安装进 profile 的 `node_modules`，通过 profile 的 `bundles` 列表决定哪些 bundle 激活；配置写在 profile 的 `cordis.patch.yml` 的 `dsh-tui` entry config 中，dsh 0.1.7 会把 Config schema 的字段投影到 settings 面（README.md:45、83-95、128）。启动命令形如 `dsh --profile tui`（README.md:47-54）。
- **宿主门槛**：要求 dsh >= 0.2.2-rc.1，仅面向 RC/stable 线；宿主低于门槛时启动守卫打一行警告并干净退出，可用 `DSH_TUI_SKIP_HOST_CHECK=1` 跳过（README.md:7、45；CHANGELOG.md:49）。
- **无安装钩子（README 口径 / Unreleased）**：README.md:45 写「包不带 install-time hook，机器在启动器首次运行时初始化」；CHANGELOG 中这一改动列在 Unreleased（CHANGELOG.md:14），即 README 已按未发布改动撰写。已发布 2.37.1 的确切钩子状态**待核**（README.md:45 vs CHANGELOG.md:7-14）。

---

## B. 当前版本用户可见功能全量表

版本号取自 CHANGELOG.md 对应条目的发布段；`待核` 表示无法从两份文档确证。可演示性评级：`高`=开箱即可出镜、`中`=需预置数据/companion/较长等待、`低`=画面收益低或属内部机制。

| 功能名 | 引入版本 | 用户价值一句话 | 可演示性 | 默认可用性 | 演示方式（前置状态 / 动作 / 预期画面） | 来源 |
|---|---|---|---|---|---|---|
| Powerline footer 会话总览 | 0.1.0 | provider/model、context 压力与 cache-hit 率常驻可见 | 高 | 开箱即用 | 前置：一个已有流量的会话；动作：发几条消息后停留；预期：底部一行显示 provider/model+thinking、context、cache-hit、msgs 段 | README.md:17；CHANGELOG.md:2515 |
| Think & tool 面板 | 0.1.0 | 推理与工具活动移出 transcript，对话保持干净 | 高 | 开箱即用 | 前置：一个会触发 think + tool 的 prompt；动作：发送；预期：会话区只留结论，think/tool 以盒装面板呈现于输入上方 | README.md:18；CHANGELOG.md:2519 |
| Subagents（Ctrl+G viewer / steer / stop） | 0.2.0（2.x 持续增强） | 每个子代理有状态行，可看实时 transcript、tok/s 并就地 steer | 高 | 需 opt-in 或装扩展 | 前置：注册 `~/.dsh/agents/*.md` 并触发 `use_agent`；动作：Ctrl+G → 选 child → Enter steer、RUNNING 时 `x ×2` 停止；预期：picker 显示状态/模式/rounds/tokens/elapsed，viewer 显示实时 transcript 与 header | README.md:19、116；CHANGELOG.md:2420、699-703、687 |
| viewer tok/s 与 `/session` speed 统计 | 2.29.0 | 看到模型真实解码速度与按模型计费明细 | 高 | 需 opt-in 或装扩展 | 前置：有 streaming 的 child 与已结算消息；动作：进入 child viewer → `/session`；预期：header 显示 `~87 tok/s` 或累计均值；`/session` 多出 `speed`、`models` 两行（如 `deepseek-v4-flash 2×12.3k 86t/s`） | README.md:19、27；CHANGELOG.md:122-123、131-132 |
| 工具调用一次性审批面板 | 2.31.0 | 工具调用需人工批准，fail-closed、默认拒绝 | 高 | 开箱即用 | 前置：触发需审批的工具调用；动作：PgUp/PgDn 翻参数 → Enter 选 allow-once 并二次确认，或 Esc/Ctrl+C 拒绝；预期：面板列出 tool、reason、call ID 与完整参数，默认 deny，粘贴文本不能批准 | README.md:20；CHANGELOG.md:95 |
| Ask User Question | 0.18.0 | 模型可暂停提出结构化问题，用户在 TUI 内回答 | 高 | 开箱即用 | 前置：模型调用 ask_user_question；动作：Tab 切题、填写、Submit；预期：停靠式问题面板，答完回到会话 | README.md:21；CHANGELOG.md:1545 |
| Feishu 多 surface 驱动同一会话 | 0.25.x（多 surface 路由 0.25.1） | 桌面 TUI 与手机 Feishu/Lark 驱动并回答同一 dsh 会话 | 中 | 需 opt-in 或装扩展 | 前置：装 `@aiwayds/dsh-feishu` 并配置；动作：手机端发消息；预期：TUI 同步出现回答/提问卡片 | README.md:22、103；docs/features/feishu-demo.md；CHANGELOG.md:1058、1039 |
| Dynamic context pruning（DCP） | 0.4.3 | 上下文自动压回限额，零 LLM 调用 | 中 | 需 opt-in 或装扩展 | 前置：长会话接近 context 上限；动作：触发 `/dcp` 或自动压缩；预期：transcript 出现压缩提示，context 回落 | README.md:23；CHANGELOG.md:2322 |
| Persistent context（APPEND_SYSTEM.md） | 0.1.0 | 规则随每次请求热应用，无需重启 | 低 | 需 opt-in 或装扩展 | 前置：写入 `~/.dsh/APPEND_SYSTEM.md`；动作：发消息；预期：画面无直接可见变化，需旁白说明 | README.md:24；CHANGELOG.md:2520 |
| 收藏模型 / 隐藏模型 | 0.16.0 | 收藏置顶、隐藏项不显示，picker 保持精简 | 中 | 需 opt-in 或装扩展 | 前置：配置 `favoriteModels` / `hiddenModels`；动作：Ctrl+L；预期：picker 出现 favorites 分隔线与 Hidden 段 | README.md:25；CHANGELOG.md:1676、1683 |
| Agent preset 切换 | 0.15.0（2.7.0 改为确认式立即生效） | `/preset` 切预设并开新会话，旧会话仍可 resume | 中 | 开箱即用 | 前置：宿主 0.1.7 preset registry；动作：`/preset` → 选 → 确认；预期：确认对话框 + 新会话启动 | README.md:26；CHANGELOG.md:1758、756-758 |
| 会话保留与 `/resume` 恢复 | 0.21.0（janitor）；默认值 2.30.0 | 会话自动整理、几键恢复 | 高 | 开箱即用 | 前置：有多条历史会话；动作：`/resume`；预期：按时间列的可恢复会话列表，Enter 恢复 | README.md:27；CHANGELOG.md:1200、113 |
| History browser | 2.25.0 | 双栏回看已完成轮次、复制 prompt、按轮 fork | 高 | 开箱即用 | 前置：有历史的会话；动作：`/history` → 选 turn → `f`；预期：左栏 completed turns、右栏该轮回复，`f` 建新分支会话 | README.md:28；CHANGELOG.md:763、758 |
| Themes（20 built-in + 用户目录 + 实时预览） | 2.18.0 | 20 个主题热切换，`auto` 跟随终端 | 高 | 开箱即用 | 动作：`/theme`；预期：双栏 picker，左列表右 mock chat 随光标实时换色（10 light + 10 dark） | README.md:29；CHANGELOG.md:592-604 |
| Search / selection / images | 1.2.0（Ctrl+Shift+F、拖选）；2.27.0（`/search` 跨会话） | 本会话与跨会话全文搜索、拖选复制、图片内联 | 高 | 开箱即用 | 动作：Ctrl+Shift+F 输入词，或 `/search` 查全部会话；预期：搜索覆盖层高亮命中，`Enter` 打开 | README.md:30；CHANGELOG.md:887-889、257 |
| Slash commands 自动补全 | 各版本累积 | `/model`、`/resume`、`/btw`、`/plugins`、`/search` 等统一入口 | 高 | 开箱即用 | 动作：输入 `/`；预期：autocomplete 列表按类别列出命令 | README.md:31；CHANGELOG.md:614-617 |
| Plugin manager `/plugins` | 2.27.0 | 开关 bundle、确认卸载、预览后安装并报告结果 | 中 | 开箱即用 | 动作：`/plugins`；预期：约 30 行表格，操作后 inline 显示 applied / takes effect next start / failed | README.md:32；CHANGELOG.md:246 |
| Settings browser 与 UI 语言 | 2.20.0 | `/settings` 就地编辑，`/language` 切界面语言 | 高 | 开箱即用 | 动作：`/settings` → 浏览分类 → TUI → Subagent 组；预期：字母序分类（Agent Presets/General/Models/Plugins/TUI）与实时值 | README.md:33、128-140；CHANGELOG.md:477-502、503-514 |
| Startup plugin tree | 1.2.1 | 启动即打印每个 profile 插件及其安装版本 | 中 | 开箱即用 | 前置：启动过程；预期：启动树逐行列出 `@aiwayds/xxx@版本` | README.md:34；CHANGELOG.md:882 |
| 键位重映射与 `/hotkeys` | 0.2.0（keybindings.json）；`/hotkeys` | 按键可改，热键表可查 | 中 | 开箱即用 | 动作：`/hotkeys`；预期：可滚动热键表，含 workflow overlay / widget cycle / pan 行 | README.md:122；CHANGELOG.md:2446、109 |
| 一条命令装机 + 启动（onboard） | 2.32.0（Unreleased 改为无 install hook、首启完成） | `npm i -g` 后直接 `dsh-tui-pi` 即完成装机与启动 | 中 | 开箱即用 | 前置：干净机器（或已装机环境演静默 fast path）；动作：运行安装与启动命令；预期：每步一行进度（装 host / pnpm / 建 tui profile），就绪后静默进 TUI；首次下载约 834 MB host，宜用预置环境或录屏快进 | README.md:38-54；CHANGELOG.md:83、14 |
| `dst` 短别名 | 2.32.0 | 少打几个字符启动 | 低 | 开箱即用 | 动作：终端输入 `dst`；预期：进入同一 TUI | README.md:42；CHANGELOG.md:84 |
| Profile 版本跟随 | 2.32.0 | 全局包升级后，profile 挂载副本下次启动自动更新 | 低 | 开箱即用 | 前置：先 `npm i -g` 升级；动作：下次启动；预期：profile 内版本与新全局一致（画面无直接提示） | README.md:45；CHANGELOG.md:85 |
| Workflow widget 面板 v2 + Alt+W / Alt+←/→ | 2.30.0（per-session widget 文件 2.36.0） | workflow 运行状态固定在输入上方，可切并发 run、可横向平移 | 高 | 需 opt-in 或装扩展 | 前置：dsh-workflow 有运行中的 run；动作：观察 widget → Alt+W 切 run → Alt+←/→ 平移；预期：标题行（名称/进度/活动子代理数/token ledger）+ 5 行树窗口 + RUNNING 居中 + spinner + hotkey footer | CHANGELOG.md:105-109、43 |
| Ctrl+K workflow overlay | 2.29.0 | 从 TUI 打开 workflow 驱动面板 | 中 | 需 opt-in 或装扩展 | 前置：有 workflow 定义；动作：Ctrl+K；预期：overlay 打开；无 workflow 时显示 i18n none-notice | CHANGELOG.md:120；README.md:109（`/hotkeys` 行）|
| External widget files seam | 2.29.0 | sibling 插件可把实时行钉入 dock，无需本插件理解其领域 | 低 | 需 opt-in 或装扩展 | 演示方式：配合 dsh-workflow widget 间接呈现；预期：输入上方出现外部插件写入的行 | CHANGELOG.md:121、43 |
| Session retention 配置 | 0.21.0（janitor）；默认扩宽 2.30.0 | 默认保留一个季度会话历史，可配置 | 中 | 开箱即用 | 动作：`/settings` 查看 `dsh-tui.retention.*`；预期：显示 `maxCount: 300` / `maxAgeDays: 90` / `minIdleHours: 72` | README.md:79、144；CHANGELOG.md:113、1200 |
| 空闲写锁释放（idle lock release） | 2.34.0 | TUI 空闲后释放 kernel 写锁，手机 `/resume` 能接管 | 中 | 开箱即用 | 前置：`dsh-tui.idleReleaseSec`（默认 600s）；动作：闲置后从手机发 `/resume` 并追问；预期：TUI 用原 session id 重建并显示其他 surface 写入的轮次 | CHANGELOG.md:64 |
| 启动前影子包守卫 | 2.34.0 | 启动前发现 profile 里错误的 `@deepseek-ai/*` 副本并给出移除命令 | 中 | 开箱即用 | 前置：profile 内故意放一个 bare-name stub；动作：启动；预期：停止启动并打印两条路径、两个版本与 `pnpm remove` / `rm -rf` 命令 | README.md:56；CHANGELOG.md:65 |
| 不兼容插件启动警告 | 2.37.0 | 宿主兼容门跳过的插件在 transcript 中持久显示警告 | 高 | 开箱即用 | 前置：profile 放一个 `engines.dsh`/peer 不满足的插件；动作：启动；预期：transcript 出现 attention 色 `⚠ plugin @aiwayds/xxx skipped: requires … (host …)` 行 | CHANGELOG.md:35 |
| Esc 双击 stop-everything 确认框 | 2.10.0 | 停止动作先确认影响范围，避免误杀 | 高 | 开箱即用 | 前置：主轮次与/或子代理在运行；动作：Esc ×2；预期：对话框列出影响范围（主轮 + N 子代理），Enter 停止、Esc 保留 | README.md:112；CHANGELOG.md:699-702 |
| 退出不卡终端（guarded hard-exit） | 2.20.0 | 退出有 3s watchdog，不再悬挂终端 | 低 | 开箱即用 | 动作：Ctrl+C ×2；预期：打印 resume hint 后干净退出 | CHANGELOG.md:517-524 |
| Apache-2.0 许可 | 2.36.0 | 许可由 MIT 换为 Apache-2.0 | 低 | 开箱即用 | 演示方式：片尾字幕/仓库画面说明 | CHANGELOG.md:52；LICENSE |
| 装机失败人话提示与退出码细节 | Unreleased（非 2.37.1） | npm 子进程死因以信号/退出码明示 | 低 | 开箱即用 | 前置：构造失败环境（如低内存）；预期：`dsh-tui-pi: dsh host install — killed by signal SIGKILL` 后 exit 1 | CHANGELOG.md:22、11；docs/adr/0004-onboarding-first-launch-not-postinstall.md:27 |

### B1. 指定 7 项专项核对

| 待核对项 | 结论 | 依据 |
|---|---|---|
| onboard 一条命令装机 | **属实**。2.32.0 引入「One-command install & launch」；README 现行口径为无 install hook、首启完成（该细化列在 Unreleased，已发布 2.37.1 的钩子状态待核） | CHANGELOG.md:83、14；README.md:41-45 |
| 工具调用审批面板 | **属实**，2.31.0，fail-closed / 默认拒绝 / allow-once 需二次确认 / PgUp-PgDn 滚动 | CHANGELOG.md:95；README.md:20 |
| viewer tok/s 与 session speed 统计 | **属实**，2.29.0，两者同版本引入（viewer header 实时/累计 tok/s；`/session` 的 `speed` + `models` 行） | CHANGELOG.md:122-123；README.md:19、27 |
| subagents 支持 | **属实**，首版 0.2.0（Ctrl+G viewer + `/agents` 细粒度控制），后续 0.7.0/0.10/0.12/0.17/2.10/2.29 等持续增强 | CHANGELOG.md:2420-2437、787、680、656、1597、699-703、122 |
| 启动/退出速度优化 | **部分属实 / 待核**。CHANGELOG 无名为「启动/退出速度优化」的功能条目；相关可感知改动：2.28.1 把 retention janitor 延后 3s 避免与首帧重叠、2.32.0 装机后 fast path 静默启动、2.20.0 退出 watchdog 防挂起。是否有量化的「速度提升」宣称，两份文档均无 | CHANGELOG.md:145、83、517-524 |
| retention 配置 | **属实**。janitor 0.21.0；2.30.0 默认扩为 maxCount 300 / maxAgeDays 90 / minIdleHours 72，并同步 `/resume` 窗口到 90 天 | CHANGELOG.md:1200、113；README.md:79、144 |
| 退出码行为 | **待核（无独立发布功能项）**。相关事实：2.20.0 guarded hard-exit；早期宿主过旧时启动守卫 exit 1；Unreleased 中装机失败 exit 1、升级 exit 0（ADR 0004）。不存在一个叫「退出码行为」的独立用户功能/版本 | CHANGELOG.md:517、637、11、22；docs/adr/0004-onboarding-first-launch-not-postinstall.md:27、44 |

### B2. 版本状态核实（2026-11-18 补充）

背景：初查以仓库 `package.json` 为 2.37.1；历史记录称 11-14 前后已发布 2.38.1（内容 = postinstall 剥钩子 / onboarding 挪首启 / pnpm 钉版）。核实如下。

**1) npm 实际发布版**（包名是 scoped 的 `@aiwayds/dsh-tui-pi`；无 scope 的 `dsh-tui-pi` 返回 404 E404，初查命令因包名不对而静默失败）

| 查询 | 结果 |
|---|---|
| `npm view @aiwayds/dsh-tui-pi versions --prefer-online \| tail -5` | `2.37.0, 2.37.1, 2.38.0, 2.38.1`（尾部） |
| `npm view @aiwayds/dsh-tui-pi version --prefer-online` | **`2.38.1`** |
| `npm view @aiwayds/dsh-tui-pi dist-tags --prefer-online` | `{ latest: '2.38.1', 'probe-tmp': '2.33.0' }` |
| `npm view @aiwayds/dsh-tui-pi time --prefer-online` | 2.37.1 → 2026-11-06；2.38.0 → 2026-11-12；2.38.1 → 2026-11-14 |

**2) 仓库 git 状态**

- `git log --all --oneline --grep="2.38"` 命中 2 条：`a431121 feat: strip install hooks, move onboarding to first launch`（提交时间 2026-11-14 22:28 +0800，提交说明明确写 "the published **2.38.0** baseline keeps the hook as a historical fixture"）与 `2bb7bcc fix(deps): raise the dsh host floor to 0.2.2-rc.1`。
- `git branch -a --contains a431121` → **main、origin/main、origin/HEAD**；2.38 相关功能代码在 **main**（当前 HEAD `d917ab9 fix: resolve boot-onboard scratch dir via os.tmpdir()`，其后为 `a431121`、`c860cc3`）。不存在单独的 2.38.x 分支；其它分支为 `feat/decode-tps`、`release/v2.29.0`（停在 7856f55）、`stale-alpha3-20260901`、`origin/feat/projcache-sweep-retention`。
- `git tag | tail -10` → 只到 `v2.9.1`，**没有 2.38.x tag**（tag 整体陈旧，不能作版本依据）。
- `git log --all -S'"version": "2.38' -- package.json` → **零命中**；`git show main:package.json` 与 `git show origin/main:package.json` 的 version 均为 **2.37.1**；CHANGELOG 也没有 2.38.0/2.38.1 发布段（只有 Unreleased）。

**3) 发布产物 vs 仓库代码**

- `npm view @aiwayds/dsh-tui-pi@2.38.1 scripts` → **无 `postinstall` 键**（与 main 上 `a431121` 剥钩子的代码一致）。
- `npm view @aiwayds/dsh-tui-pi@2.38.0 scripts` 与 `@2.37.1 scripts` → **仍含 `postinstall: node scripts/postinstall.mjs`**。
- 即：2.38.0 仍带钩子，钩子剥离落在 **2.38.1**；仓库 main 的功能代码与已发布的 2.38.1 行为一致。

**结论**：**发版的版本记账 commit 未合回 main** —— 2.38.x 的功能代码（剥 postinstall 钩子、onboarding 挪首启、companion 钉版）确实已在 main（commit `a431121` 等），但「把 package.json / CHANGELOG 升到 2.38.x、打 tag」的发布记账动作从未在这个仓库的任一 ref 上提交；已发布的 2.38.0/2.38.1 来自仓库外的发布流程。历史记录「已发布 2.38.1」属实，初查「最新版 2.37.1」是只读了本地 package.json 所致，**以 npm 为准**。

**对 demo 的影响**：开场版本号应引用 **npm 最新版 2.38.1**（对照 B 节的 Unreleased 条目：这些改动在已发布版中已落地，不应再标注「即将到来」）；功能面以 main HEAD 代码 + 已发布 2.38.1 为准，2.29.0→2.37.1 的叙事线需补一句「2.38.0/2.38.1：移除 install hook，装机全部移到首启」，其来源为 CHANGELOG 的 Unreleased 段（CHANGELOG.md:7-25）与 commit `a431121`。

来源：npm registry（`npm view ... --prefer-online`，2026-11-18 实测）、仓库 git（`git log/tag/branch/show`，2026-11-18 实测）、CHANGELOG.md:7-25、10。

### B3. 默认可用性核对（2026-11-18，源码级）

口径：demo 只介绍**默认安装后（跑完 onboard、零额外配置、零扩展插件）开箱即用**的功能。结论直接落盘到 B 节表格的「默认可用性」列。

#### 1) subagents 默认可用性：**否**

> 更正说明：本小节对 e2e 引文的解读及"装了不加载=bug"的暗示已被 **B4. subagents 加载链路定性** 修正。结论——默认 onboard 后 use_agent 不可用（否）仍成立，但原因是"opt-in companion 需显式 plugin add registry + 重启"，**不是 bug**。以 B4 为准。

历史歧义澄清：`registeredOnly` 默认值确实是 `false`，但它是「更宽的围栏」，与"能否用 subagent"无关——它只决定**是否把除 `use_agent` 外的所有 spawn 工具都拒绝**。真正的默认拦截不在 TUI 围栏，而在 **registry 扩展没被自动装成 bundle**。

- **a) `registeredOnly` 默认值与语义**
  - 默认值 `false`：`src/theme-settings.ts:132`（`DEFAULT_SUBAGENT_LIMITS` 常量，`registeredOnly: false`），schema 默认值同源于 `src/theme-settings.ts:239-243`（`.default(DEFAULT_SUBAGENT_LIMITS.registeredOnly)`），读取回退见 `src/theme-settings.ts:699-712`。
  - 语义：`false` = 不启用宽围栏，只有 `disableSubagent`（默认 `true`，`src/theme-settings.ts:131`）这一个窄围栏生效；`true` 才拒绝除 `use_agent` 外的一切 spawn（`src/subagent-policy.ts:30-34`、`:508-522`）。
  - `disableSubagent: true` 默认只禁用原生 `subagent` 工具（`NATIVE_SPAWN_TOOLS = ['subagent']`，`src/subagent-policy.ts:81-83`），`use_agent` / `subagent_fork` / `workflow` / `ralph` 不在禁用列表（`src/subagent-policy.ts:66-72`、`:523-526`）。即 TUI 侧的围栏**默认不阻止** `use_agent`。
- **b) 默认安装、零配置下能不能用 subagent：`use_agent` 不可用**
  - `dsh plugin add` **不会把依赖自动装进 bundles**：e2e 场景原文「`dsh plugin add` does NOT auto-bundle dependencies: scenario 10 installs tui-pi alone, so the registry package sits in profile node_modules but is **never LOADED — use_agent is unknown to the model (ToolNotFoundError)**」（`e2e/scenarios/75-hard-stop.sh:48-51`）。
  - README 明确九个子插件只是"ship with this package（装进 profile 的 node_modules）"，**activation still follows the profile's `bundles` list — list each one there to activate it**（`README.md:85`）；`dsh-subagent-registry` 就是第九个（`README.md:94`）。
  - 本插件的 `cordis.patch.yml` 只自动挂载 4 个 entry（`dsh-tui`、`profile-switch`、`tool-ask-user`、`tui-pi-projcache`，`cordis.patch.yml:73-82`），**没有 registry 挂载条目**（grep 结果为空）。
  - 结论：默认安装只把 registry 的包放进 `node_modules`，不激活；模型拿不到 `use_agent` 工具，TUI 侧 `/agents` 表格与 Ctrl+G viewer 即使存在也无子代理可显示——**subagent 功能默认不可用**。
- **c) 默认有哪几个 registered subagent**：**默认安装一个都没有**。
  - registered agent 来自 `~/.dsh/agents/*.md`（`README.md:94`、`src/subagent-policy.ts:108-110`、`:509-510`），registry 扩展激活后首次启动才植入三件套。
  - 三件套 = `workhorse`（牛马狗）/ `oldfox`（老法师）/ `rubber-duck`（小黄鸭），见 sibling 仓库 `~/repo/dsh-subagent-registry/README.md:39-48`；它们属于 **registry 扩展激活后的首次播种**，不是 tui-pi 默认安装的一部分。
  - `mini`/PTC 系（`ptc-subagent`、`minimal-subagent`）是 **experimental、默认关闭、永不自动安装**，只能经 `/registry-config` 显式勾选或手工拷模板（`~/repo/dsh-subagent-registry/README.md:50-56`、`:126`、`:135-145`；`src/opt-in-agents.ts:29`）。
- **演示前置条件（若仍要展示）**：① `dsh plugin --profile tui add @aiwayds/dsh-subagent-registry` 把扩展真正加入 bundles（`e2e/scenarios/75-hard-stop.sh:65-80` 即真实用户做法）；② registry 首启播种出 `~/.dsh/agents/*.md`（sibling README.md:41）；③ 宿主 dsh >= 0.2.2-rc.1（README.md:7），且 registry 版本与宿主 rc 线匹配（`e2e/scenarios/75-hard-stop.sh:44-63`）。**这三步都超出"零额外配置、零扩展插件"，故第 5 幕「派活 subagent」应从默认可用性 demo 清单划掉。**

#### 2) 四项默认功能核对（均零配置开箱，源码/文档佐证）

| 功能 | 结论 | 行号/文档佐证 |
|---|---|---|
| onboard 一条命令装机 | **开箱即用**。onboarding 是 bin 首启自动流程，非 opt-in：安装 host（缺失时）、pnpm、建 `tui` profile 及 bundled companions，每步一行进度；失败项后续启动自动补完 | README.md:38-54；`bin/onboard-core.mjs:70-79`（companions 直接从 package.json 的 `@aiwayds/*` 依赖推导）；CHANGELOG.md:83、14 |
| 工具调用审批面板 | **开箱即用（面板 provider 默认注册）**，但触发需宿主发出 `approval/request`：`ctx.effect(() => registerApprovalProvider(...))` 在 apply 阶段无条件注册，无配置开关；fail-closed 默认拒绝、无自动答复 | `src/index.ts:1063`；`src/approval.ts:109-121`；docs/features/approval.md:3-9；CHANGELOG.md:95。注：宿主侧谁产生 `approval/request` 事件（权限策略插件等）属宿主/其他插件范畴，**待核**；demo 如需现场触发审批，需确认宿主已配置相应权限策略 |
| tok/s 统计 | **/session 侧开箱即用；viewer 侧需 subagent 前置（非默认）**。`/session` 的 `speed`/`models` 从既有 `assistant/message` 事件流计算，无订阅项、无配置开关；viewer header 的 tok/s 挂在 subagent child 上，依赖 subagent 可用 | CHANGELOG.md:122-123（"nothing new is subscribed"、"rides the existing 300ms viewer tick"）、`:131-132`；README.md:27 |
| 会话恢复 | **开箱即用**。`/resume` 为内建命令，retention/resume 窗口有默认值（300/90/72；resume 90 天），无需配置；显式设置或 `DSH_TUI_*` 环境变量只做覆盖 | README.md:27、79、144；CHANGELOG.md:113、1200；`src/theme-settings.ts` 默认值族 |

#### 3) 对 demo 分幕的影响

- 第 5 幕「派活 subagent」：**划掉**（默认不可用，见 B3-1；加载链路定性见 B4——是"装上需额外步骤"，非 bug）。
- 保留且可零配置出镜的高价值画面：footer、think/tool 面板、`/session` 的 speed/models 行、审批面板（需宿主触发条件，见上）、Ask User Question、`/history`、`/theme`、跨会话搜索、`/resume`、`/settings`、启动插件树、一条命令装机。
- 依赖扩展/配置的画面（如 workflow widget、Feishu、收藏模型、mini agent）不得作为"开箱即用"卖点，只能放在"可扩展"语境或干脆不出现。

### B4. subagents 加载链路定性（2026-11-18，回应"装了不加载是不是 bug"）

**三选一定性：属于 (b) "装上还需额外步骤"，不是 (c) bug，也不完全是 (a) "插件 add 后即加载即用"。** 精确表述：registry 是**声明为 bundle 的 companion 依赖，装进 node_modules 后不会自动生成 bundle 条目**；但**显式 `dsh plugin add @aiwayds/dsh-subagent-registry` 会被宿主 `reconcile()` 自动加进 bundles**，重启后即加载、use_agent 可用。上一轮"装了也不加载/从不加载"的措辞是**误读**，需更正。

#### 1) e2e 引文语境（上轮引用确实需重新解读）

`e2e/scenarios/75-hard-stop.sh:40-60` 原文（关键段）：

```
44  # --- the registry plugin: use_agent's home ----------------------------------
...
49  # `dsh plugin add` does NOT auto-bundle dependencies: scenario 10 installs
50  # tui-pi alone, so the registry package sits in profile node_modules but is
51  # never LOADED — use_agent is unknown to the model (ToolNotFoundError).
52  # Install it as a real bundle member, exactly what a real user does.
...
65  if ! grep -qF '@aiwayds/dsh-subagent-registry' "$HOME/.dsh/profiles/tui/package.json" 2>/dev/null \
66    || ! grep -qF '@aiwayds/dsh-subagent-registry' <(dsh plugin --profile tui list 2>/dev/null); then
...      REG_TGZ=(vendored build / npm pack @0.19.1)
82    if timeout 300 dsh plugin --profile tui add "$REG_TGZ" >/tmp/reg-add.log 2>&1; then
83      ok "registry plugin installed into the tui profile ..."
...
90  else
91    ok 'registry plugin already bundled'
92  fi
```

真实语义：这段**不是**"没装 registry 的环境里模拟"。它描述的是**同一台环境里两个不同状态**——
- **状态 A（scenario 10 刚装完 tui-pi）**：registry 作为 tui-pi 的 npm 依赖躺在 node_modules，但**没有 bundle 条目**，所以插件管理器不加载它，`use_agent` 对模型未知（ToolNotFoundError）。第 49-51 行说的就是**这个状态**。
- **状态 B（第 65-92 行的动作）**：脚本检测"registry 不在 bundle 列表"→ 主动 `dsh plugin add <registry tarball>` 把它**装成真正的 bundle 成员**（第 82 行）→ 第 159-164 行重启 TUI → 第 168 行成功 `use_agent` 派活并断言硬停链。

所以上轮引用 48-51 来证明"默认状态下 use_agent 不可用"**在状态 A 层面是对的**（默认 onboard 只装 tui-pi，确实停在状态 A），但**据此推出"装上也不加载=bug"是误用**——同一脚本紧接的 65-92 行就是"装成 bundle → 加载成功"的正例，即状态 A→B 的迁移是可行的、设计内的运维步骤。

#### 2) 宿主插件加载机制（关键：bundles 不是静态封闭清单）

- **宿主 `reconcile()` 会把新装的、声明了 `dsh.bundle` 的依赖自动加进 bundles**。证据：本机宿主 `@deepseek-ai/dsh-plugin-manager/src/operations.ts:95-128`（编译产物 `lib/index.js:442-475` 同逻辑）：
  ```
  const dependencies = Object.keys(after.dependencies ?? {})
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  for (const name of dependencies) {
    if (beforeDeps.has(name)) continue
    const metadata = bundleManifest(name, dir, anchor)
    if (metadata?.dsh?.bundle === undefined) { warn "no dsh.bundle — plain dependency, not a profile layer"; continue }
    ...
    if (!bundles.includes(name)) bundles.push(name)
  }
  ```
- **registry 声明了 `dsh.bundle`**：`/Users/qingguee/repo/dsh-subagent-registry/package.json` 与本机已装副本 `/Users/qingguee/.dsh/profiles/tui/node_modules/@aiwayds/dsh-subagent-registry/package.json` 均为 `{"patch": "./cordis.patch.yml"}`。因此**显式 `dsh plugin add @aiwayds/dsh-subagent-registry` 时，`reconcile()` 命中 `dsh.bundle` → 自动 `bundles.push(name)` → 重启即加载**。这正是 e2e 第 82 行那一步生效的机理。
- **为什么"默认 onboard 装完仍停在状态 A"**：onboarding 只执行一条命令 `dsh plugin --profile tui add @aiwayds/dsh-tui-pi`（`bin/onboard-core.mjs:323,334`；第 320-322 行只是把 companions 列进日志，没有逐条 `plugin add`）。 companions 作为 npm 依赖被 pnpm 落进 profile 的 `node_modules`，但**它们既不是这次 `add` 的直接参数、也（在纯 npm-class profile 里）没有各自触发一次带 `dsh.bundle` 的 `reconcile()`**，所以 registry 不会自动获得 bundle 条目。这与 `README.md:85` 的原文一致："Default dependencies … installed into the profile's `node_modules`); **activation still follows the profile's `bundles` list — list each one there to activate it**."
- 结论：上一轮"出厂 patch 里没写 registry"只证明了**静态层**没有它；但宿主运行时**会**合并"新装且声明 dsh.bundle 的插件"进 bundles——所以"装了也从不加载"不成立。真正的缺口是**从"作为 tui-pi 的传递依赖落进 node_modules"到"成为 profile bundle 成员"这一步没有被 onboarding 自动执行**。

#### 3) 本机实证（最强证据）

- `~/.dsh/profiles/tui/package.json`：`dependencies` 含 `@aiwayds/dsh-subagent-registry`，且 `dsh.profile.bundles` 数组里**明确列出** `'@aiwayds/dsh-subagent-registry'`——即本机 registry 是 bundle 成员。
- `dsh plugin --profile tui list` 输出含 `├── @aiwayds/dsh-subagent-registry@0.20.1`。
- 启动日志 `/Users/qingguee/.dsh/logs/startup-...log:1723-1726`：`id: 'include:dsh-subagent-registry'`, `module: '@aiwayds/dsh-subagent-registry'`, `state: 'active'`。
- `~/.dsh/agents/` 有 `workhorse.md` / `oldfox.md` / `rubber-duck.md`（plus opt-in 的 `ptc-subagent.md`/`minimal-subagent.md`）——registry 首启播种已发生。
- **直接回答"本机这台 dsh-tui-pi 里 use_agent 现在能不能用"：能。** 证据链：registry 在 bundles + 启动日志 active + agent 名册非空 + e2e 75 证明此形态下 use_agent 派活成功。注意本机是长期开发机、`~/.dsh/agents` 被手工改过（时间戳 Nov 16-20），"开箱三件套"是 registry 首启播种的债务；但 use_agent 可用性本身已被上述证据坐实。

#### 4) 用户可按的三选一及影响

| 选项 | 判定 | 理由 |
|---|---|---|
| (a) 装上即加载即用 | 部分成立 | 仅当"装上"=显式 `dsh plugin add registry`（触发 reconcile）才成立；默认 onboard 不触发 |
| (b) 装上还需额外步骤 | **成立（最终定性）** | 默认 onboard 后 registry 只在 node_modules、无 bundle 条目；须手动 `dsh plugin --profile tui add @aiwayds/dsh-subagent-registry` + 重启。README.md:85 有一般性说明，但 features 段（README.md:19、docs/features/subagents.md）把 Subagents 当开箱特性陈述，**未标注这个前置步骤——文档缺陷** |
| (c) 装上也不加载 = bug | **否** | 宿主 `reconcile()`（operations.ts:106-122）+ registry 的 `dsh.bundle`（package.json）+ 本机 active 日志 + e2e 状态 B 全部反证；这是设计内的 opt-in 激活，非缺陷 |

**对 demo 的影响（不变）**：在"默认安装、零额外配置、零扩展插件"口径下，subagents 仍不可用，第 5 幕仍从默认清单划掉——但原因从"bug/从不加载"更正为"**opt-in companion：需用户显式 plugin add registry 并重启**（README 未在前台讲清）"。若产品方希望 subagents 真正开箱即用，修复方向是产品/文档决策（让 onboarding 逐条把 companion 加进 bundles，或在 features 段明确标注前置步骤），不是宿主 bug。

---

## C. 版本演进叙事线（2.29.0 → 最新，仅用户可感知里程碑）

| 版本 | 日期 | 用户可感知里程碑 | 来源 |
|---|---|---|---|
| 2.29.0 | 2026-10-21 | Ctrl+K workflow overlay；external widget files seam；subagent viewer 的 tok/s 与 `/session` 的 speed/models 行；`/session` 标题去掉过时的「tokens: current route」 | CHANGELOG.md:116-127 |
| 2.30.0 | 2026-10-26 | Workflow widget 面板 v2（标题行/5 行树/ spinner/ hotkey footer）；Alt+W 切并发 run、Alt+←/→ 平移；`/hotkeys` 增行；session retention 默认扩到 300/90/72 与 resume 窗口 90 天 | CHANGELOG.md:101-113 |
| 2.31.0 | 2026-10-27 | 交互式一次性工具审批面板（fail-closed、默认拒绝），社区贡献 @jokkopucko | CHANGELOG.md:91-99 |
| 2.32.0 | 2026-10-28 | 一条命令装机并启动；`dst` 别名；profile 挂载版本跟随 | CHANGELOG.md:79-85 |
| 2.32.1 | 2026-10-28 | 新装机自动解析最新 `latest`/`next` 宿主并升级过旧宿主，修 `use_agent` 首调用崩溃 | CHANGELOG.md:73-77 |
| 2.33.0 | 2026-10-28 | 宿主兼容窗口声明 0.2.1-rc.2 → rc.4（onboarding 不再强升 rc.2 宿主） | CHANGELOG.md:67-71 |
| 2.34.0 | 2026-10-30 | 空闲写锁释放（手机 `/resume` 可接管）；启动前影子包守卫 | CHANGELOG.md:60-65 |
| 2.36.0 | 2026-11-05 | per-session 外部 widget 文件 + Alt+W cycle signal；许可 MIT → Apache-2.0 | CHANGELOG.md:40-52 |
| 2.37.0 | 2026-11-06 | 启动时把被宿主兼容门跳过的插件显示为持久 ⚠ transcript 行 | CHANGELOG.md:32-35 |
| 2.37.1 | 2026-11-06 | 仅 companion 版本 bump（内部，跳过叙事） | CHANGELOG.md:27-30 |
| 2.38.0 | 2026-11-12 | 发布产物仍含 `postinstall`；具体变更内容**待核**（CHANGELOG 无该发布段） | B2 节；npm time/scripts 实测 |
| 2.38.1 | 2026-11-14 | 移除 install hook，onboarding 全部迁到启动器首启；四个 companion 钉到无钩子的修复版；装机失败给出人话提示与退出码细节 | B2 节；CHANGELOG.md:7-25；commit a431121 |

跳过的纯内部/依赖条目：2.35.0（依赖波）、2.37.1（registry bump）、各 e2e/CI/peer floor/锁文件改动（CHANGELOG.md:25、30、57-58 等）。

**版本口径更正（见 B2）**：CHANGELOG 的 Unreleased 段所列改动实际已随 **2.38.1** 发布（npm 实测 latest = 2.38.1，发布产物已无 `postinstall`），不再是「未发布/即将到来」。demo 开场版本号应引用 **2.38.1**；仓库 main 的 package.json 仍写 2.37.1 属发布记账未合回，不作为版本依据。

---

## D. 上镜画面要素清单

下列 UI 元素在 README/CHANGELOG 中被明确描述，适合作为 demo 镜头候选（括号为来源）：

- **Powerline footer**：provider/model+thinking、context pressure、cache-hit rate、msgs 段（README.md:17；CHANGELOG.md:2515）
- **Think 面板 / tool card**：盒装、位于输入上方，推理与工具活动不进 transcript（README.md:18；CHANGELOG.md:2338）
- **Subagent 状态行 + live Agents board**：活动子代理紧凑行、600ms reconcile（README.md:19；CHANGELOG.md:692）
- **Ctrl+G picker + transcript viewer**：picker 行含 status glyph、label、delegation mode、rounds/cap、token、elapsed；viewer header 2-3 行（身份+状态 / `provider/model · think level · mode` 路由行 / 活动与预算行含 tok/s）；300ms tick、tail-follow（CHANGELOG.md:687、2420-2427、122）
- **工具审批对话框**：tool / reason / call ID / 完整参数、PgUp-PgDn 滚动、allow-once 二次确认（CHANGELOG.md:95）
- **Ask User 停靠面板**：一题一屏、Tab 切题、Ctrl+T 折叠成 strip（README.md:21；CHANGELOG.md:1145、1158）
- **`/session` 面板**：20 行预算、`tok in/out`、`cache r/w`、`speed`、`models`（README.md:27；CHANGELOG.md:123）
- **`/history` 双栏浏览器**：左 completed turns、右该轮 replies，`▸` 光标、`f` fork（README.md:28；CHANGELOG.md:763-766）
- **`/theme` 双栏实时预览**：左主题列表、右 mock chat 随光标换色（CHANGELOG.md:604-611）
- **Workflow widget 面板**：标题行（name/progress/live subagent count/token ledger）+ 5 行树窗口 + RUNNING 居中 + spinner + hotkey footer；Ctrl+K overlay（CHANGELOG.md:105-109、120）
- **`/plugins` 表格**：约 30 行，operation 后 inline applied/takes-effect/failed（CHANGELOG.md:246、225）
- **`/settings` 分类浏览器**：字母序分类、Models 显示 per-provider 已配置 model id、Subagent 分组（CHANGELOG.md:503-514）
- **`/search` / Ctrl+Alt+F / Ctrl+Shift+F 搜索覆盖层**：命中 snippet、`Enter` 打开、`↳` 子会话只读（README.md:30；CHANGELOG.md:257）
- **`/resume` picker**：会话列表与恢复窗口（README.md:27；CHANGELOG.md:113）
- **启动插件树**：逐行 `@aiwayds/<name>@<version>`（README.md:34；CHANGELOG.md:882）
- **⚠ 不兼容插件警告行**：attention 色、含包名/未满足要求/宿主版本（CHANGELOG.md:35）
- **Stop-everything 确认对话框**：列出主轮 + N 子代理的影响范围（README.md:112；CHANGELOG.md:699）
- **键位与启动细节**：`/hotkeys` 表、slash autocomplete、退出时的 resume hint、`Tab` 已解绑的 preset 提示、whale banner（README.md:122、31；CHANGELOG.md:728、2195）

### 可复用演示脚本与素材路径（仅登记，未深读）

- 内嵌主 demo 视频（README.md:9 / README.zh-CN.md:9）：`https://github.com/user-attachments/assets/67a7c6ca-ff42-4005-b543-437ba61771bb`
- 本地视频素材：`/Users/qingguee/repo/dsh-tui-pi/assets/demos/mcp.mp4`（docs/features/mcp-adapter.md:5 引用）
- 特性文档内嵌视频（GitHub user-attachments）：`docs/features/{subagents,footer,ask-user-question,startup-tree,dcp,feishu-demo,think-tool-panels,sessions-resume,themes,slash-commands}.md` 各有 1-2 条；`docs/features/feishu-demo.md:5,7` 两条
- 可复用 e2e 场景脚本：`/Users/qingguee/repo/dsh-tui-pi/e2e/scenarios/` 下 `78-session-stats.sh`（tok/s 与 `/session` 行）、`70-steer-injection.sh`（viewer header 速率）、`75-hard-stop.sh` 与 `76-attention-early-stop.sh`（子代理硬停）、`68-ask-user.sh`、`77-plugins-search.sh`、`66-retention-resume.sh`、`80-onboard.sh`、`20-start.sh`、`30-commands.sh`、`40-theme.sh`
- 启动烟测：`/Users/qingguee/repo/dsh-tui-pi/scripts/smoke-boot.mjs`
- README/CHANGELOG 未提供独立 `demo/` 目录；最接近的是 `assets/demos/` 与各 `docs/features/*.md` 内嵌视频。

---

## E. 数据引用注意

- README.md / README.zh-CN.md 中**没有** star 数、下载量、badge 等运营数字（已逐行检查 README.md:1-181、README.zh-CN.md 相关行）。外部若引用此类数据，须注明：**以官方口径为准，demo 引用前需复核**。
- 文档中的量化描述同样建议复核后再上镜：20 个内置主题（10 light + 10 dark，CHANGELOG.md:592-603）、i18n 638 keys × 4 语言（CHANGELOG.md:480-481）、默认 retention `300 / 90 / 72`（CHANGELOG.md:113）、首次下载宿主约 834 MB（CHANGELOG.md:14）、viewer `~87 tok/s` 示例值（CHANGELOG.md:122）、退出 watchdog 3s（CHANGELOG.md:520）。这些是源码/CHANGELOG 口径，非营销承诺，作为旁白数字时应标明「以官方口径为准，demo 引用前需复核」。
- README.md:9 的内嵌视频标注「1.5× speed」——若二次剪辑复用，需自行标注加速倍率，避免误导为实时速度。
- Unreleased 条目（CHANGELOG.md:7-25）与 README 现行口径存在差异（见 A、B1），如做「当前版本」宣称，先复核实际发布版本号。
