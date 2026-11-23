# issue #5 — notice 链路现场摸底（只读调研）

调研时间：2026-11-23。仓库：`/Users/qingguee/repo/dsh-tui-pi`，分支 `main`，工作树干净。
本文只记录代码事实与证据，不含方案决策。

## 0. 摘要（事实）

1. 本仓只有一条 transient notice 链路：`emitNotice()` → `noticeSink` → `ui.showNotice(text)` → footer 上方 `notices` 容器。
2. 本仓 **没有** 任何把 `console.error` / `console.warn` / `process.stderr.write` / 子进程 stderr 转成 `emitNotice()` 的代码。全仓 `emitNotice` 调用点均为插件自身的显式诊断文案（见 §1.3）。
3. 宿主进程由 launcher 用 `spawnSync(..., { stdio: 'inherit' })` 启动，stderr 直通父进程终端，**没有管道捕获、没有 notice 路由**（见 §1.1）。
4. core 的成功 listing 行由 `dsh-llm-deepseek` 的 `listing-cache.ts` 生成，经 `host.ts` 的 `info` 回调用 `console.error(tag, message)` 写到 stderr；`tag` 由 owner 名生成。产生 `[llm-deepseek-account]` 这一 tag 的是 **`dsh-llm-deepseek-account`** 包（它调用前者的 `createModelListingCache` 并传 `name = 'llm-deepseek-account'`）。成功行与失败行文本可区分，行文本本身 **不含级别词**（见 §2）。
5. notice-bridge 无去重、无合并、无过滤、无行解析；仅 FIFO 有界队列（16）、一次性排空（见 §3）。
6. `ui.showNotice(text)` 签名只有字符串，无级别参数；样式固定为 `fgMuted`，8 秒自动消失，最多 8 行（见 §1.4）。
7. 已有 `test/notice-bridge.test.mjs`（8 个用例）；单测 `node --test test/*.test.mjs`（pretest 会 build）；e2e 入口 `e2e/run-e2e.sh`（见 §5）。
8. `lib/` 被 `.gitignore` 忽略（`lib/notice-bridge.js` 是 build 产物）；`git log -- lib/notice-bridge.js` 为空，源文件 `src/notice-bridge.ts` 只有一次提交 `b40d002`（见 §6）。

## 1. 现状链路图（文件:行号）

### 1.1 宿主进程启动与 stderr 管道

```
bin/dsh-tui-pi:10            exec node "$SCRIPT_DIR/boot.mjs" "$@"
bin/boot.mjs:49              const dsh = dshBinPath()
bin/boot.mjs:44-46           function boot(dsh) {
                               const result = spawnSync(dsh, ['--profile', 'tui', ...args], { stdio: 'inherit' })
                               process.exit(result.status ?? 1)
                             }
bin/boot.mjs:59 / :74        boot(dsh)   // 快路径 / onboard 后
```

- `stdio: 'inherit'`：宿主 `dsh` 的 stderr **不经过任何本仓管道**，直接继承到 launcher 进程的 stderr，最终落到终端。
- 插件与宿主同进程（in-process）：`src/notice-bridge.ts:4-6` 明确写明「The plugin runs IN-PROCESS with the TUI」。
- 全仓 `emitNotice` 调用点（src，9 处）见 §1.3；没有任何一处由 stderr 行触发。
- 检索证据（`grep` 于 `src/`、`lib/`、`bin/`、`scripts/`）：无 `console.error =`、`console.warn =`、`process.stderr.write =`、`stderr.on('data')` 之类拦截/改写。唯一直接写 stderr 的本仓代码是 `src/preflight-projcache.ts:44` 与 `src/projcache.ts:28`（`[preflight-projcache]` 前缀，boot 阶段的独立告警，不走 notice 通道）。

### 1.2 notice 通道接线（sink 生命周期）

```
src/notice-bridge.ts:36             export type NoticeSink = (message: string) => void
src/notice-bridge.ts:44             const MAX_PENDING_NOTICES = 16
src/notice-bridge.ts:62-74          setNoticeSink(sink)
src/notice-bridge.ts:81-88          emitNotice(text)
src/notice-bridge.ts:95-99          takePendingNotices()
src/notice-bridge.ts:105-108        resetNoticeBridge()

src/index.ts:94                     import { setNoticeSink } from './notice-bridge.ts'
src/index.ts:113                    import { emitNotice } from './notice-bridge.ts'
src/index.ts:793-802                // 注释：把 operator trace 以 stacked transient notices 呈现在 footer 上方，
                                    // 而不是 raw stderr 行（raw 会涂改 alt-screen frame）
src/index.ts:802                    setNoticeSink(message => ui.showNotice(message))
src/index.ts:2540 / :2573           setNoticeSink(undefined)   // 两处 teardown 清空 sink
lib/index.js:52 / :722 / :2420 / :2456   编译产物对应位置
```

- `setNoticeSink` 调用点共 3 处：1 处注册（`src/index.ts:802`），2 处清空（`src/index.ts:2540`、`:2573`，分别位于正常退出与 `/reload` teardown）。
- 注册时 `pendingNotices` 按发出顺序逐条排空；见 `src/notice-bridge.ts:62-74`。

### 1.3 `emitNotice` 的全部生产者（src）

| 文件:行号 | 文案来源 |
|---|---|
| `src/index.ts:407` | `initI18n(... warn: message => emitNotice(message))` |
| `src/index.ts:936` | `t('tui.takeover.writeLock')` |
| `src/index.ts:953` | `t('tui.idleRelease.reattached')` |
| `src/index.ts:2477` | `t('tui.steer.queuedFollowup')` |
| `src/retention.ts:151`、`:472` | retention/resume 设置告警与 janitor 结果行 |
| `src/ask-user.ts:667`、`:1524`、`:1543`、`:1992` | ask-user 设置/超时/服务缺失告警 |
| `src/sessions.ts:522` | 会话相关告警 |

这些调用点传入的是插件自己构造的文案，没有任何一处解析或透传外部 stderr 行。

### 1.4 `ui.showNotice` 签名与展示行为

```
src/tui.ts:80-93        TuiHandle.showNotice(text: string): void   // 接口声明
src/tui.ts:14-17        // 布局注释：noticesContainer = "transient notice slot"，位于 footer 之上
src/tui.ts:339-340      dock.addChild(notices, ...); dock.addChild(footer, ...)
src/tui.ts:346-366      // 设计注释：timer-only 退休，不是 "next keypress"；行 STACK，不替换
src/tui.ts:367          const NOTICE_AUTO_DISMISS_MS = 8000
src/tui.ts:368          const NOTICE_MAX_LINES = 8
src/tui.ts:369-379      type ShellNotice + retireNotice()
src/tui.ts:390-410      showNotice(text) 实现
lib/tui.js:250-251 / :274-286   编译产物对应位置
```

- 签名：`(text: string) => void`，**没有级别/severity 参数**。
- 展示：`new Text(ansiFg(themeRef.palette.fgMuted) + clipped + RESET, 1, 0)`（`src/tui.ts:400`）——所有 notice 统一 `fgMuted` 样式，无按级别分支。
- 时长：`setTimeout(() => retireNotice(notice), 8000)`（`src/tui.ts:401`），并 `unref()`（`:404`）。
- 容量：超过 8 行时先删最老一行（`src/tui.ts:391-395`）；每行独立退休。
- 裁剪：`clipToWidth(text, Math.max(20, columns - 2))`（`src/tui.ts:398`）。
- 另一个独立的 notice 面：`src/messages.ts:463` `renderNotice(text: string, level: 'error' | 'info' | 'warning' = 'error')`，是持久 transcript 行（调用点如 `src/index.ts:764`、`:779`、`:790`），与 transient footer notice 不是同一通道。

## 2. core 输出格式实锤（本机已装包）

### 2.1 两个包的职责区分

| 包 | 关键文件 | 角色 |
|---|---|---|
| `@deepseek-ai/dsh-llm-deepseek` | `node_modules/@deepseek-ai/dsh-llm-deepseek/src/listing-cache.ts`、`src/host.ts`、`src/listing-config.ts` | 提供 `ModelListingCache` 与 `createModelListingCache()`；生成 listing 成功/失败文本，并把 `info`/`warn` 接到 console |
| `@deepseek-ai/dsh-llm-deepseek-account` | `node_modules/@deepseek-ai/dsh-llm-deepseek-account/src/index.ts`、`src/config.ts` | `name = 'llm-deepseek-account'`（:15）、`LOG_TAG = '[llm-deepseek-account]'`（:22）；在 :51 调用 `createModelListingCache(ctx, name, PROVIDER, ...)`，故 owner/tag 为 `llm-deepseek-account` |

- 成功/失败 listing 文本 **只存在于 `dsh-llm-deepseek`**（grep `model listing from` 命中 `src/listing-cache.ts` 与 `lib/index.js`；`dsh-llm-deepseek-account` 内无此文本）。
- tag `[llm-deepseek-account]` 来自 `createModelListingCache` 的 `owner` 参数：`dsh-llm-deepseek/src/host.ts:25` `const tag = \`[${owner}]\``。
- 输出通道：`dsh-llm-deepseek/src/host.ts:30` `info: (message) => { console.error(tag, message) }`；`:31` `warn: (message) => { console.warn(tag, message) }`。Node 中 `console.warn` 与 `console.error` 都写入 stderr。
- `dsh-llm-deepseek-account/src/index.ts:69` 另有 `console.warn(LOG_TAG, problem)`，是 catalog override 问题行，与 listing 成功行不同源。

### 2.2 成功行（issue 描述的那条）

- 模板：`dsh-llm-deepseek/src/listing-cache.ts:138`
  ``this.dependencies.info(`model listing from ${settings.url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`)``
- 编译产物：`dsh-llm-deepseek/lib/index.js:2668`（同文本）。
- `settings.url`：`dsh-llm-deepseek-account/src/config.ts:94` `catalog: { url: modelListingURL(protocol.baseURL), ...timing }`；`modelListingURL` 定义于 `dsh-llm-deepseek/src/listing.ts:24-26`（`new URL('/models', new URL(baseURL).origin).href`）；默认 baseURL `https://api.deepseek.com/anthropic`（`dsh-llm-deepseek/src/config.ts:116`），故 URL 为 `https://api.deepseek.com/models`。
- 落到 stderr 的实际形态（tag + 空格 + 模板渲染结果）：
  `[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)`
- 定时：`dsh-llm-deepseek/src/listing-config.ts:12` `DEFAULT_MODELS_MAX_AGE_MS = 600_000`（10 分钟）；`:8` `DEFAULT_MODELS_TIMEOUT_MS = 5_000`。`listing-cache.ts:178-186` 的 `schedule()` 用 `setTimeout(..., min(MAX_TIMER_DELAY_MS, max(1, maxAgeMs - age)))` 自动刷新，`unref()`。

### 2.3 失败行（同 tag、不同文本）

| 场景 | 模板（文件:行号） | 输出函数 |
|---|---|---|
| 首次失败（streak 第一条） | `dsh-llm-deepseek/src/listing-cache.ts:144` ``model listing from ${settings.url} failed (${String(error)}); ${fallback}``；`fallback` 为 `using the bundled catalog` 或 `keeping the previous catalog`（`:143`） | `dependencies.warn` → `console.warn(tag, message)` |
| 刷新失败 | `dsh-llm-deepseek/src/listing-cache.ts:195` ``model listing refresh failed (${String(error)}); keeping the previous catalog; check listing configuration and credentials`` | 同上 |
| 变更通知失败 | `dsh-llm-deepseek/src/listing-cache.ts:162` ``model listing change notification failed (${String(error)}); reload the model catalog`` | 同上 |

编译产物对应行：`dsh-llm-deepseek/lib/index.js:2674`、`:2723`、`:2692`。

### 2.4 文本能否区分成功/失败（事实）

- 成功行含 `loaded N model(s), skipped N row(s)`；失败行含 `failed (...)` / `refresh failed` / `change notification failed`。
- 行文本中 **没有** `info`/`warn`/`error` 等级词；`info`/`warn` 只是 `ListingCacheDependencies` 的两个回调名（`listing-cache.ts:20`、`:22`）。
- 成功与失败走不同 console 方法（`console.error` vs `console.warn`，`host.ts:30-31`），但两者都写 stderr；到达客户端时只剩文本差异。
- 同一 tag 同时用于成功与失败（都由 `owner` 生成），因此 tag 前缀本身不能区分级别。

## 3. notice-bridge 完整现状

`src/notice-bridge.ts` 与编译产物 `lib/notice-bridge.js` 一一对应。

| 行为 | 事实 | 证据 |
|---|---|---|
| 队列上限 | `MAX_PENDING_NOTICES = 16`；超出时 `shift()` 丢最老 | `src/notice-bridge.ts:44`、`:87`；`lib/notice-bridge.js:40`、`:84-85` |
| 有 sink | 直接 `noticeSink(text)` 调用一次 | `src/notice-bridge.ts:82-85`；`lib/:79-82` |
| 无 sink | push 到 `pendingNotices`，不写终端、不设定时器 | `src/notice-bridge.ts:86-87`；`lib/:83-85` |
| 注册排空 | 先把 batch 摘出队列再逐条调用；每次重读 `noticeSink`；未投递剩余放回队首 | `src/notice-bridge.ts:62-74`；`lib/:56-72` |
| 清空 | `setNoticeSink(undefined)` 不投递，后续消息重新排队 | `src/notice-bridge.ts:63-64`；`lib/:57-59` |
| 测试缝 | `takePendingNotices()`、`resetNoticeBridge()` | `src/notice-bridge.ts:95-99`、`:105-108` |
| 去重 | 无 | 全文件仅 `push`/`shift`/`concat`，无 Set/Map/比较 |
| 合并/降频 | 无 | 无 timer、无计数、无相同文本判断 |
| 过滤 | 无 | `emitNotice(text)` 原样下发 |
| 行格式解析 | 无 | 参数类型是裸 `string`（`src/notice-bridge.ts:36`、`:81`），无 tag/级别拆分 |

## 4. 配置挂载点候选（代码事实，不含选型）

### 4.1 插件 settings（静态 Config）

- `src/theme-settings.ts:201` `export const Config = z.object({...})`：插件的 schemastery 配置 schema；已含 `language`、`theme`、`panelHeight`、`maxAgents`、`cacheHitMode`、`footerHints`、`retention`、`resume`、`askUser` 等键。
- `src/index.ts:73` `export { Config } from './theme-settings.ts'`，附注释（`:70-72`）说明 loader 读 `plugin.Config`。
- `src/index.ts:198` `SKILL_DESCRIPTION` 列出 `dsh-tui` 入口当前 18 个键；任何新增键需同步此描述。
- `src/theme-settings.ts:356` `DEFAULT_TUI_SETTINGS = Config({})`；`:368-374` `bindTuiConfig()` / `tuiConfig()`；`src/index.ts:256-260` 在 `apply()` 中 `bindTuiConfig(config)`。
- 新增配置键的自然落点：`src/theme-settings.ts` 的 `Config` + 一个 `readXxx()` reader；i18n 描述键在 `locale/`、`locales/`（如 `t('settings.theme.description')`，`src/theme-settings.ts:210`）。

### 4.2 settings > env > default 三层读取范式（已有实现）

- `src/retention.ts:160-205` `resolveRetentionConfig(env, settings?)`：先 `explicitSetting(settings, key, predicate)`，再 `finiteEnv(env.DSH_TUI_RETENTION_*)`，最后默认常量；注释（`:160-189`）明确「settings 优先于 env，env 优先于默认」。
- 相同范式还用于 resume / ask-user（`src/theme-settings.ts:198` 注释）。
- 现有 env 键（`grep`）：`DSH_HOME`（`src/append-system.ts:69-70`）、`DSH_TUI_THEME`、`DSH_TUI_TRANSPARENT`（`src/tui.ts:203-206`）、`DSH_TUI_MOUSE`（`src/mouse-mode.ts:19`）、`DSH_TUI_COPY_ON_SELECT`（`src/clipboard.ts:276`）、`DSH_TUI_RETENTION_*`（`src/retention.ts:198-200`）、`DSH_TUI_IDLE_RELEASE_SEC`（`src/session.ts:1173`）、`DSH_TUI_BTW_CONTEXT_MESSAGES`（`src/btw.ts:95`）、`DSH_TUI_SKIP_HOST_CHECK`（`src/index.ts:268`）。

### 4.3 bin 层 env（Config 之前）

- `bin/boot.mjs:35-42` `companionLatestEnabled()`：在 TUI Config 存在之前，用 `process.env.DSH_TUI_COMPANION_LATEST` 做单一 kill switch（非 `0/false/off` 即启用）。

### 4.4 其他用户级文件（与本仓配置机制同类，供参照）

- `$DSH_HOME/keybindings.json`（`src/hotkeys.ts:114`、`src/index.ts:472-473`）、`$DSH_HOME/model-profiles.json`（`src/model-profiles.ts:79`）、`$DSH_HOME/tui-widgets/*.lines`（`src/live-widgets.ts:587-589`）。

## 5. 测试挂载点（代码事实）

### 5.1 单测

- `package.json` scripts：`"pretest": "npm run build"`，`"test": "node --test test/*.test.mjs"`，`"build": "tsc -p tsconfig.json"`。`prebuild`/`precheck` 均调 `node scripts/link-dsh-closure.mjs`。**没有 bun test**。
- 现有 `test/notice-bridge.test.mjs`：8 个用例（`:32`、`:60`、`:75`、`:85`、`:101`、`:116`、`:132`、`:142`），覆盖 pending 顺序、排空 at-most-once、直投、清空重排队、抛异常 sink、自注销 sink、16 上限、reset。文件头注释（`:1-10`）明确「Runs against the built lib/ (pretest)」。
- 其他把 notice bridge 当 sink 用的测试：`test/retention.test.mjs`（`:360`、`:801-847`）、`test/sessions.test.mjs`（`:497`、`:540`）、`test/ask-user.test.mjs`（`:1256`）、`test/ask-user-timeout.test.mjs`（`:150`、`:184`）、`test/theme-settings.test.mjs`（`:625`）。
- 没有专门测 `tui.ts` `showNotice()` 展示行为（8s/8 行/fgMuted）的测试文件。

### 5.2 e2e

- 入口：`e2e/run-e2e.sh`（宿主侧构建 podman 镜像并跑全套）；容器内 `e2e/scenarios/run-all.sh`（`E2E_SCENARIOS` 默认列出 19 个场景）；场景说明见 `e2e/README.md`。
- 机制：`dsh --profile tui` 在 tmux PTY 中运行，用 `tmux send-keys` 驱动、`capture-pane` 断言；容器 `~/.dsh` 隔离。
- 与 stderr/notice 相关的现成场景：`e2e/scenarios/66-retention-resume.sh`（b40d002 曾改它，对应 notice 链路）；`e2e/scenarios/20-start.sh`（启动帧/footer）。
- 轻量 smoke：`scripts/smoke-boot.mjs`（`node scripts/smoke-boot.mjs` via `package.json` `"smoke"`），用 `spawnSync('dsh', ...)` 收集 stdout/stderr 做断言（`:106-112`、`:138-145`）。

## 6. git 改动史

```
$ git log --oneline -10 -- lib/notice-bridge.js
（空）

$ git log --oneline -10 -- src/notice-bridge.ts
b40d002 fix(tui): route operator traces through footer notices instead of raw stderr

$ git check-ignore -v lib/notice-bridge.js
.gitignore:3:/lib/    lib/notice-bridge.js
```

- `lib/` 是 gitignore 的 build 产物；`git ls-files` 只跟踪 `src/notice-bridge.ts`。
- `b40d002` 是 `src/notice-bridge.ts` 的唯一一次提交；该提交同时新增 `test/notice-bridge.test.mjs`（151 行）、改 `src/tui.ts`（+79，引入 showNotice）、`src/index.ts`（+26）、`src/retention.ts`、`src/ask-user.ts`、`src/sessions.ts`、`src/theme-settings.ts`、`e2e/scenarios/66-retention-resume.sh`、`AGENTS.md`、`CHANGELOG.md`、`README.md`。提交标题表明该次改动目标是把 operator trace 从 raw stderr 改走 footer notices。

## 7. 修复插入点候选（位置与侵入面事实，不含选型）

| 候选 | 改什么文件 / 函数 | 现状依赖 | 侵入面 |
|---|---|---|---|
| A | `src/notice-bridge.ts:81` `emitNotice(text)`（编译产物 `lib/notice-bridge.js:78`） | 唯一入口；9 个 producer + `test/notice-bridge.test.mjs` 与 5 个使用 sink 的测试文件都经此路径 | 小到中：单函数改造 + build；需回归全部 producer 测试 |
| B | `src/index.ts:802` `setNoticeSink(message => ui.showNotice(message))`（编译产物 `lib/index.js:722`） | 一行 lambda；sink 注册/清空点共 3 处（`:802`、`:2540`、`:2573`） | 小：改一处接线；但过滤读配置需另接 config reader |
| C | `src/tui.ts:91` `TuiHandle.showNotice` 签名 + `:390-410` 实现（编译产物 `lib/tui.js:250-251`、`:274-286`） | 签名只有 `text: string`；样式固定 `fgMuted`、8s、8 行；无现成分级测试 | 中：改接口+实现+可能补测试；`src/subagent-viewer.ts:549/738` 的 `showNotice` 是另一个同名方法，不共享该接口 |
| D | `src/theme-settings.ts:201` `Config` + reader（参照 `src/retention.ts:187-205`）；`src/index.ts:73` 导出、`src/index.ts:198` `SKILL_DESCRIPTION` | 配置入口 `dsh-tui`；i18n 描述需加 locale 键 | 中：schema + reader + i18n + 文档描述 |
| E | `bin/boot.mjs:35-42` env 开关（Config 之前） | 已有 `DSH_TUI_COMPANION_LATEST` 范式 | 小：仅 bin 层；TUI Config 尚未建立，无法读取 settings |
| F | `src/tui.ts:14-17`/`:339-340` `notices` 容器布局与 `src/messages.ts:463` `renderNotice(text, level)` | 两套 notice 面：transient（无级别）与 transcript（有级别） | 中：若改走 transcript 面，展示位置与生命周期都不同 |

- 约束事实：core 日志文本无级别词（§2.4），tag 成功/失败共用（§2.2），因此任何基于文本的匹配只能依赖 `loaded N model(s), skipped N row(s)` / `failed (...)` / `refresh failed` 等子串。
- 约束事实：core 包文件在 `node_modules/@deepseek-ai/` 下（§2.1），本仓不持有其源码，修改不在本仓可控范围。
