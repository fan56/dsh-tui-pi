# dsh-tui-pi 容器 e2e（podman + Ubuntu 24.04）

用 podman 跑一套真实用户视角的端到端测试：在干净的 Ubuntu 24.04 容器里
安装 dsh 与本仓库构建出的插件 tarball，在 tmux（真 PTY）里启动
`dsh --profile tui`，通过 `tmux send-keys` 驱动、`capture-pane` 断言。
容器的 `~/.dsh` 是一次性的 —— **完全不触碰宿主机的 `~/.dsh` 线上配置**
（对比仓库 AGENTS.md「Config safety」对宿主 tmux e2e 的快照/还原要求）。

## 运行

```sh
./e2e/run-e2e.sh          # 前置：podman machine start
```

- 镜像构建：Ubuntu 24.04 + Node 22（nodejs.org 官方二进制）+ tmux +
  全局 `@deepseek-ai/dsh`（rolling `@alpha` dist-tag 解析，需钉版本做
  确定性复现时用 `--build-arg DSH_VERSION=<version>` 覆盖）+ 本源码树
  `pnpm build && pnpm pack` 出的 tarball（放在镜像 `/dist/`）。
- 场景执行：`e2e/` 以只读方式挂到容器 `/e2e`，因此改测试脚本不需要
  重建镜像；改 `src/` 或 `package.json` 才需要。
- 网络说明：基础镜像走 `docker.m.daocloud.io` 镜像源（本网络环境下
  registry-1.docker.io 被 DNS 污染）；容器内 npmjs.org 可直连，
  nodejs.org 的 CDN 同被污染——Node tarball 默认走 npmmirror 二进制
  镜像（`ARG NODE_DIST_BASE` 可切回官方源）。

## 场景清单（scenarios/）

| 场景 | 覆盖 |
|------|------|
| `10-install` | dsh CLI 就位；`dsh plugin --profile tui add <tarball>` 真实安装流；profile package.json 双键（bundle + loader）；`cordis.patch.yml` 注册 `tui-pi`；闭包契约：profile node_modules 里不得有 `@deepseek-ai` 物理副本（有则必须是软链——顶层 AGENTS.md 铁律 8）；插件自身的 npm 依赖（pi-tui + ask-router / dcp / llm-proxy / llm-stats / mcp-adapter / model-sync / subagent-registry / web-search-anysearch）从插件目录可解析 |
| `20-start` | tmux 内启动 TUI：像素鲸鱼 banner + DSH 像素字标（140 列）、随机语录、编辑器 cwd 边框、footer（provider/model 段、快捷键提示行、时钟）、`DSH_TUI_THEME=dark` 深色画布 SGR 落屏、编辑器可输入/可退格 |
| `22-search` | pi-tui 内建全屏 transcript 搜索（`Ctrl+Shift+F`，插件自身无搜索代码）：footer 提示段 `Ctrl+Shift+F: search`（默认开启）可见；快捷键打开右上角锚定的 `Find transcript` 输入 overlay，查询对 transcript 主 ScrollView 计数——荒诞查询报 `No matches`（负路径）、`plugins` 命中启动 banner 的 `mcp N · skills X/Y · plugins N` 计数行（正路径）；Esc 关闭；重开为全新空查询（无陈旧计数残留）；收尾清编辑器交给下个场景 |
| `30-commands` | `/` 自动补全弹出 + 前缀过滤（set/th/hot）+ Esc 关闭；`/think`（effort 选择器）、`/settings`、`/hotkeys`、`/permission` 各 overlay 打开（用 overlay 独有文案断言）、Esc 关闭、编辑器焦点恢复；`/resume` 无历史会话的错误路径；`/model` 对内置 provider 的 picker（只开取消，不选中） |
| `40-theme` | `/theme` 选择器三行（auto/light/dark）；切 light → 画布 SGR `48;2;252;253;252`、切回 dark → `48;2;13;17;23`；选择通知文案；偏好写入容器内 `settings.yaml`；**重启后偏好持久**（无 env 时以持久化值为准） |
| `50-resize-exit` | 80×24：TUI 存活、鲸鱼仍渲染（transcript 视口可能裁掉顶部行）、**字标按设计降级消失**；24 行下 overlay 适配；还原 140 列字标恢复；`Ctrl+C ×2` 干净退出（150–500ms 双击窗口）+ 回退 `Ctrl+D`；退出后 shell 提示符 + `pane_current_command=bash` + exit dump 渲染；退出后再完整启动一次 |
| `60-preset` | agent preset 切换（Tab + `/preset`，有/无 presets 双路径）：有 presets 时——Tab 循环切换、footer brand 段随之显示 `dsh(<name>)`（单 preset 时 no-op 记 warn），二次 Tab 继续循环；`/preset` 打开 `● Agent preset` picker overlay（Esc 关闭）、`/preset next` 等价 Tab 循环；无 presets 时验证优雅降级——footer 保持裸 `dsh`、`/preset` 报 `No agent presets available`；preset 操作后编辑器仍可用 |
| `65-ux-batch` | 0.21 批次：`/login` → **Custom provider…** 六字段链式表单（步骤推进/内联报错/提交后 settings.yaml 落 hand-declared profile + 派生 key ref、密钥不进 settings.yaml；Esc 放弃整个流程）；启动播种的 `APPEND_SYSTEM.md` 含 registered-subagents 铁律 |
| `66-retention-resume` | fixtures 全部为 zstd-frame 容器（两帧：header + 事件批次），由 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `encodeMaterialization` 经 `Object.create(JsonlSessionPersistence.prototype)` 剥离实例真实产出，落盘为 `session.jsonl.zstd`——`persistence.list()` 的 `parseHeaderMeta` 直接读首帧；填充行轮询四个真实事件类型（`permission/preset` / `sandbox/mode` / `approval/policy` / `turn/start`，皆 `KNOWN_SESSION_EVENT_TYPES` 成员），随机 hex `pad` 撑大 zstd，按 on-disk 字节数判定循环终止；retention janitor：`MAX_AGE_DAYS=2` 清理超龄目录（fresh/flat file/empty dir 留存）、`MAX_COUNT=0` 显式关闭；`/resume` 展示过滤：默认 minBytes 地板过滤小 stub、大 session 展示 preview 文本与 `Updated` / `Dir` 列头；`minBytes=999999999` 触发 empty-filtered 提示（含 `adjust dsh-tui.resume.*` 指引，不退化为 plain empty-store 文案）；启动横幅下 `mcp N · skills X/Y · plugins N` 计数行 + profile root 行 `tui` |
| `68-ask-user` | **仅容器内**（host-guarded，宿主机自跳过：`/model` 会把 mock-chat 持久化为默认模型、`/login` 会把 mock 路由写进 settings.yaml，误跑污染真实 `~/.dsh`）：v0.23.0 ask-user 一次一问 UI（40a03df）：容器内起本地 OpenAI 兼容 mock（`lib/mock-llm.mjs`，纯 node stdlib，SSE 流式 `chat.completion.chunk`），`/login` Custom provider 表单声明 `mock-llm` 路由 + `/model` 过滤选中 `mock-chat`，trigger 提示词让 agent 真实走完 用户消息 → LLM → `ask_user_question` 工具调用 → docked 面板 全链路（mock 按请求体内容分相：首次带 `E2E_ASK_TRIGGER` 回 tool call，工具结果回来后回固定收尾文本）。断言：同一时刻只渲染当前一题（`(1/3)` 标题 + `[1] · 2 · 3` tab strip，后题 header 不可见）；单选作答自动前进（`(2/3)`、`1✓`、前题不再活动）；←/→ 切 tab；Ctrl+T 折叠成 3 行 strip（`(2/3 · 1 answered)` + `Ctrl+T expand`，题行/表格 chrome 全隐），折叠态导航/作答键惰性，再按展开；multiSelect tab 永不自动前进（`● 1. lint` 选中标记）；Confirm 行 → review 页（三题答案 + `✓ ready`）→ 提交后面板关闭、工具结果回流、mock 收尾文本 `E2E-ASK-FLOW-COMPLETE` 上屏 |
| `70-steer-injection` | **仅宿主机**（需真实 API key，容器内自跳过）：真实派一个 subagent 跑 sleep 循环任务，Ctrl+G → viewer footer `Enter steer` → Enter 弹多行输入框 → 发送后 `Steer message sent` notice 且注入消息出现在 child transcript；负路径：Esc 取消零投递、settled child 显示 ended notice 且不开输入框。宿主机运行时按 AGENTS.md「Config safety」对 `~/.dsh/settings.yaml` / `.credentials.yaml` 做字节级快照 + cmp 还原 |

## 实测发现（写断言时踩过的坑）

- **退出残留是设计行为**：dsh-tui 退出 alt-screen 时把 transcript 尾部 +
  footer 行打印到 shell 屏（exit dump），所以退出断言不能依赖「footer 文案
  消失」，要用 shell 提示符 + `#{pane_current_command}` 为准。
- **grep 的多字节区间量词不可用**：`█{15,}` 在 C / C.UTF-8 locale 下都匹配
  不到（量词只作用于最后一个字节），字标检测必须用 15 个 `█` 的固定字符串。
- **Ctrl+C ×2 有精确窗口**（src/keymap.ts）：第二下必须落在第一下之后
  150–500ms——过近被判为按住自动重复（忽略），过远超出 500ms 双击窗口。
  空编辑器上 `Ctrl+D` 是无窗口的单键退出（quit 的回退路径）。
- **`DSH_TUI_THEME` 会钉死显示**：env 存在时 `/theme` 选新偏好只保存并提示
  "display is pinned by DSH_TUI_THEME=…"，画布不变——这是正确行为，但主题
  切换审查必须在无 env 的 TUI 上做。
- **裸 `/` 的自动补全弹窗只显示命令列表的前几行**（`usage` 这类
  排在后面的命令不可见）；`⌘ /cmd` 的 transcript 回显会永久留在屏幕上，
  overlay 断言必须用 overlay 独有文案（`● Theme`、`⚙ hotkeys`、
  `GitHub light palette` 等），不能用命令名。
- **无凭证也有内置 provider**：fresh profile 下 footer 就显示
  `deepseek-official / deepseek-v4-flash`，`/model` 能列出模型——但没有
  API key，发送消息的真实链路不在本套件覆盖内。

- **seeded 的 user/message 必须过 `inspect()` 的 seed 边界校验**：`persistence.list()`
  只读首帧 header（不校验事件），而 `/resume` 行的 preview 走
  `persistence.inspect()` → `Session.fromRestore` 重放，两个缺口都会在那里炸、
  被 `loadSessionPreviews` 吞掉后行回退成 `app · <短id>` 标签：
  ① user/message 是 surface-eligible 类型，信封必须带 `surfaceOp: "append"`
  （否则 "session event \"user/message\" is surface-eligible and requires a
  surfaceOp marker"）；② 其 data 本身就是 identified message，必须有非空字符串
  `id`（否则 "session event at seq 0 lacks an identified message"）。

## 当前不覆盖（需要 API key / 人工）

- 真实 provider 的消息收发与流式渲染、think/tool 面板的有内容行为
  （`68-ask-user` 用本地 mock LLM 覆盖了「用户消息 → LLM → 工具调用 →
  面板 → 工具结果 → 收尾回复」的完整链路，但不是真实模型/网关）
- `/login` → 添加 provider → `/model` 选中切换全链路的**真实 key 版本**
  （`68-ask-user` 已覆盖 mock key 版本）
- npm 已发布包的安装（`@aiwayds/dsh-tui-pi@latest`）——本套件固定测
  本源码树构建产物；要测发布包可 `podman run` 后手动 `dsh plugin add`

## 调试

```sh
podman build -f e2e/Containerfile -t dsh-tui-pi-e2e .
podman run --rm -it -v "$PWD/e2e:/e2e:ro" dsh-tui-pi-e2e bash
# 容器内手工复现：
tmux new-session -d -s tui -x 140 -y 36
tmux send-keys -t tui 'dsh --profile tui' Enter
sleep 5 && tmux capture-pane -t tui -p
```
