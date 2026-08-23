# CONTEXT.md — terminology

Shared vocabulary for this repo. Definitions only — implementation details
live in ARCHITECTURE.md / HANDOFF.md.

- **Favorite**: 用户标记为收藏的模型，以 provider/id 标识，持久意图，置顶显示
  (a model the user starred; identified by its provider/id composite key,
  persisted, pinned to the top of the picker)
- **Hidden model**: 用户隐藏的模型，从主列表移入底部 Hidden 区，可恢复
  (a model the user hid; moved out of the main list into the dim Hidden
  section at the bottom, restorable)
- **Filter**: 会话内临时子串过滤，不持久，每次打开面板重置
  (a session-local substring filter over the model list; never persisted,
  reset every time the panel opens)
- **Divider row**: 收藏区与普通区之间的不可选中分隔行
  (the full-width unselectable separator line between the Favorites section
  and the normal section)
