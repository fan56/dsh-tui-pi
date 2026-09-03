[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 pi 风格终端 UI——一套把 dsh 变成 pi 式编码代理体验的插件套件：pi-tui 的外观与交互、dsh 斜杠命令、GitHub 明/暗主题和 powerline 状态栏。

**要求 dsh >= 0.1.2-alpha.4** —— 本插件跟随滚动的 `@alpha` 宿主线（当前为 **0.1.2-alpha.5**）；不支持 0.1.1-rc 稳定线（见 [ADR 0002](docs/adr/0002-target-dsh-0.1.2-alpha.3-single-target.md)）。宿主低于下限时，启动守卫会打一行 warning 并干净退出（可用 `DSH_TUI_SKIP_HOST_CHECK=1` 跳过）。待 dsh 发布越过 alpha 期的正式稳定版后，支持策略将调整为只支持稳定版。

https://github.com/user-attachments/assets/6a7e00bb-1fd0-4bc5-9070-457f1e9fa54d

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
- [**Agent preset 切换**](docs/features/preset-switch.md) —— `Tab` / `/preset` 在内置 agent 组合（`standard`、`minimal`……）间切换；preset 到底管什么、切换何时生效。
- [**Sessions 会话与恢复**](docs/features/sessions-resume.md) —— 会话自动保持整洁、几次按键恢复；跨进程写者守卫保证日志单写者。
- [**Themes 主题**](docs/features/themes.md) —— GitHub 明/暗配色热切换；`auto` 跟随终端。
- [**搜索、选择与图片**](docs/features/search-selection-images.md) —— `Ctrl+Shift+F` 全文搜索、划选复制到系统剪贴板、web/飞书附件内联渲染、LaTeX 转 Unicode 数学。
- [**斜杠命令**](docs/features/slash-commands.md) —— `/model`、`/resume`、`/btw`、`/profile-switch`……外加全部 dsh 原生命令。
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

**推荐安装** —— [@aiwayds/dsh-llmwiki-memory](https://github.com/fan56/dsh-llmwiki-memory)，dsh 的 OKF topic 记忆插件（零 LLM 热路径注入 + 本地 git 可追溯 bundle）：

```sh
dsh plugin --profile tui add @aiwayds/dsh-llmwiki-memory
```

**可选** —— [@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu) —— 用手机上的飞书/Lark 驱动同一个 dsh session（[演示](docs/features/feishu-demo.md)）。

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
| `Ctrl+Shift+F` | 全文搜索（`Enter`/`Ctrl+G` 下一个 · `Shift+Enter`/`Ctrl+Shift+G` 上一个 · `Esc` 关闭） |
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

## 开发

```sh
pnpm check    # tsc --noEmit
pnpm build    # 输出 lib/
pnpm test     # 单元测试，node --test 对 lib/ 执行（pretest 构建；1100+ 测试、60+ 文件——当前基数见 HANDOFF.md）
```

`pi-tui` 从 npm 原样运行——无补丁、无 fork。铁律与质量门禁见 [AGENTS.md](AGENTS.md)。

---

## 文档索引

- [docs/features/](docs/features/) —— 每个功能一篇独立文档，附演示视频（英文）。
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 完整设计：进程模型、分层、数据流。
- [HANDOFF.md](HANDOFF.md) —— 会话历史与当前状态（中文）。
- [CHANGELOG.md](CHANGELOG.md) —— 发布历史。
- [AGENTS.md](AGENTS.md) —— 贡献者的工作约定与质量门禁。
- [docs/](docs/) —— 设计笔记（steer/follow-up 流程、showcase 草稿……）。

---

## 致谢

[Ask User Question](docs/features/ask-user-question.md) 交互的灵感来自 [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question)（改编自本 TUI 的停靠面板与 dsh `userQuestions` provider 架构；这里的全部代码均为原创）。
