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
  全局 `@deepseek-ai/dsh` + 本源码树 `pnpm build && pnpm pack` 出的
  tarball（放在镜像 `/dist/`）。
- 场景执行：`e2e/` 以只读方式挂到容器 `/e2e`，因此改测试脚本不需要
  重建镜像；改 `src/` 或 `package.json` 才需要。
- 网络说明：基础镜像走 `docker.m.daocloud.io` 镜像源（本网络环境下
  registry-1.docker.io 被 DNS 污染）；容器内 npmjs.org / nodejs.org
  均直连可达，不需要镜像源。

## 场景清单（scenarios/）

| 场景 | 覆盖 |
|------|------|
| `10-install` | dsh CLI 就位；`dsh plugin --profile tui add <tarball>` 真实安装流；profile package.json 双键（bundle + loader）；`cordis.patch.yml` 注册 `tui-pi`；闭包契约：profile node_modules 里不得有 `@deepseek-ai` 物理副本（有则必须是软链——顶层 AGENTS.md 铁律 8）；插件自身的 npm 依赖（pi-tui / dcp / subagent-registry）从插件目录可解析 |
| `20-start` | tmux 内启动 TUI：像素鲸鱼 banner + DSH 像素字标（140 列）、随机语录、编辑器 cwd 边框、footer（provider/model 段、快捷键提示行、时钟）、`DSH_TUI_THEME=dark` 深色画布 SGR 落屏、编辑器可输入/可退格 |
| `30-commands` | `/` 自动补全弹出 + 前缀过滤（set/th/hot）+ Esc 关闭；`/think`（effort 选择器）、`/settings`、`/hotkeys`、`/permission` 各 overlay 打开（用 overlay 独有文案断言）、Esc 关闭、编辑器焦点恢复；`/resume` 无历史会话的错误路径；`/model` 对内置 provider 的 picker（只开取消，不选中） |
| `40-theme` | `/theme` 选择器三行（auto/light/dark）；切 light → 画布 SGR `48;2;252;253;252`、切回 dark → `48;2;13;17;23`；选择通知文案；偏好写入容器内 `settings.yaml`；**重启后偏好持久**（无 env 时以持久化值为准） |
| `50-resize-exit` | 80×24：TUI 存活、鲸鱼仍渲染（transcript 视口可能裁掉顶部行）、**字标按设计降级消失**；24 行下 overlay 适配；还原 140 列字标恢复；`Ctrl+C ×2` 干净退出（150–500ms 双击窗口）+ 回退 `Ctrl+D`；退出后 shell 提示符 + `pane_current_command=bash` + exit dump 渲染；退出后再完整启动一次 |
| `65-ux-batch` | 0.21 批次：`/login` → **Custom provider…** 六字段链式表单（步骤推进/内联报错/提交后 settings.yaml 落 hand-declared profile + 派生 key ref、密钥不进 settings.yaml；Esc 放弃整个流程）；启动播种的 `APPEND_SYSTEM.md` 含 registered-subagents 铁律 |
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
- **裸 `/` 的自动补全弹窗只显示命令列表的前几行**（`models-sync` 这类
  排在后面的命令不可见）；`⌘ /cmd` 的 transcript 回显会永久留在屏幕上，
  overlay 断言必须用 overlay 独有文案（`● Theme`、`⚙ hotkeys`、
  `GitHub light palette` 等），不能用命令名。
- **无凭证也有内置 provider**：fresh profile 下 footer 就显示
  `deepseek-official / deepseek-v4-flash`，`/model` 能列出模型——但没有
  API key，发送消息的真实链路不在本套件覆盖内。

## 当前不覆盖（需要 API key / 人工）

- 真实消息收发与流式渲染、think/tool 面板的有内容行为
- `/login` → 添加 provider → `/model` 选中切换全链路（需真实 key）
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
