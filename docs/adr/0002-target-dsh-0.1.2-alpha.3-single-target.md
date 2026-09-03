# 0002 — dsh 宿主线全面转进 0.1.2-alpha.3，放弃 rc.2 兼容

> **Superseded (2026-09-03)**: the plugin targets the dsh 0.1.2-rc.1 rc/stable line; the alpha single-target decision is retired.

本插件自 1.2.x 起同时支持两条宿主线：rc（`0.1.1-rc.2`，npm `latest` tag）与
alpha（`0.1.2-alpha.1+`），以 ask-user 的 registerProvider 探测、preset root
的 rc 目录探测、metadata.yml 旧版回退等「双路径 + feature-detect」维持兼容。
2026-09-01 起放弃该模式（era 结束）：全仓只保留 alpha 路径，宿主 floor 提到
`>= 0.1.2-alpha.3`。

## 背景（alpha.1/2/3 变化面，审计结论）

对 0.1.2-alpha.1..3 的 breaking 面逐项核对过（读闭包 d.ts + 源码，不靠猜）：

- **dsh-settings**：删除模块级导出 `settingsNamespace` / `installSettingsSection`
  / `deepEqualJson`；namespace 改为类型级品牌校验（`SettingsNamespaceInput`）
  + 运行时 `parseSettingsNamespace`。先例：dsh-model-sync cb6c7ed、dsh-cron 2bb07b9。
- **dsh-session**：`TodoItem`/`'todo/write'` 事件声明挪到
  `@deepseek-ai/dsh-tool-todo`（由其 `declare module` 增补 SessionEventMap）；
  `JsonValue` 系挪到 `dsh-util-values`；`isTokenDelta` 从 dsh-llm 删除（本仓未用）。
- **dsh-user-questions**：`ctx.userQuestions.registerProvider` 单槽删除，
  回答端统一到 Agent-scoped `'user-questions/request'` cordis waterfall
  （alpha 起事件已进宿主 Events 类型声明）。
- **dsh-permission-presets**：`current()`/`set()` 参数从事件数组改为整个
  `Session`（knob 状态改走 session projection 折叠）。
- **dsh-system-prompt**：`PERSONA_ORDER` 等数值常量删除，新增
  `getSectionOrder(name)` / `getContextOrder(name)`，集中分配段位名。
- **dsh-agent-presets**：内置预设 id `code` → `ptc`（shipped roster 实测
  standard/minimal/cordis/ptc 四个），shipped root 收敛到包内 `presets/`，
  metadata 只有 `preset.yml`（`metadata.yml` 在 alpha.3 全闭包零引用）。
- **dsh-agent-loop**：static inject 新增 `sessionProjections`（testkit 未挂时
  e2e 需补挂 dsh-session-projection；本仓单测用 fake ctx，不触此缺口）。
- **SessionId()** 等品牌构造器由纯类型断言变为运行时校验（本仓全部构造点
  入参本来就是合法 lowercase id，无命中）。

审计同时确认：`registerProvider` 探测、preset rc 目录探测、metadata.yml 回退、
`presets.current(events)` 全部是**只能二选一**的宿主形状分支，不是可统一的
抽象点——双路径的实际成本是每个分支都要常年带测试与文档。

## 决策

1. **floor `>=0.1.2-alpha.3`**：peerDependencies 的 dsh-user-questions 从精确
   `0.1.1-rc.2` 升为 `>=0.1.2-alpha.3`（floor 语义，随宿主滚动）；devDependencies
   精确钉 `0.1.2-alpha.3` 保本地类型解析。
2. **删全部双路径**：ask-user 只留 `'user-questions/request'` waterfall
   （dsh-ask-router surface 路径与 rc/alpha 无关，保留）；preset root 探测只留
   dsh-agent-presets 包内布局；metadata 只读 `preset.yml`；英文映射删 `code`
   别名；`presets.current(agent.session)` 直传 Session。
3. **CI 滚动 `@alpha`**：ci.yml 与 release.yml 的宿主安装从 `latest`（仍指
   rc 线）改为运行时解析 `@deepseek-ai/dsh@alpha` dist-tag，不手钉；每日
   schedule 保留——alpha.4 起每日 CI 追新，宿主漂移一天内变红。
4. **npm 直接发 latest + README 标注**：本插件自身的发布 tag 不打 alpha
   dist-tag，直接占 `latest`；README 明示 `Requires dsh >= 0.1.2-alpha.3`。
   社区 stable（rc 线）用户升级插件的敞口被接受：rc 线用户停在旧插件大版本，
   README 的版本要求是合同边界。

## 后果

- **正面**：单宿主形状，ask-user 注册语义唯一（waterfall 组合），类型图单一
  closure，双路径测试负担清零；`getSectionOrder` 让段位跟随宿主重排。
- **代价一（接受）**：仍在 rc 线宿主上的用户升不到新插件版本——npm `latest`
  不再兼容 rc；README 标注为硬要求。
- **代价二（接受）**：会话日志不可无损降级——alpha 线引入的事件形状
  （todo/write 声明位移、PTC 改名、projection 状态）写入的日志在 rc 宿主上
  回放语义无保；跨宿主降级 resume 不承诺。
- **代价三（显式追踪）**：alpha 是滚动预发布线，`@alpha` dist-tag 的每一次
  推进都可能红 CI；floor 只升不降，alpha.4+ 的适配按每日 CI 的红绿节奏跟进。
- **顺序依赖**：本插件依赖 `@aiwayds/dsh-model-sync ^0.1.4`（bundle patch 代
  挂）；npm 上的 0.1.4–0.1.6 仍是 pre-alpha 形状，其适配版（model-sync 仓
  cb6c7ed）发布后 caret 自动选中；发布顺序上 model-sync 先行。smoke-boot
  在 scratch profile 中临时 `disabled: true` 该挂载点，适配版发布后可撤。

## Considered options

- **继续双路径到 rc EOL** — 拒绝：rc 线已停进（`latest` 冻结在 rc.2），
  双路径只剩成本没有用户增量；ask-user 的 provider 槽在 alpha 已物理删除，
  「双路径」实际是单向迁移期遗留。
- **floor 精确钉 `0.1.2-alpha.3`** — 拒绝：宿主是滚动预发布线，精确钉会让
  alpha.4 一发布就全线飘红；`>=` floor + 每日 CI 追新是这个节奏下唯一可
  持续的组合。
- **插件发布打 `alpha` dist-tag** — 拒绝：插件版本号自有节奏（1.x），宿主
  线信息放 README 版本要求，不与 npm dist-tag 语义纠缠。
