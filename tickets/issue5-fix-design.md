# issue #5 修复设计决策（Notice 噪音 → 实为 raw stderr 画屏）

决策人：oldfox（评审角色）。日期：2026-11-23。基于 `research/issue5-notice-noise.md` + 全量源码复核（本文所有行号均已亲自复核或实证）。

---

## 1. 机制定论

**「raw stderr 直接画屏」是唯一解释，调研结论成立；issue 正文的机制描述（notice-bridge 收 stray stderr）与代码不符，错误。**

实证链（每环独立验证）：

1. 行的产地：`node_modules/@deepseek-ai/dsh-llm-deepseek/src/host.ts:30` `info: (message) => { console.error(tag, message) }`；成功行模板在 `dsh-llm-deepseek/src/listing-cache.ts:138`，**每次 settle 无条件打印**（`:134-139`：`changed` 只决定是否 `notify()`，不影响 `info`）。刷新周期 `listing-config.ts:12` `DEFAULT_MODELS_MAX_AGE_MS = 600_000`。
2. tag 来源：`host.ts:25` `tag = \`[${owner}]\``。**调用 `createModelListingCache` 的 owner 有两个**：`dsh-llm-deepseek-account`（`src/index.ts:51`，tag `[llm-deepseek-account]`）和 `dsh-llm-deepseek-api-key`（`src/index.ts:55`，tag `[llm-deepseek-api-key]`）。两者都会打同款成功行。
3. 无任何 stderr 捕获层（逐一 grep 复核，均无 `process.stderr.write =` / `console.error =` / `console.warn =` 之类拦截）：
   - 本仓 `src/`、`bin/`、`lib/`、`scripts/`；
   - `node_modules/@deepseek-ai/` 全部约 300 个包（含 dsh-cordis-host-runner、dsh-app-boot 等宿主包）；
   - 全局 dsh CLI `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/*.js`；
   - TUI 库 `@earendil-works/pi-tui`：`ProcessTerminal` 全部写 `process.stdout`（`dist/terminal.js:120/186/272/354` 等），不管辖 stderr。
4. 进程拓扑：插件与 core 同进程（`src/notice-bridge.ts:4-6` 自述 in-process）；launcher `bin/boot.mjs:45` `spawnSync(dsh, ..., { stdio: 'inherit' })`，stderr 直通终端。
5. **关键行为实证**（本机 Node 实验）：`console.error(tag, message)` 产生**单次** `process.stderr.write("[tag] message\n", cb)`——一次 write 即完整行含尾换行，且带 callback。整个方案建立在「单次完整行」上，此假设已实验证实。
6. 观感解释：pi-tui 渲染后光标常驻输入区附近，raw stderr 字节写到当前光标位置，画在输入框上方——用户看到「一行通知」，实为画屏垃圾，与 notice-bridge（`src/index.ts:802` 注册的 `ui.showNotice` 通道，仅服务本仓 9 个 emitNotice 生产者）完全无关。

因此：issue 建议 1（区分 notice 级别）、建议 3（notice 合并计数）建立在错误机制认知上，**均不解决本问题**；建议 2（tag/前缀过滤）方向对，但过滤点必须在 stderr 出口，不在 notice 链路。

---

## 2. 选定方案：候选 G —— in-process `process.stderr.write` 包装模块

新增 `src/stderr-quiet.ts`，在插件 `apply()` 早期安装幂等的 `process.stderr.write` 包装：**整块完全匹配「model listing 成功行」正则的 write 被吞掉，其余一切字节级原样转发**。这是本仓可控层内唯一能拦住 core stderr 行的点位（同进程使然）。

### 匹配规则（核心）

```js
export const MODEL_LISTING_SUCCESS =
  /^\[[^\]\r\n]+\] model listing from \S+ loaded \d+ model\(s\), skipped \d+ row\(s\)\r?\n$/
```

- **tag 不限 owner**：同时覆盖 `[llm-deepseek-account]` 与 `[llm-deepseek-api-key]`（§1.2 两个 owner 都打此行；同类行同类噪音）。
- **仅成功行**：失败行三模板（`failed (...)` `listing-cache.ts:144`、`refresh failed` `:195`、`change notification failed` `:162`）与 account 的 catalog override 问题行（`dsh-llm-deepseek-account/src/index.ts:69`）词形不同（`loaded` vs `failed`），均不匹配、全部放行——失败行是真信号，必须继续可见。
- **整块完全匹配才吞**（anchored `^...$`）：半行、无换行片段、多行混合块一律不匹配 → 原样转发。宁漏吞不误吞。
- Buffer chunk：按 utf8 解码测正则；不匹配时**原参数透传**（不转换不重建），字节级不变。

### patch 语义

- 吞：返回 `true`；callback（实验证实 `console.error` 会传 cb）经 `process.nextTick(cb)` 调用，避免上层挂起/重入。
- 放行：`return originalWrite.apply(process.stderr, arguments)`——保留 this、返回值（backpressure）、`(chunk, cb)` 与 `(chunk, enc, cb)` 双签名。
- patch 状态挂 `globalThis` 上的 symbol 键单例（`{ installed, enabled }`）：`/reload` ESM 模块逐出后新实例读到同一对象，幂等不叠加；patch 闭包每次 write 动态读 `enabled`，不捕获模块局部变量——杜绝孤儿闭包读死值。
- 提供测试缝 `resetStderrQuiet()`（还原 `process.stderr.write`）。

### 文件:行号级改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/stderr-quiet.ts`（新增） | `MODEL_LISTING_SUCCESS` 正则导出；`installStderrQuiet()`（幂等装 patch，读 globalThis 状态）；`setStderrQuietEnabled(v)`；`resetStderrQuiet()` 测试缝 |
| 2 | `src/theme-settings.ts:201` `Config` | `idleReleaseSec`（`:339-345`）之后加 `muteModelListing: z.boolean().default(true).volatile().description(t('settings.muteModelListing.description'))` |
| 3 | `src/theme-settings.ts` | 新 reader `readMuteModelListing(env, settings)`：settings 显式值 > env > 默认 true（见 §4） |
| 4 | `src/index.ts:256` `apply()` | `bindTuiConfig(config)` 之后**立即**：`setStderrQuietEnabled(readMuteModelListing(process.env, readMuteModelListingExplicit(ctx)))` + `installStderrQuiet()`；注意顺序先设状态再装（装后第一条 write 即按最终状态走）。**显式值必须走 `readMuteModelListingExplicit(ctx)`（settings 文档 USER 层原始值），不能传 resolved `config`**：volatile resolved 值已烤入 schema 默认 `true`，会把 `DSH_TUI_MUTE_MODEL_LISTING` 逃生阀永久遮蔽——本行是落地时对原始设计表述的必要修正。 |
| 4b | `src/theme-settings.ts:444` `subscribeThemeSettings` | 热生效补接：现有 `settings/document-updated` 订阅回调（原只转发 theme/panelHeight/footerHints/iconSet/language 五键）每次事件追加一行 `setStderrQuietEnabled(readMuteModelListing(process.env, readMuteModelListingExplicit(ctx)))`（与 apply 同式、幂等），面板提交即生效，无需 /reload。评审 C1 跟进项。 |
| 5 | `locale/`（i18n） | 新键 `settings.muteModelListing.description`（中英） |
| 6 | `src/index.ts:198` `SKILL_DESCRIPTION` | 「18 键」→「20 键」，枚举加 `muteModelListing` + 预存遗漏的 `jevAttention`（评审 C3）；**同步 SKILL.md frontmatter 与键表**（有测试断言二者一致，不同步必挂测试）；`test/skill.test.mjs` 断言改为从导出 Config schema 派生 20 键逐键核对，长度上限降级为辅助预算检查（评审 S1） |
| 7 | `test/stderr-quiet.test.mjs`（新增） | 见 §6 |
| 8 | `e2e/scenarios/67-stderr-quiet.sh`（新增，可选但建议） | 见 §6 |
| 9 | `README.md` / `CHANGELOG.md` | 记录键与行为：默认 `true`、`DSH_TUI_MUTE_MODEL_LISTING` 逃生阀、面板提交热生效、issue #5（评审 C2 跟进项，已交付） |

### 已知限制（如实记录）

- **首行漏拦窗口**：若 `llm-deepseek-account` 插件先于本插件加载，启动首条 listing 行可能在 `apply()` 安装前落屏。可接受：issue 痛点是每 10 分钟的周期重复；首行出现于启动帧阶段，视觉影响一次性。不在模块顶层安装 patch（违反本仓「模块零顶层副作用」风格——notice-bridge 等均为显式调用）。
- 吞行无痕：静音后无任何替代提示（决策，见 §4）。

---

## 3. 被否候选与理由

| 候选 | 位置 | 判定 | 理由 |
|---|---|---|---|
| A | `src/notice-bridge.ts:81` `emitNotice` 内过滤 | **否决** | 该行根本不走 `emitNotice`（§1 机制定论）。改了对本 issue 零效果，还污染 9 个正经 producer 的共用通道 |
| B | `src/index.ts:802` sink lambda 过滤 | **否决** | 同上：行不经 notice 链路 |
| C | `src/tui.ts:390-410` `showNotice` 加级别参数 | **否决** | 同上；且 issue 建议 1/3 建立在错误机制认知上。transient notice 无级别是既有设计（统一 fgMuted/8s/8 行），不为不存在的流量改接口 |
| D | `src/theme-settings.ts:201` Config 配置面 | **部分采纳** | 仅作为配置承载（本方案 #2/#3），不是拦截点 |
| E | `bin/boot.mjs:35-42` boot 层开关 | **否决** | boot 层要拦 stderr 必须 `stdio:'pipe'` 自建同步泵：丢 TTY 直通（isTTY 变 false 可能改变宿主行为）、launcher 从 exec 直通变 mediator、交互实时性风险，代价远超收益。env 键放插件层读即可 |
| F | `src/messages.ts:463` transcript `renderNotice` | **否决** | 另一条持久 transcript 通道，与本行无关；改走它改变展示生命周期，答非所问 |
| H（另提） | `NODE_OPTIONS=--require` preload 拦截 | **否决** | 比 E 稍优（仍 inherit）但作用域覆盖宿主全部模块加载路径，跨包心智负担大；相比插件内 patch 只换来「略早」的安装时机，不划算 |

---

## 4. 配置面

- **键名**：`dsh-tui.muteModelListing`，`boolean`，`.volatile()`，**默认 true（开）**。理由：issue 即本仓用户诉求，静音成功行是修复意图；匹配策略极保守（整块正则），默认开的误伤面接近零。
- **env 逃生阀**：`DSH_TUI_MUTE_MODEL_LISTING`（非 `0/false/off` 即开——照抄 `bin/boot.mjs:38-42` `DSH_TUI_COMPANION_LATEST` 的解析风格）。
- **三层优先级**：settings 显式值 > env > 默认 true（范式：`src/retention.ts:189-207` `resolveRetentionConfig` 的 settings>env>default）。
- **热生效**：volatile 键 + patch 每次写时读 globalThis 状态 → 设置面板提交即生效，无需重启。**落地接线**：`subscribeThemeSettings`（`src/theme-settings.ts`，清单 #4b）的 `settings/document-updated` 回调在转发五个 theme 键之外，同事件调用 `setStderrQuietEnabled(readMuteModelListing(process.env, readMuteModelListingExplicit(ctx)))`；patch 闭包每次 write 读 globalThis 状态，所以下一次 listing 行即按新值走。评审 C1 指出初版只有 apply() 设一次（需 /reload），跟进补丁已补此接线。优于 issue 里「改 `modelsMaxAgeMs` 拉到 24h + 重启」的临时规避（后者牺牲模型上下架可见时延）。
- **i18n 与 SKILL_DESCRIPTION**：都要做（§2 清单 #5/#6）。SKILL.md frontmatter 必须同步，否则一致性测试挂。
- **附加行为（压制计数合并成低频 notice）不做**。理由：成功刷新信息量为零（失败才是信号），静默即目标；计数器+定时器+新文案+新 i18n 全是为呈现「无事件」的事件，扩大维护面。同意任务方倾向。

---

## 5. 风险与规避

| # | 风险 | 规避 |
|---|---|---|
| 1 | stderr.write 半行/多行/无换行被误吞 | 整块 anchored 完全匹配才吞；否则原样转发。console.error 实证为单次完整行（§1.5），其余来源不匹配即透传 |
| 2 | 与 TUI 自身 stderr 写冲突 | pi-tui 只写 stdout（`dist/terminal.js` 全量复核）；本仓 stderr 写点仅 `src/preflight-projcache.ts:44`、`src/projcache.ts:28`（boot 阶段，文本不匹配正则，放行）。无冲突 |
| 3 | `/reload` teardown 残留 / 双层 patch | 状态挂 globalThis symbol 单例，幂等安装；reload 后新实例复用同一 patch 仅替换 `enabled`。**不卸载**（避免多实例/孤儿问题），`enabled=false` 即直通；进程退出自然消亡。与 `setNoticeSink(undefined)` 两处 teardown（`src/index.ts:2540/:2573`）无交互——patch 不属于 notice 链路 |
| 4 | 其他插件共用该 tag / 新 owner 出现 | 正则不限 owner 是特性：api-key 路由已被覆盖；未来同构行同被静音，同类噪音同理 |
| 5 | 退出码/信号/交互受损 | 只影响 stderr 内容；stdout/stdin/exit code/信号路径零改动。吞行时 nextTick 调 cb，防止上游 Promise 挂起 |
| 6 | backpressure / 返回值语义 | 放行走 `originalWrite.apply(process.stderr, arguments)` 原样透传返回值；吞时返回 true（Writable 契约：接受写入） |
| 7 | 代码解构缓存 `process.stderr.write` 引用绕过 patch | core 走 `console.error` 属性查找（实证），不缓存引用；已知低风险，接受 |
| 8 | core 在 worker thread 写 stderr 拦不住 | listing 加载是主线程 fetch，无 worker stderr；低风险，接受 |
| 9 | 上游未来改掉该日志 | 正则不命中，patch 变 no-op，无副作用；升级安全，与上游修复天然兼容 |
| 10 | 首行漏拦 | 已知限制（§2），记录不改 |

---

## 6. 测试计划

### 单测（新增 `test/stderr-quiet.test.mjs`，跑 built lib，DI 注入 fake write，范式同 `test/notice-bridge.test.mjs`）

1. 成功行命中（`[llm-deepseek-account]`、`[llm-deepseek-api-key]` 两种 tag；`\n` 与 `\r\n`；string 与 utf8 Buffer 形态）→ 吞、返回 true、cb 被 nextTick 调用；
2. 失败行三模板（`failed (`、`refresh failed`、`change notification failed`）→ 原样转发、返回值透传；
3. 半行（无换行）、多行混合块、空 chunk、无关文本 → 字节级原样转发（不转换）；
4. `(chunk, cb)` 与 `(chunk, enc, cb)` 双签名透传；
5. 幂等：重复 `installStderrQuiet()` patch 仍单层；
6. `setStderrQuietEnabled(false)` 后命中行也直通（模拟 reload 重绑/用户关闭）;
7. `resetStderrQuiet()` 还原全局（防测试间泄漏）。

### 回归

`npm test`（pretest 自动 build）全量；重点：`test/notice-bridge.test.mjs`（8 用例）、`test/theme-settings.test.mjs`（含 SKILL_DESCRIPTION 一致性断言——清单 #6 不同步会挂）。

### e2e（建议做，可裁）

新场景 `e2e/scenarios/67-stderr-quiet.sh`：容器内 profile patch `modelsMaxAgeMs: 5000` → tmux 起 TUI → 等待 ~12s → `capture-pane` 断言不含 `loaded .* model(s)`；对照组 `DSH_TUI_MUTE_MODEL_LISTING=0` 断言出现。失败行断言需断网模拟，列为可选不做。

### 真机复验配方（主 agent 执行；判定由抓帧对照完成）

```bash
# 0) 前置：在 ~/.dsh/profiles/tui 的 patch 机制（issue 临时规避同款）加：
#    - id: llm-deepseek-account / config: modelsMaxAgeMs: 5000   （5s 强刷）
# 1) 基线（修复前，确认复现成立——基线不成立则整个 issue 复现链存疑，回报）：
tmux new-session -d -s noise 'dst'
sleep 15
for i in 1 2 3 4 5; do tmux capture-pane -p -t noise | grep -c 'model listing from .* loaded' ; sleep 2; done
#    期望任一帧 ≥1
# 2) 修复后：同一 patch 重复步骤 1 → 期望全部 0
# 3) 开关有效性：DSH_TUI_MUTE_MODEL_LISTING=0 dst 重复 → 期望任一帧 ≥1
# 4) 设置面板热生效（可选）：/settings 或 volatile 提交 muteModelListing=false → 下个刷新周期行回归
# 5) 收尾：删掉 modelsMaxAgeMs patch（恢复默认 600000）
```

注意：raw stderr 行画屏后可能被下次渲染覆盖，多抓几帧取「窗口内任一帧命中」。

---

## 7. core 侧上游修法（另记）

**值得往 upstream discussions 提**（按既有约定：只发 discussions，不发 PR、不动 fork）。提议要点：`dsh-llm-deepseek/src/listing-cache.ts:138` 的成功行改为仅 `listing.changed` 时打印（或加可配置日志级别 `off/changed/always`，配置落点即 `config.ts` 已有 `catalog.timing` 段旁）。

理由：
1. 成功行每次 settle 无条件打，信息量为零——有意义的信号是 `changed`，且 changed 已由 `llm/models-updated` 事件承载（`host.ts:32`），日志冗余；
2. `host.ts:29-31` 注释自陈「ACP 保留 stdout」故 info 刻意走 stderr——结果是任何 alt-screen / ACP 前端都无法区分 info 与 warn，成功行被当故障展示，影响面是**所有 TUI 类前端**，不止本仓；
3. 失败行保留不变（真信号）。

与本仓自修的关系：正交兼容。上游若采纳，本仓正则自然 no-op，两层可并存过渡。

---

## 结论

改代码，选候选 G（`src/stderr-quiet.ts` + `process.stderr.write` 幂等包装 + 整块成功行正则），配置 `dsh-tui.muteModelListing`（默认 true，volatile，env 逃生阀 `DSH_TUI_MUTE_MODEL_LISTING`），不做计数合并，不碰 notice 链路与 showNotice 接口，不动 boot 拓扑。
