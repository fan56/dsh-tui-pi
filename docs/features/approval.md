# Tool approvals

The terminal interface answers `approval/request` for its active session. It shows the tool name, reason, call ID, and matching tool arguments. Use PgUp and PgDn to read long details.

Deny is selected when the panel opens. Press Enter to deny. Press Down or 2 to select Allow once, then Enter to confirm. Press Escape, Ctrl+C, or 1 to deny. Pasted text cannot approve a request. Approval panels have no automatic answer or timeout.

Questions and approvals share one dialog queue. Only one panel takes the keyboard at a time. A cancelled request closes its panel or leaves the queue without opening. UI teardown cancels pending dialogs. Requests for another session remain available to other approval interfaces.

The permission service records each decision in the session log. Allow once applies to that request only. This interface does not grant standing permission or change the session's permission mode.

## Validation

The patch passes TypeScript and 1,475 automated tests, including 17 approval tests and six queue tests. Approval tests cover default denial, explicit consent, cancellation, paste handling, session routing, teardown, long details, and terminal resize.

Live tests used dsh 0.2.1-rc.2, Node 24.14.0, and herdr 0.9.5 in a disposable profile. The session log recorded allowed-once and rejected outcomes. The allow test wrote one temporary marker. Denial left its timestamp unchanged. The panel remained interactive after resizing the terminal from 40×119 to 24×80. Structured questions still opened after approval decisions and resize.
