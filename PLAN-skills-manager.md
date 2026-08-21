# Skills 分离 & `/skills-manager` 面板 — 实施计划

## 背景

当前 `~/.agents/skills/`（公共 skill）被 skill-filesystem 自动发现，无法控制哪些 skill 启用。
目标：
1. 停止自动发现 `~/.agents/skills/`
2. 只通过 `~/.dsh/skills/`（手选 symlink）加载 curated skill
3. 项目级 `.dsh/skills/` 和 `.agents/skills/` 继续生效
4. 从 `/settings` 移出 skill 管理，做成独立的 `/skills-manager` 面板

---

## Phase 1: 配置变更（一行，零代码改动）

**文件**: `~/.dsh/profiles/tui/cordis.patch.yml`

```yaml
- id: skill-filesystem
  config:
    agentsHome: ~/.dsh/agents
```

**原理**（已在 skill-filesystem 源码中确认）：
- `this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))`
- `roots.push({ path: join(this.agentsHome, 'skills'), ... })`
- → `agentsHome` 改为 `~/.dsh/agents` 后，扫描路径变为 `~/.dsh/agents/skills/`
- → `~/.dsh/agents/skills/` **不存在** → `discoverRoot` 抛 `ENOENT` → 被捕获返回空数组
- → 项目级 `.dsh/skills/` 和 `.agents/skills/` 从 `findProjectRoot` 发现，不受影响

---

## Phase 2: 新建 `src/skills-manager.ts`（~150 行新代码）

### 2.1 从 `settings.ts` 提取 SkillsPanel

`settings.ts` 中 SkillsPanel 是完全自包含的 Component 类（~220 行），只依赖：
- `TUI` / `TuiTheme` / `Component`（来自 pi-tui）
- `SkillPanelRow` / `SkillJump` / `clampSkillCursor` / `filterSkillRows` / `isPrintableInput` / `skillJumpCursor` / `skillPanelRowLine`（来自 `skills.ts`）
- `panelThemeFns` / `clipToWidth` / `TABLE_SEP` / `tableRuleLine` / `tableHeaderLine` / `SettingsListPanel` / `columnWidths` / `padCell` / `MARKER_W` / `TableColumn`（来自 `panels.ts`）

**提取方案**：直接移至 `skills-manager.ts`，保持接口不变。

### 2.2 新增「Available」公共 skill 浏览 + Symlink 管理

SkillsPanel 增加**双模式切换**（Tab 键切换视图）：

| 视图 | 数据来源 | 操作 |
|------|---------|------|
| **Installed** | `ctx.skills.list()` — 当前已注册的 skill | Enter/Space 切换 enable/disable（同现有逻辑） |
| **Available** | `readdir('~/.agents/skills/')` 直接扫描文件系统 | Enter 执行 `ln -s` → 刷新列表 |

**Available 视图的交互细节**：
- 列表公共 skill（`~/.agents/skills/` 下的 `.md` 文件和目录 bundle）
- 每行显示：`●` 已安装（已存在 `~/.dsh/skills/` 中） / `○` 未安装
- Enter 时：`fs.symlink(src, dest)` 创建 symlink
- 自动创建 `~/.dsh/skills/` 目录（如果不存在）
- 操作后 `ctx.skills` 的 watcher 自动发现新 skill → 面板刷新

### 2.3 注册 `/skills-manager` 命令

在 `src/index.ts` 中，类似 `/permission` 的独立 overlay，不依赖 SettingsBrowser。

---

## Phase 3: 从 `/settings` 移除 Skills 类别

### 3.1 修改 `CATEGORY_MAP`

```typescript
// 移除 skills 类别
export const CATEGORY_MAP: readonly SettingsCategory[] = [
  { id: 'general', label: 'General', namespaces: ['permission', 'dsh-tui'] },
  { id: 'models', label: 'Models', namespaces: ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'] },
  { id: 'plugins', label: 'Plugins', namespaces: ['shell', 'agent-loop', 'web-search-deepseek'] },
  { id: 'agent', label: 'Agent Presets', namespaces: ['agent-presets'] },
  // Skills 删除
]
```

### 3.2 清理 SettingsBrowser 中的 skills 相关代码

删除以下内容（~80 行）：
- import 中的 skills 函数（部分移到 skills-manager.ts）
- `CATEGORY_MAP` 中的 skills 条目
- `categorizeNamespaces` 中的 skills 特殊分支
- `agent` 字段和 `SkillScopeAgent` 类型
- `skillsView` / `skillsExit` 字段
- `close()` 中的 skills 清理
- `categoryList()` 中的 skills submenu 分支
- `SKILL_DESC_MAX` 常量
- `openSkillsSubmenu` / `refreshSkillsList` / `buildSkillRows` / `diskToggleOverride` / `toggleSkill` 方法

---

## 文件变更清单

| 文件 | 操作 | 变更量 |
|------|------|--------|
| `~/.dsh/profiles/tui/cordis.patch.yml` | 编辑 | +1 行 |
| `src/skills-manager.ts` | **新建** | ~150 行 |
| `src/settings.ts` | 编辑 | -80 行（删除 skills 代码） |
| `src/index.ts` | 编辑 | +20 行（注册命令） |

---

## 实施顺序

```
Phase 1: 配置 (1 分钟)
  └─ 编辑 ~/.dsh/profiles/tui/cordis.patch.yml ✅
     (agentsHome: ~/.dsh/agents — 已存在)

Phase 2: 新建 skills-manager.ts (核心)
  ├─ 提取 SkillsPanel 类 + 相关 import ✅
  ├─ 添加 Available 视图 + symlink 功能 ✅
  └─ 注册 /skills-manager 命令 ✅

Phase 3: 清理 settings.ts
  ├─ 移除 CATEGORY_MAP 中的 skills ✅
  ├─ 删除 SettingsBrowser 中的 skills 相关代码 ✅
  └─ 清理 import ✅

Phase 4: 验证
  ├─ pnpm check (类型检查) ✅
  ├─ pnpm test (回归测试) ✅ (486/486)
  └─ 手动验证 /skills-manager 面板 ⏳ (待手动验证)
```

---

## 不做 & 不受影响的范围

- ✅ 项目 skill：项目 `.dsh/skills/` 和 `.agents/skills/` 继续生效
- ✅ Web profile：`agentsHome` 是 profile 级别配置，只影响 TUI profile
- ✅ `/skill` 命令 & autocomplete：通过 `ctx.skills` 工作，不受影响
- ❌ 不改 `~/.agents/skills` 目录结构
- ❌ 不改 skill-filesystem 源代码
- ❌ 不改 `discoverRoot` 逻辑