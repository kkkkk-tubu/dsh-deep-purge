# Changelog

All notable changes to this project. This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-28

First public release.

### Added

- **Sidebar panel** (`sidebar.panellist`, order 45) — "会话清理 / Session purge" replaces the previous
  floating button. Registered as a `main` slot page, so it takes over the content area instead of
  overlaying it.
- **Session context menu entry** (`sidebar.workspaces.session.menu.item`, order 500) —
  "彻底删除会话 / Delete session permanently". Jumps straight to the panel with that session
  pre-selected.
- **First-run guide** — a blocking modal on the first open of the panel: what the plugin deletes
  (all six locations), the risk list, the five-step workflow, rollback, and uninstall. Requires
  ticking "I understand deletion is irreversible" before the button enables. Esc and clicking the
  backdrop do not dismiss it on first run. Version-gated via `localStorage`
  (`dsh.deep-purge.guide`), so raising `GUIDE_VERSION` re-shows it after the text changes.
- **Persistent warning bar** — always visible above the session list, with no close button:
  deletion is irreversible, DSH will quit and relaunch, the page drops for a few seconds. Links to
  the full guide.
- **Dry run** — reports hit counts across all six storage locations and writes nothing.
- **Backup + rollback** — every deletion writes `~/.dsh/session-delete-backup-<timestamp>/`
  preserving original relative paths; `-Restore <dir>` puts everything back byte-for-byte.
- **Auto-restart flow** — quits DSH via a scheduled task outside its Job Object, deletes, then
  relaunches. Falls back to a manual two-step command if DSH refuses to exit
  (`exit 3` = timed out, nothing touched).
- **Portable script** — no hardcoded install paths. DSH executable and `bili` entry point are
  discovered from `-HarnessExe` / `$env:DSH_HARNESS_EXE` / the running process / common install
  locations, so the package works on other machines.

### Changed

- Package renamed `dsh-session-purge` → **`dsh-deep-purge`** for npm availability.
- Colors now come exclusively from `--dsw-alias-*` design tokens. Hardcoded dark text on a light
  background made the panel unreadable in the light theme.

### Known limitations

- Windows only (PowerShell 5.1+, scheduled tasks, Win32 window messages).
- The current session cannot be deleted — the checkbox is disabled and the HTTP handler rejects it.
- DSH must restart for the delete to take effect; the panel cannot delete while it is running
  (DSH keeps `workspace.json` in memory and rewrites it wholesale).
