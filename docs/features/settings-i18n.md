# Settings browser & UI languages

`/settings` opens a modal, searchable settings browser over the running dsh's
settings — the terminal counterpart of the web GUI's settings page. Every edit
goes through the settings service's revision-checked mutate path, so what you
see is always the service's resolved truth, and every namespace's "reset to
defaults" sits at the top of its own list.

## Layout

- **First level — alphabetical categories**: `Agent Presets · General ·
  Models · Plugins · TUI`. The TUI's own namespace is a first-class category
  that drills straight into its fields; settings namespaces registered by dsh
  plugins group under **Plugins**. (Anything unknown would fall into an
  *Other* catch-all, hidden while empty.)
- **Models** lists one row per configured provider — label, the provider's
  **configured model ids** as the value column (empty when none are
  configured), API-key state in the description — plus rows for the DeepSeek
  namespace and the default model, and an **Add provider** flow (built-in
  directory → one API key → write; the same two writes the web Models page
  performs).
- **TUI** carries a **Subagent** group row: the subagent knobs
  (`maxAgents` / `maxRounds` / `maxRoundsGrace` / `disableSubagent` /
  `registeredOnly`) live one level down instead of sitting flat in the list.
  This is display-only grouping — the settings file keeps its flat shape and
  every path stays where it was.

Type to filter at any level; `Esc` pops back one level (and clears the filter
first). Values that are booleans or fixed vocabularies cycle in place with
`Enter`; free-form values open an inline editor; secrets are masked and never
echoed.

## Editing model

Reads always come from the settings service, never a local snapshot: a
committed write re-reads the descriptor and repaints the row from the
resolved value. Writes are serialized per browser session (rapid consecutive
edits never conflict with themselves), a failed write reverts the on-screen
row and surfaces the error, and namespace/group rows carry an explicit
confirm-to-reset action.

## UI languages

Every user-visible string resolves through an i18n catalog: one flat JSON per
language under `locales/` (`en` is the canonical template; `zh-CN`, `ja`, `ko`
ship translated). `/language` asks through the native ask-user panel — the
installed languages become one question, current one first, answerable from
any surface (the TUI, or a phone through dsh-feishu); `/language <id>`
switches directly. Switching applies live (the next repaint speaks it) and
persists to `dsh-tui.language`.

Adding a language — or partially overriding a shipped one — is one file, no
code: drop `<id>.json` into `~/.dsh/locales/`. A same-id file merges per key
over the bundled one; a new id registers as a new language. The test suite
guards the contract: every `t('…')` literal must exist in `en.json` and every
bundled locale must carry exactly en's key set and `{param}` placeholders.

Known edges: `/settings` schema descriptions resolve at boot (restart to
re-translate those); already-rendered transcript rows keep the old language
until a rebuild.

---

[← Back to README](../../README.md)
