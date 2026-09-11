# Model profiles and favorites

Model profiles — named snapshots of a whole model setup — moved to the
[dsh-profile-switch](https://github.com/fan56/dsh-profile-switch) plugin:
`/profile-switch` binds the workspace tree to a profile and `/profile-cfg`
configures them through the host's ask-user flow, so the SAME commands work
on the TUI and the web surface. This plugin remains the TUI read side: new
sessions seed from the `.dsh-profile` pin, `/model` + `/think` ride the live
selection ref (exposed to dsh-profile-switch as the `dshTuiModelSelection`
bridge so a profile switch is live in the current conversation), `/agents`
edits stay scope-aware of the pin, and `/model` favorites + hidden lists
keep the picker small.

---

[← Back to README](../../README.md)
