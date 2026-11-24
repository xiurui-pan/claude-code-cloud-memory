# Local Claude Code (CLI and desktop app)

The same server and the same memory also work on your own machine (macOS, Linux, Windows; Python 3 standard library only). Local sessions keep Claude Code's native layout: project memory in `~/.claude/projects/<project>/memory/` (nothing overrides `autoMemoryDirectory`), global memory in `~/.claude/CLAUDE.md`. Design and evidence: [design-local.md](design-local.md).

```bash
# 1. get the client (any path), 2. install: copies it to ~/.claude/memsync/, writes the hooks into ~/.claude/settings.json
curl -fsS https://memory.example.com/client/memsync.py -o memsync.py
printf '%s' "$MEMORY_TOKEN" | python3 memsync.py install --url https://memory.example.com --token-stdin
```

Windows (PowerShell): `Invoke-WebRequest https://memory.example.com/client/memsync.py -OutFile memsync.py`, then `$env:MEMORY_TOKEN | python memsync.py install --url https://memory.example.com --token-stdin`.

- **Token.** There is no proxy to inject it locally. `--token-stdin` writes it to `~/.claude/memsync/token` (mode 0600 on POSIX, restricted with `icacls` on Windows); `--token-file <path>` records an existing file instead; the `MEMSYNC_TOKEN` environment variable (where Claude Code is started) also works and wins. The token never goes into `settings.json`.
- **Hooks.** `install` merges three hooks (`SessionStart` pull, `Stop` and `SessionEnd` push) into the user `settings.json`, keeps every other setting and hook, and saves a `settings.json.memsync-bak-<time>` first. Re-running it updates the entries. A settings file that is not valid JSON is left alone.
- **First sync only merges.** The first time a project (or the global file) is synced on a machine, local and server content are unioned and nothing is deleted on either side: files that exist only on one side are copied across, a same-name file with different content keeps the server version at its name and your local version as `<name>.local.md`, `MEMORY.md` and `CLAUDE.md` become line unions. The originals are saved under `~/.claude/memsync/projects/<key>/backup/`.
- **Existing memory.** `python3 ~/.claude/memsync/memsync.py migrate` lists every `~/.claude/projects/*/memory/` that maps to a git repo with an `origin` (via the `cwd` recorded in its transcripts); `migrate --apply` syncs them all now. Projects you simply open are synced by the hooks on their first session. Directories that are not git checkouts keep their memory local; they only get the global file.
- **Check and remove.** `memsync.py where [dir]` prints the memory directory and project of a directory. `memsync.py uninstall` removes the hooks and the header it added to `CLAUDE.md`; `--purge` also deletes `~/.claude/memsync/` (config, token, state). Memory files are never touched.
- **Limits.** Several sessions on one machine are serialized by a file lock. On session start the CLI may read `MEMORY.md` before the hook has pulled, so a fresh pull can show up one session late. `MEMSYNC_LANG=zh` switches the hook messages to Chinese.
- **Shared memory dir.** If your user-level `settings.json` sets `autoMemoryDirectory` (one dir for every project), project memory is not synced, only `CLAUDE.md`; `memsync.py where` shows `"shared_dir": true`.
