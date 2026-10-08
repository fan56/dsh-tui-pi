# Plugin manager

`/plugins` manages the profile's plugin bundles in the terminal — the counterpart of the web profile's plugin page, over the same base `pluginManager` service (the web-only pages are not required).

## The bundle table

Every bundle the profile knows arrives as one row — plugin name with its installed version, and a STATE column (`on` / `off` / `available` plus `⚠ error` or `· read-only` badges). The list is alphabetical and filterable: `/` engages the same keyword filter as the `/model` picker.

| Key | Action |
|---|---|
| `Enter` | Toggle the bundle on/off |
| `i` | Install a plugin by spec |
| `d` | Uninstall (behind a one-line confirm) |
| `/` | Filter the table |
| `Esc` | Close |

Read-only rows (not addressable from this profile) and error-flagged rows refuse the toggle; bundles that ship with the installation itself refuse the uninstall.

## What a change reports

Every operation lands on the in-panel status line with the service's application outcome:

- **applied now** — the change is live (hot reload kicked in);
- **takes effect at the next start** — the profile reloads at the next launch;
- **overridden** — another patch overrides this setting;
- **failed** — with the management error's message (network, pnpm, registry…).

## Installing

`i` opens a one-field editor: type a spec — an npm package name, a git URL, a local path or a tarball — and press `Enter`. The flow inspects the spec first (the same preview the web page shows: name, version, description, whether it declares a bundle patch); a refusal names the problem (`not-found`, `already-installed`, `network`, …). A accepted spec installs with activation on; pnpm runs in the profile directory under the manager's file lock, and a failed run restores `package.json` / `pnpm-lock.yaml` itself.

> Updating a plugin is uninstall + reinstall — there is no in-place update operation in the service (the web page says the same).

---

[← Back to README](../../README.md)
