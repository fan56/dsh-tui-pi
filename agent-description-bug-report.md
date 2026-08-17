# 报告：workhorse description 显示成 `\"牛马狗…` 的确切代码定位与环境证据

## 结论先行

前端列表渲染路径本身**没有**任何转义问题。`\"牛马狗…` 是**数据文件本身**已经损坏的产物：
列表读到的 `meta.description` 值里**本来就带着 `\` + `"`**，渲染器只是原样输出。

根因是 `agent-manager.ts` 的读/写不对称：
- 读路径 `stripQuotes()` **(第 106–113 行)** 只剥离一层**成对的**外围引号，**不会**对值内部的转义（`\"`、`\\`）做反转义；
- 写路径 `renderAgentMarkdown()` **JSON.stringify(meta.description) (第 177 行)** 会把值里的引号/反斜杠转义再写回文件；
- 两者反复交替（seed/save → reload）时，`\` 数量**指数增长**（1→3→7→15→31…）。

数据文件 `.dsh/agents/workhorse.md` 与 seed 源 `.zcode/agents/workhorse.md` 中
`description` 的实际字节就是 `" + 15 个反斜杠 + " + 牛马狗…`（后者是 7 个反斜杠）。
`seedFromZcode`（第 292 行）在拷贝时用 `renderAgentMarkdown` 把 7 → 15 个反斜杠放大。

---

## 1. 列表渲染代码位置（操作提示条定位）

`↑↓ navigate · Enter open · Esc back` 精确命中 `/agents` 命令的实现：

- `src/agents.ts:233` — footer 提示条 `'↑↓ navigate · Enter open · Esc back'`
- `src/agents.ts:228-234` — `new TablePanel({..., rows: agents, renderCell: agentCell, footer: ...})`
- `src/agents.ts:73-78` — 列定义 `AGENT_COLUMNS`（description 为 flex 列）
- `src/agents.ts:81-89` — **description 列的取值来源**：

```ts
function agentCell(agent: AgentFile, column: { key: string }): string {
  const meta = agent.meta
  switch (column.key) {
    ...
    default: return meta.description ?? ''   // ← 87 行：直接返回 meta.description，无任何处理
  }
}
```

渲染管线（不转义，原样输出）：
- `src/panels.ts:221` `padCell(renderCell(row, column), widths[j], column.align)`
- `src/panels.ts:50-55` `padCell` → `clipToWidth`（仅截断/补空格，无转义）
- `src/text.ts:31-45` `clipToWidth`（仅宽度截断，无转义）

**证据**：`JSON.stringify`、`replace(/"/g` 在 `src/agents.ts`、`src/panels.ts` 中**均不存在**。
（全仓库 `JSON.stringify` 只在 `agent-manager.ts:177` 写路径出现。）

## 2. description 的来源与 frontmatter 解析

`/agents` 从 `agentsDir()` 读取，即 **`~/.dsh/agents`**（`src/agent-manager.ts:62-64`）：
`agents.ts:200 listAgentFiles(dir)` → `agent-manager.ts:188-201 listAgentFiles`
→ `agent-manager.ts:195 parseAgentMarkdown(readFileSync(path...))`。

### 解析函数（手写，未用 yaml 库）：`src/agent-manager.ts`

```ts
// 103
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/
// 106-113  ← 关键：只剥离一对“成对且匹配”的外围引号
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}
// 125-133
function parseFrontmatterValues(lines: string[], close: number): Record<string, string> {
  ...
  values[match[1]] = stripQuotes(match[2].trim())   // ← 130 行
  ...
}
// 140-170
export function parseAgentMarkdown(...) {
  ...
  const description = values['description']?.trim()   // 161
  if (description !== undefined && description !== '') meta.description = description  // 162
}
```

**关键结论**：解析**确实剥离成对引号**（对干净的 `"牛马狗…"` 是能正确去引号的），
但**不（能）反转义已转义内容**。对已含 `\`+`"` 的值，`stripQuotes` 只剥掉最外一层 `"…"`，
剩下的 `\`+`"` 原样进入 `meta.description`。

用实际模块对该文件实测（`lib/agent-manager.js` 与 `src` 一致，见下节）：

```
parse .dsh/agents/workhorse.md →
  meta.description = 15× "\\"  + '"' + "牛马狗：干活的主力。…"
  raw display      = \\\\\\\\\\\\\\\"牛马狗：干活的主力。写代码…
  starts with '\\' ? true   ✅  → 这就是 UI 上看到的 "\ 牛马狗…
```

## 3. `\"` 是怎么产生的 —— 不在渲染路径，而在数据/写路径

- 渲染路径（`agents.ts`/`panels.ts`/`text.ts`）**零转义**，`meta.description` 里有 `\`+`"` 就原样显示。铁证：`grep JSON.stringify` 与 `grep replace(/"/g` 在这三个文件里无命中。
- 反斜杠来自**写路径与 seed 路径**：

`src/agent-manager.ts:177`（写回 markdown）：
```ts
if (meta.description !== undefined) lines.push(`description: ${JSON.stringify(meta.description)}`)
```
调用者：
- `seedFromZcode`（`src/agent-manager.ts:292-319`，`/agents` 首次打开、目录为空时把 `.zcode/agents` 拷进来，**第 315 行 `writeFileSync(... renderAgentMarkdown(agent.meta, agent.body))`**）；
- `renderAgentMarkdown` 另被测试以 round-trip 校验（`test/agent-manager.test.mjs:86`）。

### 放大机制（实测）

`parse(剥一对引号) → JSON.stringify(转义写回)` 交替，当值内含一个裸露的“前导引号”时，
反斜杠按 1→3→7→15→31… 指数增长（`node` 实测，run 4 次后值含 15 个 `\`）：

```
start  meta.description = '\"牛马狗'            (1 个前导引号未被配对剥离)
cycle1 写回后值 = 1 个反斜杠 + " 
cycle2 写回后值 = 3 个反斜杠 + "
cycle3 写回后值 = 7 个反斜杠 + "     ← .zcode/agents/workhorse.md 处于此状态
cycle4 写回后值 = 15 个反斜杠 + "    ← .dsh/agents/workhorse.md 处于此状态
cycle5 写回后值 = 31 个反斜杠 + "
```

### 磁盘字节证据

| 文件 | description 值（外层引号剥掉后） |
|---|---|
| `.pi/agent/agents/workhorse.md`（干净源，用户已确认） | `"牛马狗…`（无反斜杠）—— **本仓库根本不读这个文件** |
| `.zcode/agents/workhorse.md`（seed 源，`agentsDir` 曾/git 显示 zcode） | `7×"\\" + 牛马狗…` |
| `.dsh/agents/workhorse.md`（本仓库实际读取） | `15×"\\" + 牛马狗…` |

`agentsDir()` 只指向 `~/.dsh/agents`（`src/agent-manager.ts:62-64`），**不读 `.pi/agent/agents`**。
用户描述的 `.pi` 那份是干净的，与 bug 无关；本仓库显示的是 `.dsh` 那份，已损坏。

### 各文件行号速查

| 文件 | 行号 | 说明 |
|---|---|---|
| `src/agents.ts` | 87 | `return meta.description ?? ''`（列取值，直接透传） |
| `src/agents.ts` | 233 | footer `↑↓ navigate · Enter open · Esc back`（定位锚点） |
| `src/panels.ts` | 221 / 50 | `padCell(renderCell...)` / `padCell`（不转义） |
| `src/agent-manager.ts` | 106-113 | `stripQuotes` —— 只剥一对匹配引号，**不反转义**（读路径缺陷） |
| `src/agent-manager.ts` | 130 | `stripQuotes(match[2].trim())` |
| `src/agent-manager.ts` | 177 | `description: ${JSON.stringify(meta.description)}`（写路径，放大反斜杠） |
| `src/agent-manager.ts` | 292-319 / 315 | `seedFromZcode` 用 `renderAgentMarkdown` 拷贝，7→15 放大 |

## 4. 写路径 `agent-manager.js:148`（= `src/agent-manager.ts:177`）的场景

- 位置：`renderAgentMarkdown(meta, body)` 内，负责把 `meta.description` 序列化回 YAML 双引号字符串。
- 触发场景：
  1. **`seedFromZcode`**（`src/agent-manager.ts:292`）：`/agents` 首次打开且 `~/.dsh/agents` 为空时，把 `.zcode/agents/*.md` 解析后 `renderAgentMarkdown` 重写进 `~/.dsh/agents`。**本次 7→15 放大的直接发生地。**
  2. 仅此。`/agents` 界面本身的编辑只改 `model`/`thinking`/`deep`（`FrontmatterUpdates` 接口，`src/agent-manager.ts:208-212`，这三者走 `updateAgentFrontmatter` 就地改行，**不重写 description**），所以编辑保存**不会**再次触碰 description。
- `meta.description` 是否可能带引号被存回：会。`meta.description` 来自 `parseAgentMarkdown`，其值经 `stripQuotes` 后**仍可能保留前导引号/反斜杠**（见故障数据）。`JSON.stringify` 会把这些原样转义写回 → 反斜杠累积。

## 5. 最小修复建议

**根因在读路径 `stripQuotes` 太弱**（只剥不反转义）+ 写路径 `JSON.stringify` 把转义固化。
最小且正确的修复点是**让解析在剥引号时做一次真正的 YAML 双引号标量反转义**，从而：
(a) 显示时 `32` 个反斜杠不再出现在 UI；
(b) 切断 seed/save 反复 `JSON.stringify` 造成的指数增长。

### 建议 diff（`src/agent-manager.ts`，约第 106-113 行 `stripQuotes`）

在 `stripQuotes` 剥离外层引号后，对双引号包裹的值做 `\"`→`"`、`\\`→`\` 的反转义并迭代到不动点
（`15` 个反斜杠需多趟收敛；单趟 `\\`→`\` 会 15→7→3→1，多趟后到裸 `"`+文本或全裸文本）：

```ts
/** 反转义 YAML 双引号标量：\" → "，\\ → \，迭代到不动点。 */
function unescapeDoubleQuoted(value: string): string {
  let prev: string
  do {
    prev = value
    value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  } while (value !== prev)
  return value
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') return unescapeDoubleQuoted(value.slice(1, -1))
    if (first === "'" && last === "'") return value.slice(1, -1)
  }
  return value
}
```

> 说明：
> - 单引号 YAML 标量（`'…'`）无转义，保持现状；
> - 若想更保守、不让解析“改变已损坏但用户可能已接受的值”，可改为在**列表/字段渲染处**（`agents.ts` 的 `agentCell` 与 `showFields` 的 `meta.description` 使用点）对 `meta.description` 先做同样的反规范化。但**推荐修解析**，因为那才是数据源头，且能同时阻断 seed/写回的反斜杠增长。
> - 修复后应更新 `test/agent-manager.test.mjs`：新增“`\\\"牛马狗…`/多级反斜杠”用例并保持 `pnpm check`、`pnpm test` 绿（AGENTS.md 质量门禁）。

## 附：本仓库不读 `.pi/agent/agents`

`agentsDir()` = `~/.dsh/agents`（`src/agent-manager.ts:62-64`）。仓库内无任何 `.pi/agent` 引用
（全 `src/` 仅 `append-system.ts` 注释提到 `.pi` 的 `APPEND_SYSTEM.md`，不涉 agent 列表）。
用户背景里 `.pi/agent/agents/workhorse.md` 那份是干净的，本仓库渲染的是 `.dsh/agents/workhorse.md` 那份损坏数据。
