# NOTICE

## What this plugin does to your data

`dsh-deep-purge` **permanently deletes** session data. There is no recycle bin,
no undo, and no server-side copy. After a deletion, `bili` also runs `VACUUM`
on its SQLite index, which overwrites the freed pages — third-party recovery
tools will not get the rows back either.

Read this before your first deletion:

1. **Deletion is irreversible.** Sessions are removed from six on-disk
   locations; the transcript file itself is unlinked.
2. **DSH is closed and relaunched** as part of the flow. This is required, not
   cosmetic: DSH holds `workspace.json` in memory and rewrites the whole file
   on any sidebar change, so deleting it underneath a running DSH silently
   resurrects the session.
3. **The current session cannot be deleted.** Both the UI and the HTTP handler
   refuse it.
4. **Always dry-run first.** The dry run reports hit counts for all six
   locations and writes nothing.
5. **A backup is written by default** to
   `~/.dsh/session-delete-backup-<timestamp>/`, preserving original relative
   paths so `-Restore` can put everything back. `-NoBackup` disables this and
   makes the operation unrecoverable.
6. **Quit DSH before running `-Restore`**, or the in-memory `workspace.json`
   will overwrite the restored file.
7. **Do not run two DSH instances** against the same profile while deleting:
   both cache the registry in memory and the last writer wins.
8. **Windows only.** The script relies on PowerShell 5.1+, `Register-ScheduledTask`,
   and Win32 window messages to close DSH gracefully.

## Third-party components

This package bundles no third-party code. It calls into the host application
(DeepSeek Harness) only through its documented plugin surface:

- `webserver/index-inject` for the in-page script
- `webServer.register` for the local HTTP endpoints
- the client slot system (`sidebar.panellist`, `main`,
  `sidebar.workspaces.session.menu.item`)

The host application is **not** redistributed here and is **not** covered by
this package's MIT license. Use of DeepSeek Harness is governed by its own
terms. `dsh-deep-purge` is an independent, unofficial plugin and is not
endorsed by the DeepSeek Harness authors.

`billion-context` (`bili`) is likewise a separate project; this plugin only
invokes its CLI and edits its SQLite index. Its schema and CLI surface may
change without notice — if a future version moves or renames things, the
bili step will report a failure rather than corrupt data, and the remaining
five locations are still cleaned.

## Trademarks

"DeepSeek", "DeepSeek Harness" and "DSH" are used descriptively only, to
indicate compatibility. No trademark rights are claimed.
