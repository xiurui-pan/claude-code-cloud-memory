# Design v2: memory layers, project grouping, local support

Status: draft for review. Nothing in this document is implemented. Names in examples are generic (`github.com/acme/platform` is a superrepo with submodules `acme/api` and `acme/web`).

Findings about Claude Code (CLI 2.1.331) that this design rests on are marked **[CLI]**. Places where the CLI behaves differently from the first sketch of this design are marked **CORRECTION**.

## 1. Goals

The experience must feel exactly like native auto-memory. Concretely:

1. Claude sees one ordinary native memory directory (`MEMORY.md` plus topic files). No custom tools, no custom prompt text beyond one short hook-injected note about `scope`.
2. The same memory follows the user across cloud sessions, local CLI sessions, several machines, and several windows on one machine.
3. Memory has two layers: **global** (preferences that hold everywhere) and **project** (facts about one codebase). A project preference does not clutter unrelated projects, and a global preference is never "forgotten" because a session happened to be in another project.
4. A superrepo and its submodules are one project. A session that only touches a submodule still lands in the parent project.
5. Failure never damages data: first sync merges, mass deletes are refused, every write keeps history.
6. Internal complexity is acceptable if it stays invisible. Anything the user must do is a one-time install.

Non-goals: auto-updating the client, claude.ai chat access (separate roadmap item), real-time sync inside a running turn.

## 2. How Claude Code actually locates and reads memory

Measured by reading the bundle and by running the CLI with probe hooks (stream-json mode, a throwaway config dir, `CLAUDE_CODE_REMOTE=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` where noted). The full evidence is in the research report that accompanies this draft; the facts the design depends on:

| Fact | Consequence |
|---|---|
| **[CLI]** Default dir is `<base>/projects/<slug>/memory/`, base = `CLAUDE_CODE_REMOTE_MEMORY_DIR` or the Claude config dir (`CLAUDE_CONFIG_DIR`, default `~/.claude`). | memsync must compute the same path or read it from settings. |
| **[CLI]** `slug = path.replace(/[^a-zA-Z0-9]/g, "-")`; if longer than 200 chars: `slug[:200] + "-" + abs(javaStringHash(path)).toString(36)`. Hash is over the unsliced path (UTF-16 code units, `h = 31*h + c`, 32-bit signed). | Deterministic, identical on Windows (`C:\Users\x\repo` becomes `C--Users-x-repo`). Drive-letter case is preserved, so `c:` and `C:` are different dirs. |
| **[CLI]** The path that is slugged for memory is the **git root of the session's project root** (project root = launch cwd), and for a linked worktree the **main worktree root**. Outside git it is the launch cwd. A submodule checkout is its own git root. | Memory dir is **not** the same as the transcript dir. The transcript dir slugs the launch cwd itself. |
| **[CLI]** Project root, and therefore the memory dir, is fixed at session start. `cd` inside the Bash tool, `--add-dir`, `/add-dir` and `permissions.additionalDirectories` do not change it and do not load extra memory dirs. | One session = one native dir. All layers must be materialized into that one dir. |
| **[CLI]** Cloud sessions started from a non-git parent dir (`/home/user`) therefore all share one native dir (`~/.claude/projects/-home-user/memory`), whatever repos are attached. | The cloud already behaves as "one global dir"; layering is done entirely by memsync. |
| **[CLI]** `autoMemoryDirectory` is read from policy, flag, user settings (and local/project settings only if allowed; the CLI marks project-level use as ignored for security). | Cloud keeps working with the existing override. Local does not set it. |
| **[CLI]** MEMORY.md (the "AutoMem" file) is read once when the first prompt context is built, memoized, and re-read only after `/compact` or auto-compact, `/clear`, `--resume`/`--continue` (new process), a directory move, or a worktree enter/exit. It is truncated to 200 lines / 25,000 bytes. | Mid-session pulls change files on disk but not the index Claude already holds (see 6.4). |
| **[CLI]** **CORRECTION (timing).** On `source=startup`, the index is read concurrently with the SessionStart hooks and, in every local probe, **before** a hook's write landed (hook finished in 58 ms, file still read stale; also with a 10 s delay before the first message). On `resume` and `compact`, the index is read **after** the hook and sees its write. | A pull at `startup` may be one session behind. Design adds a delta note (6.3). The README claim "the hook write is in place for the first turn" held in observed cloud sessions but is not a guarantee of the CLI. **Re-tested in a fresh cloud container:** the hook pulled at startup and the model quoted the full pulled index (including a line that existed only on the server) on its first turn, so in cloud the host waits for SessionStart hooks before the first prompt. The race is local-only; the delta note covers it. |
| **[CLI]** SessionStart hooks can return `hookSpecificOutput.additionalContext`; the model receives it (verified: a codeword was echoed). | Used for the `scope` note and the index delta. Nothing is written to any CLAUDE.md. |
| **[CLI]** Hook input has `session_id`, `transcript_path`, `cwd`, `hook_event_name` (+ `source` on SessionStart, `reason` on SessionEnd, `prompt` on UserPromptSubmit, `last_assistant_message` on Stop). Hook env has `CLAUDE_PROJECT_DIR` (the project root = launch cwd, not the git root), `CLAUDE_CONFIG_DIR`, `CLAUDE_ENV_FILE` (SessionStart only). | See workspace detection (4). |
| **[CLI]** Hook `cwd`: SessionStart and UserPromptSubmit show the launch cwd; **Stop and SessionEnd show the live shell cwd** (observed `cd` into a sibling repo, then Stop saw it). The Bash tool resets the shell cwd when it leaves the working directories, so Stop's cwd only follows `cd` into the launch dir's subtree or an added dir. | Matches the observation that motivated the routing rule. It is a best-effort signal, not an identity. |
| **[CLI]** SessionStart `source` is one of `startup`, `resume`, `clear`, `compact`, `fork`. `--resume` keeps the same `session_id`. | memsync keys per-session state by `session_id`. |
| **[CLI]** Added dirs are **not in hook input, hook env or settings-at-start** when added by flag/`/add-dir`. They are recorded in the transcript as an `attachment` of type `environment` with `snapshot.additionalWorkingDirectories`, written when the first user message is processed, and re-announced when the set changes ("Additional working directories added/removed"). | Authoritative source for the workspace, available from UserPromptSubmit/Stop onward, not at SessionStart (4.2). |
| **[CLI]** The native memory tooling is plain file writes by the model (Write/Edit). The CLI does not parse or rewrite topic-file frontmatter, so `metadata.scope` is preserved verbatim. Native subdirectory: `memory/proposals/` (skill proposals). Background "auto-dream" consolidation can rewrite memory files after a turn. | Exclude `proposals/` from sync; SessionEnd push must also run after dream rewrites. |
| **[CLI]** An unreleased built-in memory sync exists (watcher, org/team/personal stores) gated by `CLAUDE_MEMORY_STORES` (JSON env) or the `tengu_moth_copse` flag; it reserves `<config>/memory/personal`. | Never set `CLAUDE_MEMORY_STORES`; never write under `<config>/memory/`. Re-check on each CLI upgrade (risk 3). |

## 3. Layering model

Server paths:

```
global/MEMORY.md                  global index (one line per global memory)
global/<name>.md                  global topic files
projects/<pid>/MEMORY.md          project index
projects/<pid>/<name>.md          project topic files
unassigned/<name>.md              project-scoped files whose project could not be determined
```

`<pid>` is a short stable id (`pj_3f9a1c`) from the `projects` table, not the remote URL, so merges and renames only touch the table plus a path-prefix rewrite. Layer files are what the server stores; **the client never sees the layer split**: it materializes a composed view (section 6).

Rules:

- Global = user and feedback memories that hold in every project (tone, workflow, tool habits).
- Project = facts about a codebase (architecture decisions, who owns what, incident notes), plus preferences that only make sense there.
- Routing wrong toward project is the worse mistake for "native feel" (a preference silently missing in another project reads as forgetting). Wrong toward global costs a few index lines. Every fallback therefore biases to global.

## 4. Project identity and workspace detection

### 4.1 Identity

`project key` = normalized git remote URL of `origin` (fallback: the only remote; none = no project, files stay global-only for that repo):

```
git@github.com:Acme/Platform.git      -> github.com/acme/platform
https://tok:x@github.com/Acme/Platform.git/ -> github.com/acme/platform
ssh://git@github.com:22/acme/platform -> github.com/acme/platform
```

Steps: strip scheme, userinfo and port, convert `host:owner/repo` to `host/owner/repo`, strip trailing `/` and `.git`, lowercase. Credentials never leave the machine un-normalized.

### 4.2 Superrepo and submodules are one project

Membership is learned from `.gitmodules`, not from checked-out submodule dirs (cloud clones attach each repo as its own top-level clone, and the superrepo's submodule directories may be empty; submodule paths can differ from repo names, e.g. path `chat-prod` for repo `acme/chat`).

- Any session that sees a repo containing `.gitmodules` parses every `url =` line (relative URLs resolved against the superrepo's remote), normalizes them, and reports `{parent: "github.com/acme/platform", children: ["github.com/acme/api", "github.com/acme/web"]}` to `POST /v1/resolve`.
- The server stores one row per child in `project_members` (child repo -> parent project). The parent repo's own project is created on first report.
- A session that attaches only `acme/api` (no superrepo) resolves through `project_members` to the parent project.
- A repo can have one parent. A report that contradicts an existing row is recorded as a conflict and shown in the admin UI; the older row keeps winning.
- **Late membership**: if `acme/api` already has its own project (memories written before anyone reported the superrepo), the report triggers a reparent: the child project's files move into the parent (section 8.3), with history.
- Admin UI can merge two projects or split one repo out manually.

### 4.3 Workspace = set of repos for this session

Single code path for cloud and local:

```
workspace_dirs = [primary] + additional dirs
primary        = CLAUDE_PROJECT_DIR (launch cwd)   # not hook cwd
```

Additional dirs, best source first:

1. **Transcript snapshot** (authoritative, covers `--add-dir`, `/add-dir`, SDK/desktop/cloud host additions): read the newest `attachment.type == "environment"` record in `transcript_path` and take `snapshot.additionalWorkingDirectories`. Available from the first UserPromptSubmit on, and updated when the CLI re-announces changes.
2. **At SessionStart** (transcript snapshot does not exist yet): `permissions.additionalDirectories` merged from user, project and local settings, plus `--add-dir` arguments read from the parent process command line (`/proc/<ppid>/cmdline` on Linux, `ps -o args= -p` on macOS, PowerShell `Get-CimInstance Win32_Process` on Windows). Best effort; failures are silent.
3. **Cloud fallback**: if the primary dir is not inside a git repo (cloud sessions start in `/home/user`), scan git repos exactly one level below it.

How the hosts pass additional dirs **[CLI]**: the CLI flag is `--add-dir`; the Agent SDK option `additionalDirectories` is turned into `--add-dir` arguments; the SDK `init` message echoes `additional_directories` (not delivered to hooks); cloud adds folders through a host control request (`add_directory`, mount paths under `/uploads/N` for uploaded folders) and the env marker `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. The desktop app runs the CLI as an SDK host (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`/`local-agent`), so its multi-folder sessions should arrive as `--add-dir`; how many folders its UI can attach could not be verified from the binary (open question 3). The same detection works either way because it reads the CLI's own record.

Mapping: for each workspace dir, `git rev-parse --show-toplevel` (a dir with no `.git` is skipped), read `origin`, normalize, read `.gitmodules` if present. Then `POST /v1/resolve` with all repo URLs and membership reports; the server returns `{repo -> pid}`. Dedupe by pid. The result is `workspace.projects = [pid, ...]` plus `workspace.primary_pid` (the project of the primary dir, else the first).

Refinement during the session: SessionStart computes the workspace from sources 2/3. At each UserPromptSubmit and Stop, memsync re-derives it from source 1; if new projects appeared it pulls their layers (6.4).

## 5. Where the native dir is

memsync resolves the native memory dir once per session and stores it in `state/sessions/<session_id>.json` (Stop/SessionEnd hooks look it up by session id; they must not recompute from their own `cwd`).

Order: `autoMemoryDirectory` from user/policy settings (cloud) -> `CLAUDE_CODE_REMOTE_MEMORY_DIR` + `projects/<slug>/memory` -> `<config dir>/projects/<slug>/memory` with `slug(git_root_canonical(CLAUDE_PROJECT_DIR))` per the algorithm in section 2. Canonical git root: `git rev-parse --git-common-dir` parent for linked worktrees. If `CLAUDE_CODE_PROJECT_DIR_NAME` is set (valid `[A-Za-z0-9_-]{1,64}`), it replaces the slug.

**CORRECTION** to "cloud stops forcing `autoMemoryDirectory=/root/memory`": it can stop. A cloud session started in `/home/user` already gets one stable native dir, `~/.claude/projects/-home-user/memory`, and sessions started inside a git repo get that repo's dir. Because the container is fresh every time, per-project native dirs give no benefit and risk surprises (a session cwd inside a repo gives a different native dir than one in `/home/user`; memsync would have to materialize into both). Recommendation: keep `autoMemoryDirectory=/root/memory` in cloud for phase 1 (zero change to the dir), switch to the computed path only if the native-dir computation proves reliable in phase 3. Local never sets it.

## 6. Pull

### 6.1 Algorithm (SessionStart, and UserPromptSubmit when throttled)

Under the state lock (7.1):

1. Build the workspace (4.3) and `POST /v1/resolve`.
2. `GET /v1/pull?projects=<pid1>,<pid2>` returns `global/*` plus each project's files (and `unassigned/*` is not returned).
3. Push first if a base exists and local changes are pending (same container or machine resume must not lose edits).
4. For each file compute the **local name** (6.2), write it to the native dir, update `base.json` (server sha per server path) and `layout.json` (local name -> server path, layer; index line -> layer).
5. Compose `MEMORY.md` (6.3) and write it.
6. First sync (no base): merge, never mirror (8).

### 6.2 Local names and collisions

Server names are used as local names. If a project file's name equals a global file's name or another selected project's file, the later one is materialized as `<stem>.<pid>.md` and its index link is rewritten. `layout.json` records the mapping so push reverses it. Claude never needs to know.

### 6.3 Compose MEMORY.md

```
global/MEMORY.md
- [Terse replies](feedback_terse.md) - answer first, no recap
- [User role](user_role.md) - platform engineer, strong Go

projects/pj_3f9a1c/MEMORY.md           (github.com/acme/platform)
- [Deploy freeze](project_freeze.md) - freeze starts the 28th
- [Billing owner](reference_billing.md) - billing code is owned by api team
```

composes (global first, then the primary project, then other workspace projects) into one plain list with no headers, exactly like a hand-written native index:

```
- [Terse replies](feedback_terse.md) - answer first, no recap
- [User role](user_role.md) - platform engineer, strong Go
- [Deploy freeze](project_freeze.md) - freeze starts the 28th
- [Billing owner](reference_billing.md) - billing code is owned by api team
```

Limits: the CLI truncates at 200 lines / 25,000 bytes, so memsync composes at most 190 lines / 24,000 bytes: all global lines, then project lines newest-modified first. Lines that do not fit are recorded in `layout.json` as `hidden` and are **not** treated as deleted at push. If anything is hidden, the last line is `- (N older project notes not shown; ask to list memory files)`; that line carries no link and is stripped at push.

Startup staleness (section 2, timing CORRECTION): when the session `source` is `startup` and the composed index differs from what was on disk before the hook ran, the SessionStart hook returns `additionalContext` with the added lines ("Memory index lines added from other sessions since your index was loaded: ..."), capped at 40 lines. On `resume`/`compact` the CLI re-reads after the hook, so no note is needed.

### 6.4 Mid-session pull (UserPromptSubmit, at most every 5 minutes)

Same pull, run only when `now - last_pull >= 300 s` or the transcript snapshot shows a new project. Files on disk update; Claude reads topic files on demand, so those changes are visible. The in-context index does not change until the next compact/clear/resume **[CLI]**, so the hook returns the new index lines as `additionalContext` (same format as the startup note), capped at 20 lines. A pull never overwrites a file that has unpushed local edits: it pushes first, and if the server returns a conflict it keeps the local version (the server version stays in history).

## 7. Push

### 7.1 Locking and concurrency on one machine

One cross-platform lock per state key (`sha1(native dir)`): `fcntl.flock` on POSIX, `msvcrt.locking` on Windows, with an `O_EXCL` lockfile fallback (stale after 60 s, holder pid recorded). Push-then-pull runs inside one lock acquisition. Several windows in one native dir therefore serialize; windows in different native dirs share the server and rely on the server rules below. Lock wait is bounded (20 s); on timeout the hook exits quietly and the next Stop retries.

### 7.2 Routing (Stop, SessionEnd)

For each local file other than `MEMORY.md` and `proposals/**`:

1. **Existing file**: keeps its layer from `layout.json`. Exception: if its frontmatter `metadata.scope` now disagrees with the recorded layer, the file moves (explicit intent from Claude).
2. **New file**, in order:
   1. `metadata.scope` is `global` -> global; `project` -> project of the repo that contains the hook's `cwd` if it is in the workspace, else the primary project; `project:<handle>` -> that workspace project.
   2. Fallback by `metadata.type`: `user`, `feedback` -> global; `project` -> project; `reference` -> project only if the body mentions a workspace repo name or path, else global; missing or unknown type -> global.
   3. Project chosen but undeterminable (hook cwd outside every workspace repo, several projects, no explicit handle) -> `unassigned/`.

The primary mechanism is step 1: SessionStart's `additionalContext` carries one short note, regenerated per session:

```
When you save a memory, add `scope` under `metadata` in its frontmatter:
  scope: global            applies in every project (preferences, how the user works)
  scope: project           about the current repo's project
  scope: project:<handle>  about another project of this workspace; handles: platform, tools
If unsure, use global.
```

Type-based fallback exists because Claude will sometimes omit `scope`. About a third of existing `feedback` memories are project-specific, so type alone is a weak signal and is never preferred over an explicit scope. `unassigned/` files stay on the machine in `layout.json` with layer `unassigned`, remain in the local composed index for this session, and are not served to other sessions until an admin assigns them (admin UI). They are never silently made global.

### 7.3 MEMORY.md split

For each line of the local `MEMORY.md`: find the link target `(<file>.md)`, map it to a layer through `layout.json` (new files use the routing result), and diff against the base per layer. The server request carries, per layer index, `added_lines` and `removed_lines` (the existing 3-way mechanism, `mergeIndex`). Lines without a link keep the layer they were composed from; a new unlinked line goes to the layer of the preceding linked line, else global. A line whose file disappears locally is a removal in that layer.

Example: Claude adds `- [Retry policy](project_retry.md) - 3 tries, 200 ms` and `- [No emoji](feedback_noemoji.md) - none` with scope fields `project` / `global`. Push sends `projects/pj_3f9a1c/MEMORY.md added_lines=[retry line]` and `global/MEMORY.md added_lines=[no-emoji line]`. A second window that pushes other lines in parallel does not lose them: the server applies line diffs on top of its current text.

### 7.4 Machine and session

Every push and status event carries `machine` (hostname slug plus an id stored in `state/machine.json`). History rows record it, and the admin UI shows it.

## 8. First sync, safety, and migration of existing local memory

### 8.1 First sync merges

With no `base.json` for a native dir:

- Local only: push as new files.
- Server only: write locally.
- Both, same content: record base.
- Both, different: keep the newer by (local mtime vs server `modified`), save the loser to `state/backup/<timestamp>/<name>`, and report both in the hook `systemMessage`.
- `MEMORY.md`: union of lines (empty base makes every line an added line).
- No local file is ever deleted on a first sync.

### 8.2 Mass-delete guard

Before sending deletions (push) or removing local files (pull), count them. If more than 5 files or more than 30 % of `base.json` files would go, drop **all** deletions from that operation, still process other changes, write a warning to `state/sync.log` and a `systemMessage`. Resume with `memsync.py push --allow-delete` or `pull --allow-delete`. Same guard server-side: `POST /v1/push` refuses a request whose deletions exceed the same thresholds unless `allow_delete: true`.

### 8.3 Reparent and merge on the server

Moving project A into project B (late membership report, or admin merge):

1. Inside one transaction batch, for each file of A: new path under B. Name collision: rename to `<stem>.from-<A>.md` and add the matching index line rewrite.
2. Copy history rows to the new path (`moved_from` column keeps the origin), write a tombstone row for the old path.
3. Merge `MEMORY.md` as the union of lines (links rewritten for renamed files).
4. Update `project_members`, mark A merged into B (`projects.merged_into`), so later reports for A resolve to B.

Clients are unaffected: their next pull returns the files under B, and `layout.json` entries pointing to A are re-resolved through `merged_into`.

## 9. Local install

Command surface (`memsync.py`, standard library only):

| Command | What it does |
|---|---|
| `install --url U [--token-file P]` | Download the client into `<config>/memsync/`, write the token file, merge hook entries into `<config>/settings.json` (existing hooks kept, a timestamped backup written), run `migrate --dry-run`. |
| `uninstall [--purge]` | Remove only hook entries whose command contains `memsync.py`; `--purge` also deletes state and backups, never memory files. |
| `migrate [--apply]` | Dry run by default: scan `<config>/projects/*/memory/`, map each dir to a project by its `.git` remote (dir slugs are lossy, so memsync reads each project's recorded cwd from transcript `cwd` fields), print where each file would go, and for conflicts the merge plan. `--apply` performs the first-sync merge (8.1) per dir. |
| `update` | Fetch `/client/memsync.py`, verify it compiles, replace atomically, keep the previous copy as `memsync.py.prev`. |
| `pull`, `push` | Hook entry points. |

Portability requirements: no `fcntl` import at module level; `pathlib` everywhere; paths JSON-escaped in transcripts are decoded before `auto_memory` detection (Windows transcripts contain `C:\\Users\\...`); hook command uses the absolute `sys.executable` and absolute script path, quoted for the host shell (`"C:\Python312\python.exe" "C:\Users\u\.claude\memsync\memsync.py" pull`); POSIX-style separators on the wire; UTF-8 without BOM on disk; file modes 0600 for the token on POSIX and an `icacls` restriction on Windows.

Token: read from `MEMSYNC_TOKEN_FILE`, else `<config>/memsync/token`; never from settings, never logged. Cloud keeps the egress-proxy network secret and sends no token itself.

Hooks written by `install`: SessionStart (all sources), UserPromptSubmit (throttled to 5 min, otherwise exits in under 20 ms), Stop, SessionEnd.

Client version: the constant `CLIENT_VERSION` is sent with every request; pull responses carry `latest_client`. When newer, the hook prints a one-line `systemMessage` once per 24 h: "memsync X is available, run `memsync.py update`". No auto-update (the user reviews what code runs inside their hooks).

## 10. Server changes

### 10.1 Schema

```sql
CREATE TABLE schema_version (v INTEGER NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,              -- pj_xxxxxx
  canonical TEXT NOT NULL UNIQUE,   -- github.com/acme/platform
  title TEXT, created INTEGER NOT NULL, merged_into TEXT
);
CREATE TABLE project_members (
  repo TEXT PRIMARY KEY,            -- normalized child remote
  project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,             -- gitmodules | manual
  first_seen INTEGER NOT NULL, reported_by TEXT
);
ALTER TABLE files ADD COLUMN machine TEXT;
ALTER TABLE history ADD COLUMN machine TEXT;
ALTER TABLE history ADD COLUMN moved_from TEXT;
ALTER TABLE sync_events ADD COLUMN machine TEXT;
ALTER TABLE sync_events ADD COLUMN workspace TEXT;  -- pids, comma separated
```

`ALTER TABLE ADD COLUMN` is not idempotent in SQLite, so migrations move out of `schema.sql` into an ordered list in `worker/migrate.js` guarded by `schema_version`. It runs from `deploy.sh` (after `schema.sql`) and at `selfhost/server.mjs` startup; the Worker also checks the version on first request and refuses to serve (503 with a clear message) when it is behind, so a code-only deploy cannot corrupt data.

### 10.2 Compatibility with cloud environments on the old client

Cloud setup scripts are cached for about 7 days. Old clients call `/v1/pull` with no query and push unprefixed paths. Server rule: a request with no `projects` and no `layer-aware` header is **legacy**: pull returns only `global/*` with the prefix stripped, push maps `<name>` to `global/<name>`. The legacy path stays until the old client has aged out of every environment (phase 5).

### 10.3 API

| Endpoint | Change |
|---|---|
| `POST /v1/resolve` | New. Body `{machine, repos:[url], submodules:[{parent, children:[]}]}`. Creates projects, records membership, returns `{map:{repo:pid}, projects:[{id, canonical, title}]}`. |
| `GET /v1/pull?projects=a,b` | New query. Returns layer-prefixed files, `projects`, `now`, `latest_client`. |
| `POST /v1/push` | Paths carry layer prefix; adds `machine`, `allow_delete`; deletion guard (8.2); same `applyOne` rules per path. |
| `POST /v1/move` | New. `{from, to}` for one file (used by scope changes and admin). |
| `POST /admin/api/projects/merge`, `/split` | New. Merge A into B (8.3); split moves a repo (and optionally selected files) into a new project. |
| `GET /admin/api/projects` | New. Projects, members, file counts, last activity, conflicts. |
| `GET /v1/history` | Adds `machine`, `moved_from`. |
| `POST /v1/restore` | Unchanged (whole store by time); also restores `projects` rows touched after `at` only if the request sets `with_projects`. |

### 10.4 Admin UI

Sidebar groups: Global, one entry per project (with member repos listed), Unassigned (badge with count), plus the existing sync-status panel. New actions: assign an unassigned file to a project or to global, merge/split projects, drag a file between layers, show `machine` and workspace in status rows, show membership conflicts. History and per-file restore stay path-based.

## 11. Cloud setup-script changes

`setup-script.template.sh` changes:

- Bump the version comment (invalidates the cached snapshot).
- Download the new client; add `UserPromptSubmit` to the hook list; `MEMSYNC_DIR` stays `/root/memory` with `autoMemoryDirectory` unchanged in phase 1.
- Env: `MEMSYNC_MACHINE=cloud`.
- Network secret unchanged. No new hosts.
- Docs-sync: README, README.zh-CN, setup template, selfhost render script and the parent repo's docs change in the same commit.

## 12. Migrating the existing single global store

Order is chosen so that every step is behavior-preserving and individually reversible:

1. **Server deploy** (migration only): all existing rows are renamed to `global/<name>`; history rows rewritten likewise; a backup export (`/v1/pull` dump) is saved first and its location reported. Legacy clients keep working (10.2). Result: identical behavior to today.
2. **Classify** (offline, read-only): `memsync.py classify-store` reads the store and writes `classification.md`: for each file `suggested layer`, `confidence`, `evidence`. Signals in order: explicit `metadata.scope`; repo names/paths/URLs from the user's known repos mentioned in the body; `metadata.type`; default stays **global**. Only files with repo evidence get a project suggestion; `feedback` files with no evidence stay global.
3. **User review**: the user edits `classification.md` (one line per file, change `global`/`<repo>`/`skip`).
4. **Apply**: `memsync.py apply-classification classification.md` calls `/v1/move` per file and rewrites the two index files; history keeps both paths; result summary lists counts per layer. Can be rolled back by `POST /v1/restore` to the timestamp printed in step 1.

## 13. Test plan

- **Unit**: slug function against recorded CLI outputs (short, 200+ chars with hash, Windows drive paths, non-ASCII), URL normalizer (ssh, https, creds, ports, `.git`, case), `.gitmodules` parser (relative URLs, path != name), compose/split round trips, routing table, collision renaming, mass-delete guard thresholds, hidden-lines handling.
- **Server** (existing harness, both backends): schema migration from the v1 schema with data, legacy client behavior, resolve/membership, late reparent with history, merge/split, deletion guard, `restore` after reparent.
- **CLI probes** (scripted, run in CI with a stub model endpoint or a recorded session): SessionStart/Stop `cwd` behavior; transcript `environment` attachment parse; native dir computation versus the dir the CLI actually creates in a temp config dir; index read timing at `startup`/`resume`/`compact`. These fail loudly on CLI upgrade.
- **CI matrix**: ubuntu, macos, windows x Python 3.9 and 3.12 (client), Node 22 (server). Windows covers lock, quoting, path escaping, drive-letter case.
- **Simulation**: 2 machines x 2 windows. Four client state dirs against one server; scripted edits including concurrent MEMORY.md line adds, a deletion on one machine, a conflicting topic-file edit, offline push queue. Assert: no line lost, no file lost except by explicit delete, history complete.
- **Workspace scenarios**: superrepo plus both submodules attached; only one submodule attached; superrepo with empty submodule dirs; submodule path differs from repo name; non-git start dir with two repos one level down; late membership report after memories were written under the child; worktree launch; session started in a subdirectory.
- **First-sync**: existing per-project local dirs with overlapping names; empty server; empty local; guard trips at 6 deletions and at 31 %.

## 14. Rollout

| Phase | Content | Exit criterion |
|---|---|---|
| 0 | Server migration (step 1 of section 12) + legacy path. | Existing cloud sessions unchanged for a week. |
| 1 | Client v2 for cloud: workspace, layers, compose/split, `scope` note, startup delta, lock, guards. | Fresh cloud sessions route correctly in the scenario list; no data loss in the simulation. |
| 2 | Classification and migration of the existing store. | User signs off on `classification.md`. |
| 3 | Local install/uninstall/migrate/update on macOS and Linux; mid-session pull. | One real week of two machines. |
| 4 | Windows. | CI matrix green plus a manual session. |
| 5 | Remove legacy server path; optionally stop forcing `autoMemoryDirectory` in cloud. | No legacy requests in the sync log for 14 days. |

Each phase is a separate merge; releases are batched and wait for explicit approval.

## 15. Risks to "feels native"

1. **Stale index at startup.** The CLI reads the index before (or concurrently with) the SessionStart hook on `startup`, so a pull can arrive one session late for the index even though files are fresh. Mitigation is the additionalContext delta (6.3). It must be verified in a fresh cloud session, because the existing README claims the opposite for that environment.
2. **Index truncation and drift.** One composed index is capped at 200 lines / 25 KB. A large global layer plus several projects can push project lines out of view (hidden lines), and in-context index never refreshes mid-session. Mitigation: newest-first project lines, hidden-line marker, delta notes; still a visible difference from a single native dir.
3. **CLI changes under us.** The slug/git-root algorithm, memo/re-read timing, the transcript `environment` attachment and the reserved `memory/personal` path of the unreleased built-in sync are all internal. A CLI upgrade can change any of them (a flag flip can also switch memory from "files" to a tool-based mode). Mitigation: the CLI probe tests in CI and `source`/version recorded in every status event.

## 16. Open questions

1. ~~Does a fresh cloud session see a hook-written `MEMORY.md` on the first turn?~~ Answered: yes in cloud (fresh-container re-test). Still to confirm for an interactive local session (the local probes used stream-json).
2. Hook `cwd` on UserPromptSubmit after a `cd` in the same session was not measured separately (only Stop/SessionEnd). Routing uses Stop/SessionEnd, so this does not block.
3. How many folders can the desktop app attach to one Code session, and does it always use `--add-dir`? Not visible in the binary; check against the app.
4. Concurrent edits to the same topic file from two machines are still last-writer-wins with history. Is a 3-way merge for topic files worth adding in phase 3+?
5. Should `unassigned/` files be served to sessions on the machine that wrote them only (current plan) or to all sessions of the superrepo's workspace?
6. Should `metadata.scope` be stripped from files before upload? Kept for now: it carries the routing decision to other machines.
