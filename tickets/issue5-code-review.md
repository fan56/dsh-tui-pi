# issue #5 修复实现评审（commit 9cf4bea）

评审人：oldfox。日期：2026-11-23。只读评审，未改任何代码。
对象：worktree `/Users/qingguee/repo/dsh-tui-pi-wt-issue5`（分支 `fix/issue5-stderr-quiet`），对照 `tickets/issue5-fix-design.md` 与 `research/issue5-notice-noise.md`。

所有结论均经实测或 file:line 复核；正则边界用 Node 单独验证（14 组用例），测试在本机实际执行。

---

## 结论：GREEN（附 3 项 concern 跟进，无阻断项）

修复目标（周期性 model-listing 成功行画屏）在默认配置下正确达成；正则保守性、patch 透传语义、三层配置优先级全部实测通过；无回归（全量测试唯一失败项为 main 基线同样存在的预存 flake，双基线确证，见 §3.8）。

---

## 1. Blocker

无。

## 2. Concern（应修，不阻断本次合入）

### C1. muteModelListing 设置面板热生效缺口——设计承诺「提交即生效」，实现未接线

- 设计 §4 原文：「volatile 键 + patch 每次写时读 globalThis 状态 → **设置面板提交即生效，无需重启**」。
- 实现事实：`setStderrQuietEnabled` 全仓唯一调用点是 `apply()`（`src/index.ts:268`），只在启动/`/reload` 时执行一次。本插件的热生效通道 `settings/document-updated` 订阅（`src/theme-settings.ts:439-457` `subscribeThemeSettings`）只重读 theme/panelHeight/footerHints/iconSet/language 五键，muteModelListing 不在其中。
- 后果：用户在 `/settings` 把 `muteModelListing` 改为 `false` 并提交 → 无任何效果，直到 `/reload` 或重启。`skills/dsh-tui-pi-config/SKILL.md` 键表也未标注生效时机（同表其他键如 askUser 写明「每次打开面板生效」），用户会以为设置坏了。
- 兜底存在但不显眼：`/reload`、重启、`DSH_TUI_MUTE_MODEL_LISTING=0`（env 启动时读，语义正确）。
- 建议（二选一，前者约 10 行）：
  1. 在 `settings/document-updated` 回调补 `setStderrQuietEnabled(readMuteModelListing(process.env, readMuteModelListingExplicit(ctx)))`（与 apply 同式，幂等）；
  2. 或在 SKILL.md 键表与设计文档如实标注「需 /reload 生效」，并把设计 §4 的承诺句改掉。

### C2. 设计清单 #9（README.md / CHANGELOG.md）未交付

- 设计 §2 改动清单第 9 行要求「README.md / CHANGELOG.md：记录键与行为」；commit diff 不含这两个文件（grep `muteModelListing` 两文件 0 命中）。
- 先例：b40d002（notice 链路同类 user-facing 改动）同时更新了 CHANGELOG.md、README.md、e2e。本仓惯例是每个 user-facing 变更记 CHANGELOG。
- 建议：合入前补两处记录（键名、默认 true、env 逃生阀、生效时机——取决于 C1 的选择）。

### C3. SKILL_DESCRIPTION / SKILL.md 键计数 19，Config schema 实际 20 键：枚举遗漏 `jevAttention`

- `src/theme-settings.ts` 的 `Config` z.object 实际键（实测枚举）：language/theme/panelHeight/maxAgents/maxRounds/maxRoundsGrace/disableSubagent/registeredOnly/**jevAttention**/footerHints/cacheHitMode/iconSet/rememberPreset/favoriteModels/hiddenModels/retention/resume/askUser/idleReleaseSec/muteModelListing = 20 个。
- `src/index.ts:201` SKILL_DESCRIPTION 与 `skills/dsh-tui-pi-config/SKILL.md` frontmatter 均写「19 键」且枚举无 `jevAttention`；SKILL.md 键表同样无该键行。
- 定性：**预存遗漏**（main 基线即如此，本次改动从 18→19 只是延续了缺口），非本次引入，不阻断。
- 注意：补 `jevAttention` 入枚举会立刻顶爆 500 字符预算（当前 497，见 S1），需与 S1 一并处理。

## 3. 已验证的正确性（逐项复核/实测）

1. **正则**（`src/stderr-quiet.ts:24-25`）：14 组边界实测全部符合预期——两种 tag、`\n`/`\r\n`、三个失败模板（`failed (`/`refresh failed`/`change notification failed`）不命中、半行（无尾换行）不命中、多行混合块不命中、无换行整行不命中、尾随空格/前导空格/tab 分隔/双换行均不命中、0 与巨大计数命中、负计数不命中。误吞失败行的面实测为零；tag 字符类 `[^\]\r\n]+` 允许空格等字符，但仅当整行同构才命中——「其他包同形行同被静音」是设计 §5.4 声明的特性，不是缺陷。`\S+` 对真实 URL（无空白）正确。
2. **patch 透传语义**：吞 → `return true` + `process.nextTick(cb)`（cb 提取 `typeof encoding === 'function' ? encoding : callback` 正确兼顾 `(chunk,cb)`/`(chunk,enc,cb)` 双签名）；放行 → `Reflect.apply(originalWrite, process.stderr, arguments)` 保 this、argc、字节、backpressure 返回值。测试实测 fake 收到 argc=2/3 原始形状、Buffer `equals` 字节不变（无解码重建）。
3. **幂等与 /reload**：`Symbol.for('dsh-tui-pi.stderrQuiet')` 挂 globalThis 单例；patch 每次写动态读 `quietState().enabled`（不捕获模块局部）；query-string import 模拟 reload 的测试通过（新实例复用同一 wrapper、旧 patch 读到新实例翻转的开关）；重复 install 断言 write 引用不变、cb 恰一次。teardown 不卸载 patch 为设计声明决策（enabled=false 即直通），与两处 `setNoticeSink(undefined)` 无交互。
4. **volatile 默认 true 遮蔽 env 的坑——已正确规避**：`readMuteModelListingExplicit`（`src/theme-settings.ts:612-620`）走 settings 文档 USER layer 原始值（范式与既有 `readSessionManagementExplicit` `:557-561` 逐行同构），resolved 值烤入的默认 `true` 不参与优先级。实测优先级链：显式 boolean > env > true。**注意**：设计 §2 清单 #4 原文写的是「`readMuteModelListing(process.env, config)`（传 resolved config）」——照设计原文实现 env 逃生阀会失效，实现的偏差是必要修正。但设计文档该行未回写，后来者照设计抄会踩坑，建议回写设计文档（与 C1 的文档修订合并做）。
5. **env 解析一致性**：`String(raw).trim().toLowerCase()` + `['0','false','off']` 黑名单 + `undefined → true`，与 `bin/boot.mjs:38-42` `DSH_TUI_COMPANION_LATEST` 解析逐字同款。
6. **i18n**：`locales/` 四文件（en/ja/ko/zh-CN）`settings.muteModelListing.description` 键齐全同 key、文案语义一致。`locale/` 目录疑点排除：运行时只加载 `locales/`（`src/index.ts:2090`），`locale/` 是包清单元数据（meta.title），不含 settings.* 键，无需同步。
7. **SKILL_DESCRIPTION**：497 字符（`test/skill.test.mjs:101` 的 `<=500` 断言通过），与 SKILL.md frontmatter **逐字节一致**（实测 `identical: true`）。压缩删减（「界面语言」→「语言」等）未丢键信息，19 键枚举与改动后 Config 一致（唯 jevAttention 预存遗漏，见 C3）。
8. **测试执行**：`test/stderr-quiet.test.mjs` 10/10 通过（跑 built lib，pretest build，与 notice-bridge 范式一致）；`skill.test.mjs` + `theme-settings.test.mjs` 26/26 通过；全量 `npm test` 1521/1522——唯一失败是 `test/history-viewer.test.mjs` 的「s picker filters…Esc」用例（约 2s 超时特征），**main 基线全量同挂同一用例（1511/1512），worktree 与 main 单跑该文件均 33/33 通过**——预存并发 flake，与本改动无代码路径交集，不构成回归。
9. **测试质量**：10 用例覆盖设计 §4 全部 7 类 + reload 幂等 + enabled 翻转 + reset 还原 + 3 参形式吞行 cb；DI fake 在 install 前注入（模块 DI seam），`t.after` 双重还原（resetStderrQuiet + 恢复 realWrite），node --test 每文件独立进程，无真 stderr 污染路径。小缺口（不要求改）：无「同一行拆两个 write」用例（前半无换行 + 后半含换行 → 两半均透传、终端拼回完整行，是「宁漏吞」语义的正确行为，值得固化一个用例）。
10. **测试环境无取巧**：`node_modules/@deepseek-ai/*` 软链由仓库自带 `scripts/link-dsh-closure.mjs` 自动建立（`prebuild`/`precheck` 钩子），非手工软链；评审复现的前提仅是本机装有全局 dsh（仓库既有约定）。无 lockfile 是仓库本状（`package-lock.json` 本来就不存在，非本次引入）。
11. **与宿主 stderr 写互不干扰**：`console.warn` 失败行三模板不命中正则、透传；本仓自身 stderr 写点（`src/preflight-projcache.ts:44`、`src/projcache.ts:28`）文本不命中、透传。首行漏拦窗口（llm-deepseek-account 先于本插件 apply 加载时）为设计 §2 已声明接受的已知限制。

## 4. Suggestion（改进方向，本次不强求）

- **S1**（配合 C3）：`test/skill.test.mjs:101` 的 `<=500` 长度断言脆弱——当前 497/500 仅剩 3 字符余量，任何后续加键必爆。更稳做法：从 `Config` schema 导出键集合，断言 SKILL_DESCRIPTION 内枚举的键列表与 schema keys 一致（结构性核对），长度上限降为辅助预算检查。补 `jevAttention` 时一并做。
- **S2**：e2e 场景 67 未做（设计标「可选但建议」）；场景编号序列现为 65/66/68/69，67 空洞，后续命名注意别撞号。真机复验配方（设计 §6）执行与否无书面记录，建议在 PR 描述补真机复验结果（尤其对照组 `DSH_TUI_MUTE_MODEL_LISTING=0` 行回归）。
- **S3**：`installStderrQuiet` 的幂等守卫在第三方覆写 `process.stderr.write` 后会再包一层并覆盖 `state.originalWrite`（`resetStderrQuiet` 将还原到第三方 write 而非最初原生 write）。仅影响测试缝语义，生产不卸载 patch，可忽略，记录在案。

## 5. 跟进清单（按优先级）

1. C1：热生效接线或文档如实标注（含设计 §2 清单 #4 的「传 config」表述回写）。
2. C2：README.md + CHANGELOG.md 记录。
3. C3 + S1：SKILL 键枚举与 schema 对齐 + 断言结构化。

---

# 增量复核 8741791（review follow-up 补丁）

评审人：oldfox。日期：2026-11-23。只读复核，未改任何代码。对象：worktree `/Users/qingguee/repo/dsh-tui-pi-wt-issue5` commit `8741791`（相对 `9cf4bea`，8 文件 +132/−11），针对上轮 C1/C2/C3 的跟进交付。所有结论经 file:line 复核或本机实测。

## 1. 上轮 concern 闭环核对

### C1 热生效 — 已解决，接线正确

- **同语义**：订阅回调 `src/theme-settings.ts:461` 调 `setStderrQuietEnabled(readMuteModelListing(process.env, readMuteModelListingExplicit(ctx)))`，与 `apply()`（`src/index.ts:268`）逐字同式。`readMuteModelListingExplicit`（`:624-630`）读 settings 文档 USER 层原始 boolean，resolved volatile 默认 `true` 不参与优先级——env 逃生阀 `DSH_TUI_MUTE_MODEL_LISTING` 不被遮蔽，三层链（显式 > env > 默认）在热路径与启动路径一致。
- **触发频率与幂等**：`settings/document-updated` 每次 dsh-tui 段提交（含 self-write echo）触发一次；`setStderrQuietEnabled`（`src/stderr-quiet.ts:51-53`）是 `globalThis` 幂等赋值，echo/self-write 无副作用累积。
- **/reload 生命周期**：唯一生产调用点 `src/index.ts:366` 在 `ctx.effect(...)` 内注册，cordis fiber dispose 时随 ctx 移除监听；reload 后重新 `apply` 重新注册，不残留、不重复。`installStderrQuiet` 幂等守卫（patchedWrite 引用比对）+ `Symbol.for` 全局态跨模块逐出存活，上轮已验。
- **新测试走完整订阅路径**：`test/theme-settings.test.mjs:242-271`（新用例）经 `boot()` → 真实 `subscribeThemeSettings` → `settings.mutate`（fake service 完整复刻 loader 提交序列：应用 ops → `bindTuiConfig(refsFromSection)` → `ctx.emit('settings/document-updated')`）→ 真实回调翻转开关，断言以 fake stderr write 实际收到的字节为准（false → 透传 `[LINE]`，true → 再吞），不是读开关状态自证。实测通过（0.71ms）。
- 行为变化如实声明：`onPreferenceChange === undefined` 从「不注册」改为「仍注册（仅 mute 热更）」——全仓无传 `undefined` 的调用者（生产唯一，测试两处均传 sink），无破坏面，doc 注释已同步。

### C2 文档 — 已解决，与实现一致

- README `Configuration` 段：`muteModelListing` 并入 hot-apply 列表；新增段写明 boolean/默认 `true`、只吞整行成功行、`DSH_TUI_MUTE_MODEL_LISTING=0`（`false`/`off` 同义、未设即开）、显式设置值优先于 env——全部与实现一致。
- CHANGELOG `Unreleased`：默认值、env 名与取值、三层优先级、热生效通道（existing `settings/document-updated` subscription，no `/reload`）、回归测试清单（stderr-quiet 10 例 + theme-settings live flip）——逐项属实。
- 设计文档回写：§2 #4 已改为 `readMuteModelListingExplicit(ctx)` 并注明「不能传 resolved config，否则 env 逃生阀被默认 true 永久遮蔽」；#4b 新增热接线行；#6 改 20 键 + 断言结构化；#9 标记已交付；§4「热生效」补落地接线描述。均准确。微小瑕疵不纠：#4b 标注 `theme-settings.ts:444`，函数定义实际在 `:451`（444 是其 doc 注释中段，同块不误导）。

### C3/S1 键集与测试硬化 — 已解决

- `SKILL_DESCRIPTION`（`src/index.ts:201`）与 SKILL.md frontmatter 均 20 键含 `jevAttention`，实测长度 **495/500**；两 artifact **逐字节一致**（实测 `===` 为 true；测试另有 `assert.equal(frontmatterValue(...), candidate.description)` 断言）。SKILL.md 键表补 `jevAttention` 行，取值/默认/语义与 schema（`theme-settings.ts:250-254`，`z.union(['auto','off']).default('auto')`）一致。
- `configKeys()` 派生稳健性实测：`Object.keys(Config.dict)` 返回 20 键（含 `jevAttention`、`muteModelListing`），与 fallback `Object.keys(Config({}))` 键集完全一致——schemastery object 节点 `.dict` 结构假设成立，fallback 是有效保险。`Config` 经 `src/index.ts:75` re-export，测试 import 链通。
- 逐键断言双 artifact 覆盖：`assertEnumeratesConfigKeys` 分别对 `candidate.description` 与 frontmatter description 各跑一次，失败信息列出缺失键名并指示同时改两处——可执行。
- 500 上限依据**亲测属实**（非转述）：`node_modules/@deepseek-ai/dsh-tool-skill/src/index.ts:28` `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500`，`:71/:81` 可经 `catalogDescriptionMaxLength` 覆盖（最小 3）；`:411-414` `catalogDescription` 归一化空白后超长即 `slice(0, maxLength-3) + '...'` 截断——测试注释描述准确。断言原始长度 ≤500 是充分保守界（归一化只会更短，描述本身无换行）。

## 2. 新引入风险核查

- **无抛异常路径**：回调新增行 = `readMuteModelListingExplicit`（全程可选链，service/entry/层缺失均返回 `undefined`）+ `readMuteModelListing`（纯函数）+ `setStderrQuietEnabled`（纯赋值）。五键转发在该行之后，不存在被阻断的面。
- **对五个 theme 键零影响**：回调顺序为 mute 赋值 → 原转发逻辑原样保留；`describe()` 每次 commit 多一次同步轻量调用，无行为差异。
- **includes 子串匹配的弱点**（suggestion，不阻断）：逐键断言用 `description.includes(key)`，`theme`/`language`/`resume` 同时出现在触发词区——未来若新键枚举漏列但恰是已有词的子串（或触发词误含该词），断言不会挂。当前 20 键枚举完整，无现实缺口；更硬化可匹配「键枚举段」而非全文。
- **触发词删减**：为腾字符删了触发词尾部「、idleReleaseSec」（键枚举仍在，逐键断言过）——路由召回面略降，产品决策，记录在案。
- **热路径 env 组合未测**（suggestion）：新用例未覆盖「`DSH_TUI_MUTE_MODEL_LISTING=0` + USER 层无显式值 + 任意键提交」的 env 生效翻转；代码与 apply 同式且 apply 路径已有测试，风险低，可后补一例。
- 新测试第三断言的 fake stderr 窗口仅几行同步代码，第三方 stderr 写入会顶爆 `seen.length`——概率可忽略（stderr-quiet 测试同范式稳定），记录在案。

## 3. 测试复测（本机实测）

- 三文件定向：`skill` + `theme-settings` + `stderr-quiet` 共 **37/37 通过**（含新 live-flip 用例，实测执行 0.71ms）。
- 全量 `npm test`：**1521/1523**，两失败均在 `test/history-viewer.test.mjs`（`:526` s-picker、`:571` corrupt-session，同为 waitFor 2000ms 超时特征）；**单跑该文件 33/33 通过**——并发时序 flake，与本改动无代码路径交集（diff 8 文件不含该文件及 pi-tui 渲染路径），上轮已双基线确证 main 同挂。
- 声明差异如实记录：执行者报「1522/1523 唯一失败 s-picker」，本次复测多挂同文件另一用例（571）——失败集合在不同 run 间漂移恰是 flake 特征，非回归信号，结论不受影响。

## 4. 结论

上轮 C1/C2/C3 全部闭环且实现正确；新增面无阻断项、无 concern 级问题；余下均为 suggestion（includes 匹配硬化、env 组合热路径补测），可随日常迭代处理。

GREEN

---

# 增量复核 18f1bff（trigger words 恢复 + 断言硬化 + env 热路径补测）

评审人：oldfox。日期：2026-11-23。只读复核，未改任何代码。对象：worktree `/Users/qingguee/repo/dsh-tui-pi-wt-issue5-polish`（分支 `fix/issue5-polish`）commit `18f1bff`（相对 `68dc7f6`，4 文件 +89/−12），针对上轮 8741791 复核所留 3 条 suggestion 的跟进交付。所有关键结论经本机实测（非转述）：lib 构建新鲜（`lib/index.js` 12:13 晚于 `src/index.ts` 12:12，内含新描述文本），实测脚本从构建产物与 SKILL.md 原文提取字符串比对。

## 1. 上轮 suggestion 闭环核对

### S1' includes 匹配硬化（枚举段 + 集合相等）— 已解决，实测证实

- **解析正确性（对真实文本跑过，非只看代码）**：复制 `enumeratedKeys`（`test/skill.test.mjs:36-41`，正则 `/键（([^）]*)）/')` split `/`）对构建产物中的实际 `SKILL_DESCRIPTION` 执行——解析出恰好 20 键，与 `Config.dict` 的 20 键**集合相等，missing/extra 双向皆空**。「键（」在描述全文仅出现 1 次（first-match 无歧义）；枚举段内实测无顿号、无逗号，`/` 分隔假设对当前文本成立；段外的 `/resume`、`/hotkeys` 不在捕获范围内。
- **变异复现（commit 声称属实）**：把描述中枚举段的 `idleReleaseSec/` 删掉、保留触发词区的 `idleReleaseSec`，本机复现：旧 `includes` 断言 missing=[] **不挂（漏报）**；新集合相等断言报 `missing: ['idleReleaseSec']` **挂**。声称的「新断言报 missing: idleReleaseSec，旧 includes 不漏」逐字证实。另做两个补充变异：枚举塞 ghost 键 → extra 侧捕获；分隔符 `/` 全换顿号 → 解析为单 blob、missing=20 挂（fail 方向，不是漏）。
- **frontmatter 同处理**：`frontmatterValue` 提取后过同一个 `assertEnumeratesConfigKeys`（`test/skill.test.mjs:199-203`），失败信息区分是哪个 artifact 漂移并指示双改。
- **500 上限断言仍在**：`test/skill.test.mjs:145-151` 原样保留，本次 diff 只改了其上方注释。

### S2' 热路径 env 组合补测 — 已解决，语义逐条核对

- 新用例 `muteModelListing hot-path honors settings > env > default on every commit`（`test/theme-settings.test.mjs:275-325`）四组合逐一对照 `readMuteModelListing`（`src/theme-settings.ts:639-648`）：
  - (a) env=`'0'` + USER 层无显式 → `!['0','false','off'].includes('0')` = false → 透传。断言 passthrough，一致。
  - (b) env=`'0'` + 显式 true → `explicit !== undefined` 提前返回 true → 吞。一致。
  - (c) 显式 false + env 未设 → false → 透传（默认 true 被显式压制）。一致。
  - (c-variant) 显式 false + env=`'1'` → false → 透传（settings 压 env）。一致。
  - 四条与 doc 注释（`theme-settings.ts:631-638`）声明的 settings > env > default 三层链完全吻合，且与 `apply()`（`src/index.ts:268`）同式。
- **走的是真实订阅回调**：`boot()` 用 lib 导出的真实 `subscribeThemeSettings`；fake service `mutate` 复刻 loader 提交序列（ops → `bindTuiConfig` → `ctx.emit('settings/document-updated')`），回调内 `readMuteModelListingExplicit(ctx)` 经 `ctx.get('settings').describe()[0].user` getter 读 `service.user`（测试直赋模拟外部 USER 层编辑 + 任意键提交触发事件）。断言以 fake stderr write 实际收到的字节为准，非读开关自证。
- **恢复干净**：`t.after` 记录 `prevEnv`（undefined → delete 恢复）、`resetStderrQuiet()`（实测读 `src/stderr-quiet.ts:90-98`：恢复 write 引用、`installed=false`、`enabled=true` 复位，跨用例无状态泄漏）、write 引用恢复。上一用例（explicit-toggle）与本用例相邻且同范式，`installStderrQuiet` 守卫经 `process.stderr.write !== state.patchedWrite` 判定重装，不叠层。

### S3' 触发词恢复 — 已解决，一致性实测

- `idleReleaseSec` 加回触发词段末尾（`preset、idleReleaseSec`）；键枚举段本就完整（集合相等实测）；SKILL.md 正文键表 `:44` 与 env 表 `:54` 未动。
- **两 artifact 逐字节一致（亲测）**：从 `lib/index.js` 提取的 `SKILL_DESCRIPTION` 与 SKILL.md frontmatter 提取值 `===` 为 true；实测长度 **498/500**（JS 字符计）。测试另有 `assert.equal(frontmatterValue(...), candidate.description)` 兜底。
- **压缩 6 处语义评估**：增强套件配置指南→配置指南（丢品牌词「增强套件」，触发词区亦无该词——轻微召回面损失，产品决策，记录在案）；凡涉及→涉及、先读本指南→读本指南、的 20 键→20 键、与 /resume→/resume、与 /hotkeys→、/hotkeys（均无实质语义损失，并列结构保留）。

## 2. 新引入风险核查

- **无阻断、无 concern**。`src/index.ts` 仅改字符串字面量（skill 路由文案），不触及任何运行时逻辑路径；两测试文件为纯增改。
- Suggestion 级记录（可忽略/随迭代）：正则 `/键（([^）]*)）/` 未锚定「20 键」——若未来文案在枚举段之前新增另一处「键（…」会取错段，但取错段的失败方向是集合不等报错（fail），不是漏；枚举内重复键经 Set 化不会被 extra 报，但重复意味着少一个真键、由 missing 侧闭环；498/500 仅余 2 字符，下次加键必超预算，需再压缩（上轮已提示的预算压力，本次压缩正是为其腾位）。
- 测试复测（本机实测）：定向三文件 `skill` + `theme-settings` + `stderr-quiet` 单进程 **38/38 通过**（较上轮 37 例 +1，即新 env 组合用例）。全量未跑：diff 面仅 4 文件且 src 侧只有文案字符串，与已知 flake（history-viewer）及任何渲染路径无交集，上轮已双基线；增量风险由定向覆盖。

## 3. 结论

上轮 3 条 suggestion 全部闭环：枚举段集合相等断言经变异测试证实补上了 includes 的漏报面；env/settings 四组合热路径语义与定义逐条一致且走真实订阅链；触发词恢复且两 artifact 逐字节一致（498/500）。无新引入阻断项或 concern，余下均为可忽略的 suggestion 记录。

GREEN
