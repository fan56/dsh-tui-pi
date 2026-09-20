[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的功能齐全的 pi 风格终端 UI——一套把 dsh 变成 pi 式编码代理体验的插件套件：/history 回看与任意轮分叉、确认式 preset 切换、subagent 实时操控、模型档案、20+ 内置主题（10 亮 + 10 暗，支持用户主题目录自动发现）和 powerline 状态栏。

**要求 dsh >= 0.1.5-rc.2** —— 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**宿主低于下限时，启动守卫会打一行 warning 并干净退出（可用 `DSH_TUI_SKIP_HOST_CHECK=1` 跳过）。alpha 单目标决策的历史见 [ADR 0002](docs/adr/0002-target-dsh-0.1.2-alpha.3-single-target.md)（已被取代）。

https://github.com/user-attachments/assets/67a7c6ca-ff42-4005-b543-437ba61771bb

*一次真实 session 的实况录制（MP4，1.5× 速度）——todos、运行中的 subagents、think/tool 面板和 powerline footer 的实际效果。*

## ✨ 功能亮点

> 每一项对应 [`docs/features/`](docs/features/) 下的一篇独立文档（英文），内附演示视频。

- [**Footer 状态栏**](docs/features/footer.md) —— provider/model、上下文压力、会话缓存命中率，始终在视野里。
- [**Think 与 Tool 面板**](docs/features/think-tool-panels.md) —— 推理与工具活动不进 transcript，对话保持干净。
- [**Subagents 子代理**](docs/features/subagents.md) —— 每个运行中的子代理一行状态；实时观看并 steer。
- [**Ask User Question 向用户提问**](docs/features/ask-user-question.md) —— 模型可暂停并提问结构化问题，不用离开 TUI。
- [**飞书集成**](docs/features/feishu-demo.md) —— 桌面端 dsh-tui-pi + 手机端飞书/Lark 驱动同一个 dsh session。
- [**动态上下文修剪（DCP）**](docs/features/dcp.md) —— 上下文自动保持在窗口内，零 LLM 调用。
- [**持久上下文**](docs/features/persistent-context.md) —— 你的基本规则随每个请求生效，热应用无需重启。
- [**模型 profile 与收藏**](docs/features/model-profiles.md) —— 按项目切换整套模型配置，选择器保持精简。
- [**Agent preset 切换**](docs/features/preset-switch.md) —— `/preset` 在内置 agent 组合（`standard`、`minimal`……）间切换；切换需确认并会开启新会话（当前会话仍可 /resume 恢复）；preset 到底管什么。
- [**Sessions 会话与恢复**](docs/features/sessions-resume.md) —— 会话自动保持整洁、几次按键恢复；跨进程写者守卫保证日志单写者。
- [**Themes 主题**](docs/features/themes.md) —— 20 个内置配色（10 亮 + 10 暗）+ 用户主题目录发现（`~/.dsh/themes/`）；热切换，`auto` 跟随终端。
- [**搜索、选择与图片**](docs/features/search-selection-images.md) —— `Ctrl+Shift+F` 全文搜索、划选复制到系统剪贴板、web/飞书附件内联渲染、LaTeX 转 Unicode 数学。
- [**斜杠命令**](docs/features/slash-commands.md) —— `/model`、`/resume`、`/btw`、`/profile-switch`……外加全部 dsh 原生命令。
- [**设置浏览器与界面语言**](docs/features/settings-i18n.md) —— `/settings` 就地浏览修改一切（字母序分类、每个 provider 的模型清单、Subagent 分组）；`/language` 在任意 surface 切换界面语言。
- [**启动插件树**](docs/features/startup-tree.md) —— 启动即打印每个 profile 插件及其安装的 npm 版本。

---

## 安装与启用

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh --profile tui          # 启动（或：dsh-tui-pi）
```

过去需要手工 patch 的一切——画布背景、`@deepseek-ai` 模块闭包、compaction 后端——现在都自动完成。发版后升级现有 profile：

```sh
node scripts/dev-upgrade.mjs                  # 最新版
node scripts/dev-upgrade.mjs 1.0.5 --dry-run  # 先预览执行计划
```

---

## 卸载

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-tui-pi
```

`dsh-tui-pi` 启动器是全局 bin shim，留着无妨；若还全局安装过本包，用 `npm -g rm @aiwayds/dsh-tui-pi` 一并移除。

宿主会自动清理 profile：`dsh.profile.bundles` 条目被剪除，整层 patch 随包一起消失——原生的 `session-projection-cache` 行恢复启用，projcache wrapper、`tool-ask-user` 插入及其禁用行全部随之消失。

以下内容刻意留在磁盘上（删用户数据是破坏性的；重装会全部复用）：`~/.dsh/APPEND_SYSTEM.md`、`tui-command-usage.json`、`model-profiles.json`、`keybindings.json`、`~/.dsh/agents/` 与 `~/.dsh/skills/`、工作区 `.dsh-profile` 固定文件、`settings.yaml` 的 `dsh-tui:` 段、会话投影缓存（含 `.bak-preflight-*` 迁移备份）。插件运行期间，保留清理器（默认 `maxCount: 100` / `maxAgeDays: 30`）会删除旧会话日志——卸载后即停止，但已删除的日志找不回来。`scripts/install-font.mjs` 会改动 OS 字体/终端状态且有文档化的备份；卸载不会碰它。

---

## Companion plugins 伴生插件

**默认依赖** —— 以下 8 个插件随本包自带（安装进 profile 的 `node_modules`）；激活仍以 profile 的 `bundles` 列表为准——把要用的逐个列进去即可。

- [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) —— 把每个 `ask_user_question` 扇出到所有应答面（TUI 面板、飞书卡片），第一个答案获胜；激活时在 `bundles` 里放在 UI bundle 之前。
- [@aiwayds/dsh-dcp](https://github.com/fan56/dsh-dcp) —— 确定性零 LLM 压缩后端。
- [@aiwayds/dsh-llm-proxy](https://github.com/fan56/dsh-llm-proxy) —— SYSTEM 代理 + 按 host 的 LLM 出站分流。
- [@aiwayds/dsh-llm-stats](https://github.com/fan56/dsh-llm-stats) —— `/llm-stats` 用量台账。
- [@aiwayds/dsh-mcp-adapter](https://github.com/fan56/dsh-mcp-adapter) —— 把 MCP 工具 schema 折出每个请求，并提供 `/mcp` 命令（[演示](docs/features/mcp-adapter.md)）。
- [@aiwayds/dsh-model-sync](https://github.com/fan56/dsh-model-sync) —— pi.dev 模型目录同步进 provider 路由。
- [@aiwayds/dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) —— 把 `~/.dsh/agents/*.md` 注册成 `use_agent` 子代理。
- [@aiwayds/dsh-web-search-anysearch](https://github.com/fan56/dsh-web-search-anysearch) —— AnySearch web 搜索 provider。

**推荐安装** —— [@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)，dsh 的 OKF topic 记忆插件（零 LLM 热路径注入 + 本地 git 可追溯 bundle；原名 dsh-llmwiki-memory）：

```sh
dsh plugin --profile tui add @aiwayds/dsh-topics-memory
```

**可选** —— [@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu) —— 用手机上的飞书/Lark 驱动同一个 dsh session（[演示](docs/features/feishu-demo.md)）。

---

## 键盘快捷键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送 prompt |
| `Esc` | **双击停止一切 LLM 工作**——第一击进入待发状态，第二击弹出确认框（列明正在运行的主 turn 与子代理数）；`Enter` 确认后停止主 turn **和**所有运行中的子代理，`Esc` 维持运行。仅有后台子代理在跑时同样有效。有 popup 打开时双击改为关闭它 |
| `Ctrl+C` | 任务中：第一次停止（同一"停止一切"，无确认框），第二次退出；空闲时：清空编辑器 / 退出。长按自动重复绝不会触发退出。 |
| `Ctrl+D` | 退出（仅在编辑器为空时） |
| `Ctrl+L` | 打开 model/think 选择器 |
| `Ctrl+G` | 打开 subagent 选择器（查看器内 `Enter` 打开 steer；子代理运行中 `x ×2` 停止它，已结束后 `x ×2` 关闭面板） |
| `Ctrl+O` | 待发消息队列（`s` 立即 steer · `d` 移除） |
| `Ctrl+Shift+F` | 全文搜索（`Enter`/`Ctrl+G` 下一个 · `Shift+Enter`/`Ctrl+Shift+G` 上一个 · `Esc` 关闭） |
| `↑` / `↓` | 浏览已提交消息历史 |

通过 `~/.dsh/keybindings.json`（部分 JSON 映射，实时应用）或 `/hotkeys` 交互式重映射任意 app 按键。

---

## 配置

所有配置都在 `~/.dsh/settings.yaml` 的 `dsh-tui` 命名空间下——但你很少需要直接碰文件：**`/settings` 就地浏览修改**（可搜索的一级分类——Agent Presets / General / Models / Plugins / TUI——实时值、逐字段描述，Models 下还有 add-provider 流程）。语言、主题、面板高度、footer 提示、图标集改动即热生效；其余下次启动读取。

大多数旋钮都有合理默认值，无需配置。真正可能会设的就几项：

```yaml
dsh-tui:
  language: zh-CN   # 界面语言——或直接 /language（任意 surface 可答；内置 en、zh-CN、ja、ko）
  theme: auto       # auto / light / dark / 任意已注册主题名——或 /theme
  maxAgents: 4      # 子代理并发上限，0 = 不限（/agents → l 也可热调）
```

新增界面语言就是往 `~/.dsh/locales/` 放一个 JSON 文件——同名 id 按键合并到内置文件之上，新 id 直接注册（详见[设置浏览器与界面语言](docs/features/settings-i18n.md)）。会话清理器（`retention` / `resume`）与 ask-user 超时（`askUser`）也在同一命名空间，默认值见文档。

插件内置了一个 skill（`dsh-tui-pi-config`）：直接让 agent「帮我配置 TUI」，它会问答式收集你的选择并代写配置段。**全键表与 `DSH_TUI_*` 环境变量清单见 [skills/dsh-tui-pi-config/SKILL.md](skills/dsh-tui-pi-config/SKILL.md)。**

---

## 开发

```sh
pnpm check    # tsc --noEmit
pnpm build    # 输出 lib/
pnpm test     # 单元测试，node --test 对 lib/ 执行（pretest 构建；当前基数见 AGENTS.md）
```

`pi-tui` 从 npm 原样运行——无补丁、无 fork。铁律与质量门禁见 [AGENTS.md](AGENTS.md)。

---

## 文档索引

- [docs/features/](docs/features/) —— 每个功能一篇独立文档，附演示视频（英文）。
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 完整设计：进程模型、分层、数据流。
- [CHANGELOG.md](CHANGELOG.md) —— 发布历史。
- [AGENTS.md](AGENTS.md) —— 贡献者的工作约定与质量门禁。
- [docs/](docs/) —— 设计笔记（steer/follow-up 流程、showcase 草稿……）。

---

## 兼容性说明

dsh 0.1.5-rc.2 时代保存、且 subagent 完成通知携带 reasoning 内容的会话，在 dsh 0.1.6 宿主下 `/resume` 恢复时首个模型请求会序列化失败（上游 B-21，宿主数据问题、非插件缺陷）。遇到此情况请改开新会话，不要在 0.1.6 下恢复该旧会话。

---

## 致谢

[Ask User Question](docs/features/ask-user-question.md) 交互的灵感来自 [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question)（改编自本 TUI 的停靠面板与 dsh `userQuestions` provider 架构；这里的全部代码均为原创）。
