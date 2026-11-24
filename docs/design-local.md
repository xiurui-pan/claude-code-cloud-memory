# Design: local Claude Code (CLI and desktop) support

Status: implemented in `worker/memsync.py` (local mode), tests in `tests/test7.mjs`. Usage: [local.md](local.md). Builds on [design-cloud-v3.md](design-cloud-v3.md); the server is unchanged. Names in examples are generic.

## 1. Problem

The v3 client only works in cloud containers. A user who also runs Claude Code on a laptop or desktop has two separate memories: the cloud one (synced) and the local one (`~/.claude/projects/*/memory/`, `~/.claude/CLAUDE.md`). The client cannot simply be installed locally, because it assumes things that only hold in the cloud:

| Cloud assumption | Local reality |
|---|---|
| One fixed memory dir (`/root/memory`, forced by `autoMemoryDirectory`) | One native dir per project, several sessions in different projects at once |
| Fresh container, first pull may mirror the server | Existing local memory and a hand-written `~/.claude/CLAUDE.md` that must not be lost |
| A network proxy injects the token | Nobody injects it |
| `fcntl`, `/root`, `python3`, POSIX paths | macOS, Linux, Windows |
| The setup script writes `settings.json` | `settings.json` already holds the user's settings and hooks |
| One state dir, one lock | State per project, and global memory shared by all projects |

## 2. Findings (evidence)

- **Native dir.** The CLI's own settings schema says: `autoMemoryDirectory` "defaults to `~/.claude/projects/<sanitized-cwd>/memory/`" (read from the CLI 2.1.331 bundle). The sanitizer is `path.replace(/[^a-zA-Z0-9]/g, "-")`, paths over 200 characters are cut at 200 and get `-` plus the base-36 absolute value of the Java-style string hash of the full path. It does not depend on the OS: `C:\Users\dev\my repo` becomes `C--Users-dev-my-repo`.
- **Which path.** Earlier probe runs with the CLI (kept in git history, `docs/design-v2-layers-and-local.md` at `b2f1284`) measured that the path that is sanitized is the git root of the launch directory, the main worktree root for a linked worktree, the launch directory itself outside git. A submodule checkout is its own root. The project root is fixed at session start; `cd` and `--add-dir` do not change it. One session therefore reads exactly one memory dir. Not re-measured for this change (needs a live model session); `memsync.py where <dir>` prints what the client assumes, and `autoMemoryDirectory` or `MEMSYNC_DIR` override it.
- **Timing.** On `startup` the CLI may read `MEMORY.md` concurrently with, and before, the SessionStart hook (same earlier probes). Files written by a pull are on disk for the first read of a topic file, the index can be one session late. In cloud the host waits for the hook.
- **Hooks** get `session_id`, `cwd`, `hook_event_name`; the env has `CLAUDE_PROJECT_DIR` (launch directory). Stop and SessionEnd show the live shell cwd, so the client keys on `CLAUDE_PROJECT_DIR`, not the hook cwd.
- **Server semantics** (unchanged): pushing a file with no `base_sha` over an existing one is last-writer-wins; `MEMORY.md` and `global/CLAUDE.md` are line-merged from `added_lines` / `removed_lines`. A first sync therefore has to avoid pushing a different same-name file blindly, and can lean on the server's line merge for the two merged files.

## 3. Decisions

### 3.1 Native layout, no global `autoMemoryDirectory`

Local sessions in different projects run concurrently. A single overridden dir would mix every project's files in one place and need the cloud's rename-on-collision logic for unrelated repos. Instead the client works with the native layout: for a session it computes the native dir (section 2), uses it as the memory dir, and keeps state per dir. Claude Code sees an ordinary native memory directory. If the user has set `autoMemoryDirectory` in their user settings, every project writes into that one dir while the server keeps memory per project; syncing it would route one repo's files into another's project, so in that case only the global `CLAUDE.md` syncs and the dir is left alone (`where` reports `shared_dir: true`).

Cost: the client must compute the same path as the CLI. It is a pure function (`native_slug`, `canonical_git_root`) covered by tests including Windows-style strings, with `where` for checking and the two overrides above for when a CLI version changes the rule.

### 3.2 Project identity and non-git directories

Same as cloud: git root of `CLAUDE_PROJECT_DIR`, `origin` normalized to `host/owner/repo`, mapped to a project id by `/v1/resolve` (submodules still fold into their superrepo). Differences: no scan of subdirectories (locally that would sweep up unrelated repos in a parent folder), so a session maps to at most one project. A directory that is not a git checkout, or has no `origin`, gets no project memory (it stays native and local); only the global file syncs. The cloud's shared `_norepo` bucket is not used locally.

### 3.3 Mode switch, one file

`memsync.py` stays one file. Mode is `MEMSYNC_MODE` if set, else cloud when `CLAUDE_CODE_REMOTE` or `MEMSYNC_DIR` is set (what the cloud setup script provides), else local. Local mode rebinds the module-level paths (memory dir, state, base, layout, header, URL) in `local_setup` and swaps four functions (`load_base`, `save_base`, `make_layout`, `detect_workspace`) for thin wrappers; push, pull, merging and rendering code is shared. Cloud runs through the same functions with nothing rebound.

### 3.4 State, global memory, lock

- Per-dir state under `<config>/memsync/projects/<key>/` (`base.json`, `layout.json`, notify and status queue). `<key>` is the slug plus a hash of the dir path.
- The global file is one file for the whole machine, so its base lives in `<config>/memsync/global_base.json`, shared by all projects. The wrapper around `load_base`/`save_base` injects and extracts that entry so the existing push code sees one base.
- One machine-wide lock (`<config>/memsync/lock`) around every pull/push: flock on POSIX, `msvcrt.locking` on Windows, an `O_EXCL` lock file (stale after 60 s) when neither exists. Concurrent sessions in different projects serialize on it, which also protects `global_base.json` and `CLAUDE.md`. Local wait is bounded (20 s); on timeout the hook logs and exits 0 and the next Stop retries. Cloud keeps waiting indefinitely, as before. Sync calls are short (10 s request timeout).

### 3.5 First sync merges, never deletes

A dir with no `base.json` has never been synced on this machine. Instead of the cloud's mirror, `local_first_sync`:

1. Pulls the server state for the project and global.
2. Topic files: server-only files are written; local-only files stay; same name and same content is a no-op; same name with different content keeps the **server** version at the name and moves the local one to `<stem>.local.md` (`.local2` etc. if taken). Local index lines that pointed at the renamed file are rewritten to the new name. A local file the client could not read (too large) is moved aside before a server file takes its name. Originals go to `backup/<time>/`.
3. `MEMORY.md`: line union (server lines first, then local-only lines).
4. Global file: line union with the user's existing `~/.claude/CLAUDE.md` (server lines first), header prepended, original backed up. If another project on this machine already synced the global file, it is only refreshed from the server when there is no pending local edit; otherwise the normal push merges it.
5. Sets the base to the server state and runs the normal push, which uploads exactly the local-only files, renamed files and added lines.

After step 2-4 the local dir is a superset of the server state, so no deletion can be derived on either side. A same-name conflict is kept as two files rather than 3-way merged: topic files are free text with front matter and a line merge would interleave them.

Known cost: the user ends up with `<name>.local.md` files and duplicate-looking index lines to tidy up by hand (or by asking Claude).

### 3.6 Token

`MEMSYNC_TOKEN`, else `MEMSYNC_TOKEN_FILE`, else `token_file` from `config.json`, else `<config>/memsync/token`. `install --token-stdin` writes the last one with mode 0600 (`icacls` on Windows), so the token is never an argv item or in shell history. The token is never written to `settings.json` or `config.json` and never printed. A group/world-readable token file is used but logged as a warning.

### 3.7 install / uninstall

- `install --url U [--token-stdin | --token-file F]`: validate the URL, parse `settings.json` first (invalid JSON aborts with nothing written), copy the client to `<config>/memsync/memsync.py`, write `config.json`, merge hooks, back up `settings.json` as `settings.json.memsync-bak-<time>`, atomic write. Hooks are `SessionStart` pull (timeout 30), `Stop` push (30), `SessionEnd` push (15), as separate matcher groups; entries whose command contains `memsync.py` are replaced, everything else (other hooks, `env`, `permissions`, `autoMemoryDirectory`) is untouched. `autoMemoryDirectory` is never set.
- Hook command: `"<sys.executable>" "<script>" <pull|push>`. On Windows the paths use forward slashes inside double quotes, which Git Bash and cmd both accept.
- `uninstall [--purge]`: removes only our hook entries (and containers left empty), strips our header from `CLAUDE.md` keeping the user's text, `--purge` deletes `<config>/memsync/`. Memory files are never touched.
- Config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`.

### 3.8 Migration

Syncing a native dir on first use already uploads whatever it holds, so "migration" is mostly the first-sync rule. `migrate` covers dirs not yet opened since install: it scans `<config>/projects/*/memory/`, recovers each dir's real working directory from the `cwd` field of its newest transcripts (the dir name is lossy), maps it to a git repo with an `origin`, and with `--apply` runs the first sync for that dir. Dry run is the default. A dir whose cwd is gone, unknown, or not a git checkout is reported and skipped. A dir created by an older CLI that keyed on a subdirectory is synced as its own replica of the same project (the first-sync rules merge it with the server's files; the CLI will not read it, the canonical dir is the one in use).

### 3.9 Portability

Standard library only, `pathlib` for paths, POSIX separators on the wire, UTF-8 without BOM. `fcntl` and `msvcrt` imports are optional. Windows transcripts JSON-escape backslashes, so the `auto_memory` detection also matches the escaped path. Hook cwd name splits on both separators.

## 4. Not done / open

- The native-dir rule (git root) is taken from earlier probes and the bundle, not re-measured here.
- No mass-delete guard on pull yet (the cloud design has none either; v2 sketched one). After the first sync, a pull removes local files that another machine deleted on the server.
- Windows is covered by simulated-path tests on Linux, not by a Windows run.
- `--add-dir` workspaces and multi-repo parent folders are not mapped locally (one project per session).
- The startup race (section 2) is not mitigated; a delta note via `additionalContext` was designed in v2 but not built.
- Desktop-app specifics (whether it runs hooks from `~/.claude/settings.json` the same way) follow the CLI because the app embeds it; not verified in the app.
