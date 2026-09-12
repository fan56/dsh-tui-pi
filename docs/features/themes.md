# Themes

The TUI ships **20 built-in themes** (10 light + 10 dark) defined as JSON files under `themes/`, plus **user theme discovery**: drop a `.json` file into your user theme directory and it registers automatically — no restart, no config edit. `/theme` lists every registered theme (built-in and user), hot-swaps mid-session, and persists the choice in `settings.yaml` (`dsh-tui.theme`). `auto` detects your terminal and follows live light/dark switches; `DSH_TUI_THEME` pins a scheme by name.

*`/theme` mid-session — pick any registered theme; the choice persists in `settings.yaml`:*

https://github.com/user-attachments/assets/af4d6df9-e0b8-4146-ba88-c0159b01c209

---

## Built-in themes

`themes/` ships 20 palettes — 10 light, 10 dark:

| Light | Dark |
|---|---|
| `github-light` | `github-dark` |
| `one-light` | `one-dark` |
| `solarized-light` | `solarized-dark` |
| `gruvbox-light` | `gruvbox-dark` |
| `catppuccin-latte` | `catppuccin-mocha` |
| `tokyo-night-light` | `tokyo-night` |
| `ayu-light` | `nord-dark` |
| `material-light` | `dracula` |
| `nord-light` | `monokai` |
| `dracula-light` | `synthwave` |

All of them share one palette contract (15 base fields + 8 derived colors),
so every theme drives the same surfaces (canvas, message bubbles, think/tool
panels, borders, powerline accents).

## User themes

Put a `.json` file in your user theme directory and it registers the moment
the TUI starts (and on `/theme`). The name inside the file is the theme id;
a user theme with the same name as a built-in **overrides** it.

- **Default location:** `~/.dsh/themes/`
- **Honored root:** `$DSH_HOME/themes/` — when `DSH_HOME` is set, its
  `themes/` subdirectory replaces `~/.dsh/themes/`.

```sh
mkdir -p ~/.dsh/themes
# drop your-theme.json in there — done
```

## JSON file format

A theme file is plain JSON with **15 required** color/base fields plus
**8 derived** fields you may omit (they are computed from the required
ones). Every color is a `#rrggbb` hex string.

### Required fields

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Theme id, shown in `/theme` and used by `DSH_TUI_THEME` |
| `dark` | boolean | `true` = dark theme (components pick bright variants) |
| `canvas` | `#rrggbb` | Main background (chat canvas) |
| `canvasSubtle` | `#rrggbb` | Raised surface (bubbles, code blocks, panels) |
| `canvasInset` | `#rrggbb` | Inset surface (editor border row, footer) |
| `fgDefault` | `#rrggbb` | Body text |
| `fgMuted` | `#rrggbb` | Secondary text |
| `fgSubtle` | `#rrggbb` | De-emphasized text |
| `borderDefault` | `#rrggbb` | Default border (editor border, separators) |
| `borderMuted` | `#rrggbb` | Weak border (auxiliary lines) |
| `accent` | `#rrggbb` | Primary accent (selection, links, status) |
| `success` | `#rrggbb` | Success (completed todos, ✔ tool cards) |
| `danger` | `#rrggbb` | Danger (errors, ✘ tool cards) |
| `attention` | `#rrggbb` | Attention (in-progress todos, token limit) |
| `thinking` | `#rrggbb` | Thinking/reasoning block text |

### Derived (optional) fields

Omitted fields are blended from the required ones — solid approximations of
alpha tints over `canvas` (the terminal can't carry alpha):

| Field | Derivation |
|---|---|
| `accentMuted` | dark: `blend(canvas, accent, 0.25)` · light: `blend(canvas, accent, 0.18)` |
| `successMuted` | `blend(canvas, success, 0.25)` |
| `dangerMuted` | `blend(canvas, danger, 0.25)` |
| `attentionMuted` | `blend(canvas, attention, 0.25)` |
| `thinkingPanelBg` | dark: `blend(canvas, thinking, 0.25)` · light: `blend(canvas, thinking, 0.12)` |
| `toolPanelBg` | `accentMuted` |
| `panelBorder` | `borderDefault` |
| `panelBoxBorder` | `blend(canvas, accent, 0.70)` |

Explicit values always win: a file that spells out a derived field is used
as-is, never re-blended.

```json
{
  "name": "my-dark",
  "dark": true,
  "canvas": "#0d1117",
  "canvasSubtle": "#161b22",
  "canvasInset": "#010409",
  "fgDefault": "#e6edf3",
  "fgMuted": "#b1bac4",
  "fgSubtle": "#8b949e",
  "borderDefault": "#6e7681",
  "borderMuted": "#3d444d",
  "accent": "#79c0ff",
  "success": "#56d364",
  "danger": "#ffa198",
  "attention": "#e3b341",
  "thinking": "#d2a8ff"
}
```

An invalid file (bad JSON, a missing required field, a non-`#rrggbb` color,
a non-boolean `dark`) is skipped with a warning — it never crashes the TUI.

## Choosing a theme

- **`/theme`** — lists **every** registered theme (the `auto`/`light`/`dark`
  rows plus all 20 built-ins and your user themes). The selection persists to
  `dsh-tui.theme` in `~/.dsh/settings.yaml` and hot-applies.
- **`dsh-tui.theme` in `~/.dsh/settings.yaml`** — `auto` (follow the
  terminal) / `light` / `dark` / **any registered theme name**.
- **`DSH_TUI_THEME`** — pins the scheme at launch, outranking the preference:
  `light` / `dark` / any registered theme name (e.g. `DSH_TUI_THEME=dracula`).
- **`DSH_TUI_TRANSPARENT=1`** — makes the canvas see-through (reverts to the
  old transparent terminal background; default off).
- **`DSH_TUI_MOUSE=buttons|all|off`** — tunes mouse tracking (`buttons` is
  the default, click-to-focus only).

Unknown theme names fall back to terminal detection (`auto` semantics).

---

[← Back to README](../../README.md)
