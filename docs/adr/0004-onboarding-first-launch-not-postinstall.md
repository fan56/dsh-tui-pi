# 0004 — Onboarding runs at first launch, not at postinstall

本包不再携带任何 install 类生命周期钩子（`preinstall` / `install` /
`postinstall` 三键全无，`scripts/postinstall.mjs` 已删除）；装机 onboarding
整体迁移到 bin 首启：`bin/boot.mjs` 检测到机器缺件（dsh 宿主、pnpm、挂载的
`tui` profile 任一缺失）时调用 `bin/onboard-core.mjs` 的 `runOnboard` 完成
装机。这是唯一入口，不再有安装期兜底。

## Background and evidence

- **pnpm 11 `strictDepBuilds` 默认开**：依赖（含经 `dsh plugin add` 装进
  profile 的插件包）只要声明未放行的 install 类脚本，`pnpm add` 即非零退出
  （`ERR_PNPM_IGNORED_BUILDS`）。dsh 宿主的插件管理器把非零退出当作安装失败
  整体回滚——用户看到的就是"更新失败"，而包本身其实能用（issue#10:
  https://github.com/fan56/dsh-subagent-registry/issues/10）。
- **同日姊妹仓已按 postinstall→prepare 范式修完 8 仓**（registry 0.20.1 /
  llm-proxy 0.8.1 / feishu 0.17.1 / cron 0.7.1 / workflow 0.2.3 /
  mcp-adapter 0.8.1 / profile-switch 0.4.1 / vault 0.8.2）。tui-pi 走不了该
  范式：它的 postinstall 承载真实装机功能，挪进 `prepare` 只会把同一个门
  撞到 dev 安装上，问题原样存在。
- **迁移是行为等价的**：postinstall 与 bin 首启本来就共用 `runOnboard`——
  postinstall 的全部产出都可以在首启补齐，postinstall 只是让 `npm i -g`
  打印 "added 1 package" 的那一刻机器即已就绪的便利，不是功能前提。
- **两类用户的影响面**：pnpm 用户零变化——pnpm 从不设置
  `npm_config_global`，旧 postinstall 在 pnpm 下本就不跑，他们今天走的就
  是首启路径。npm `-g` 用户从安装期挪到首启：首启会下载 834MB 的 dsh 宿主
  （数分钟），失败时打三行人话提示并以 exit 1 退出（见
  `bin/onboard-core.mjs` 的 failure contract）。
- **兜底事实**：pnpm 11 的 `minimumReleaseAge=24h` 使新版本发布后 24 小时
  内的 fresh install 仍解析到旧版本——这个窗口我方无法加速；新版本一旦被
  解析到，strictDepBuilds 只看包自身的脚本声明，本包三键全无即直通。首启
  onboarding 内置的 `approvePrintedBuilds`（profile workspace 的 allowBuilds
  占位符补全）继续兜住 companion 侧的残余脚本面。

## Consequences

- **四 companion range 显式抬版**到钩子已清的修复版：`dsh-subagent-registry`
  `^0.19.1` → `^0.20.1`、`dsh-llm-proxy` `^0.8.0` → `^0.8.1`、
  `dsh-mcp-adapter` `^0.8.0` → `^0.8.1`、`dsh-profile-switch` `^0.4.0` →
  `^0.4.1`——profile 装机链上任何一个 companion 带未放行 install 脚本，
  `pnpm add` 照样撞门。
- **`test/packaged-upgrade.test.mjs` 断言反转**：已发布 2.38.0 基线仍带钩子
  （历史 fixture），本地打包产物断言零 install 钩子、无钩子脚本、bin 入口
  齐全、升级 exit 0 且无 unapproved-build 报告。`test/boot-onboard.test.mjs`
  新增 7 场景钉死首启契约（fake dsh/pnpm/npm + 隔离 DSH_HOME）。
- **e2e 80-onboard pass A 改驱动 `bin/boot.mjs` 首启**（pass B 不动）。
- **存量已装用户不受影响**：旧钩子只在安装新版本的那一刻撞门，已装好的
  机器上没有任何东西需要迁移。
- `scripts/link-dsh-closure.mjs` 保留：删掉 postinstall 后它不再是任何
  lifecycle hook，只经 dev 树的显式 scripts 调用（`link-closure` /
  `precheck` / `prebuild` 做 closure 软链重建）；发布 tarball 虽携带
  `scripts/`，但不引用它——dev 自用与发布物语义见该文件头注释。

## Considered options

- **跟随姊妹仓范式（postinstall → prepare）** — 拒绝：tui-pi 的 postinstall
  承载真实装机，挪进 `prepare` 等于把 strictDepBuilds 门从"用户装插件"挪到
  "用户装本包"，且 dev `pnpm install` 也被同一门拦住；问题不消失，只换位置。
- **保留 postinstall 并发布 allowBuilds 指引** — 拒绝：放行权在宿主/用户的
  pnpm 配置手里，`dsh plugin add` 链路上没有能替用户预放行本包的机制；
  issue#10 的回滚行为在未放行用户上原样复现。
- **剥钩子 + 首启 onboarding（本决策）** — 采用：与姊妹仓同日修复对齐
  （npm latest 全部零 install 钩子），行为等价由共用 `runOnboard` 与
  boot-onboard 测试钉死；代价只是 npm `-g` 用户的装机时刻后移到首启，
  失败路径有明确的人话契约。
