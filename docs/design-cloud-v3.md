# Design v3: project memory and global memory for cloud sessions

Status: implemented (server, client v3, admin UI, migration tool). Scope is cloud sessions only; the local CLI is on the roadmap (section 12). All names in examples are generic: `github.com/acme/platform` is a superrepo with submodules `acme/api` and `acme/chat`.

## 1. Goals

A cloud session should feel like native Claude Code on a developer's machine. Natively there are two kinds of memory:

1. **Per-project auto-memory** that persists (`MEMORY.md` index plus topic files).
2. **User-level global instructions** in `~/.claude/CLAUDE.md`, loaded in every project.

A cloud container is fresh each time, so both are lost. v3 restores both:

- **Project memory** is the native auto-memory of the session, persisted per project. The directory stays `/root/memory` (one container is one session), and SessionStart fills it with the current project's memory only. `MEMORY.md` is a pure native per-project index.
- **Global memory** is `~/.claude/CLAUDE.md`, rendered by the SessionStart hook from the server and synced back on Stop and SessionEnd.

Non-goals: local CLI support, claude.ai chat access, live re-render of memory inside a running turn.

## 2. Verified facts

Measured in live cloud sessions (and, for the older CLI facts, by running the CLI with probe hooks).

| Fact | Consequence |
|---|---|
| A SessionStart hook that writes `/root/.claude/CLAUDE.md` is visible on the first turn. The host waits for SessionStart hooks (tested with a 5 s sleep). | The hook can render global memory. |
| The label in context is "Contents of /root/.claude/CLAUDE.md (user's private global instructions for all projects)", identical to native. | Claude treats it as user-level instructions. |
| A CLAUDE.md written by the setup script is overwritten by the hook's version. `@/abs/path` imports inside it work. | Nothing to do in the setup script. |
| A hook-written `/root/memory/MEMORY.md` is visible on the first turn in a fresh container. | Project index can be materialized at SessionStart. |
| Mid-session edits to `CLAUDE.md` or `MEMORY.md` are not re-rendered into context. | Same as native; a change shows up in the next session. |
| Cloud has no `/memory` command. Without guidance, "remember X for all projects" is saved to auto-memory and gets trapped in the project layer. | The CLAUDE.md header (section 7) routes saves. With it, Sonnet routed 4 of 4 test utterances correctly. |
| Multi-repo sessions start with cwd `/home/user`; each attached repo is a top-level clone `/home/user/<repo>` with an https GitHub `origin`. A superrepo's submodule dirs may be empty, and submodule paths can differ from repo names. Single-repo sessions start in `/home/user/<repo>`. | Workspace detection (section 5). |
| Hook input has `cwd`, `session_id`, `transcript_path`, `source`; env `CLAUDE_PROJECT_DIR` is the launch cwd. Stop and SessionEnd `cwd` follows the shell's `cd` into a repo. | The Stop `cwd` routes new files in multi-project sessions. |
| The native memory directory has a `proposals/` subdirectory (skill proposals). The CLI does not rewrite topic-file frontmatter. | `proposals/` is never synced. |
| `autoMemoryDirectory` in the in-container `~/.claude/settings.json` is honored, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` turns auto-memory on in cloud. | Unchanged from v1/v2 setup scripts. |

## 3. Model

```
                       server (one store)
   global/CLAUDE.md                 projects/<pid>/MEMORY.md + topic files      legacy root (v1/v2 data)
          |                                  |
          | pull: render HEADER + body       | pull: only the session's projects
          v                                  v
 /root/.claude/CLAUDE.md             /root/memory/
   = HEADER + global body              MEMORY.md + topic files   (pure native, current project only)
   loaded in every project             native auto-memory of this session
          ^                                  ^
          | push: strip HEADER,              | push: files -> projects/<pid>/...
          | send base_sha + line diff        | (layout.json reverses renames)
```

Server paths:

```
global/CLAUDE.md                    global memory body (no header)
projects/<pid>/MEMORY.md            project index
projects/<pid>/<file>.md            project topic files (direct children only)
<file>.md                           legacy root files from v1/v2; still pulled by old clients
```

A pid is at most 180 characters so `projects/<pid>/MEMORY.md` stays within the 200-character path limit; a longer remote fails with a clear error from `/v1/resolve`.

## 4. Project identity and submodule grouping

- `pid` is the normalized git remote of the project's root repo: `host/owner/repo`, lowercase. https, `ssh://` and scp-style (`git@host:owner/repo.git`) forms are accepted; `.git`, credentials, port, query and trailing slash are dropped. Exactly three segments; deeper paths (nested groups) are not repos here.
- A session outside any repo (or whose repos have no `origin`) is `_norepo`, mirroring native where such a session is its own project.
- **A superrepo and all its submodules are one project** (the pid of the superrepo). Membership is learned automatically: whenever a session sees a repo with `.gitmodules`, the client reports its submodule URLs (relative URLs resolved against `origin`, git semantics), and the server records `submodule repo -> parent pid`. A session that attaches only some submodules, or only submodules and no superrepo, maps to the parent project.
- **Late learning.** If a submodule already had its own project with files when its membership becomes known, `/v1/resolve` moves `projects/<sub>/*` into the parent. History is kept (delete row at the old path, write row at the new), same-name files become `<stem>.<n>.md` with index links rewritten, and the two `MEMORY.md` files are line-merged.
- **Manual control** in the admin UI: add a repo to a project (membership `manual`, never overwritten by `.gitmodules`), split a repo off, merge project A into B.

Table `repo_membership(repo PRIMARY KEY, pid, source 'gitmodules'|'manual'|'self', updated)`. Table `projects(pid PRIMARY KEY, label, created)`.

## 5. Workspace detection (SessionStart)

Scan root = `MEMSYNC_WORKSPACE`, else `CLAUDE_PROJECT_DIR`, else the hook `cwd`.

- If the root is inside a git repo: the repos are that repo's git root only.
- Otherwise: every git repo exactly one level below the root.

Each repo needs an `origin`; the client reads the repo's own config file (so git's safe-directory check cannot interfere) and `.gitmodules` URLs. All repos are sent to `/v1/resolve`, which returns the deduplicated, sorted pid list. No pid means `_norepo`.

## 6. Pull and push

**SessionStart (`memsync.py pull`)**

1. If a base exists (resume or compact in the same container), push pending local changes first.
2. Detect the workspace, `POST /v1/resolve`. A server without that route (404) switches the client to the legacy flat mode of v1: no CLAUDE.md, root paths.
3. `GET /v1/pull?projects=<pid>,<pid>&global=1`.
4. Write `/root/memory`: project files under their local names, `MEMORY.md` as the project's index (several projects: section 8). Local files that disappeared on the server are deleted only when a base existed. `proposals/` is ignored.
5. Write `~/.claude/CLAUDE.md` = header + global body (header only when the server has no global body).
6. Save `base.json` (sha and, for indexes, content per server path) and `layout.json` (projects, repo roots, local name to server path).

**Stop and SessionEnd (`memsync.py push`)**

- Changed project files go to their server path from `layout.json` (new files are routed, section 8).
- `MEMORY.md` is sent with `base_sha`, `added_lines`, `removed_lines`.
- CLAUDE.md: strip the header, compare the body with the base, send `base_sha` and the line diff. Merged or kept-remote results are written back locally.
- A file the model deleted is deleted on the server only if the server version is unchanged.
- All failures exit 0; throttled `systemMessage`, status events (now with the project list) and the lock are unchanged from v2.

## 7. CLAUDE.md: header, strip, merge

The client renders this header at the top (the text that was tested; verbatim):

```
# Global memory (shared by every project and session)
This file is the user's global memory and is loaded in every project. Edit it directly (/root/.claude/CLAUDE.md) to save:
- anything the user asks you to remember for all projects or globally;
- the user's preferences about how you should work (communication, writing style, workflow, review habits)
  that do not depend on a specific repository, service or system.
Keep each entry to one short line. Facts, procedures and rules about a specific project, repo, service
or deployment belong in auto-memory instead.
```

- Render: `HEADER` then a blank line then the body; header only when the body is empty.
- Strip: the first lines must equal the header lines, trailing whitespace ignored; the rest (leading blank lines removed) is the body. If the header was edited or removed, the whole file is treated as body.
- The server stores only the body at `global/CLAUDE.md`.
- Merge: `global/CLAUDE.md` and every `MEMORY.md` use the server's positional 3-way merge (diff3 against the base text looked up in `history` by `base_sha`), so edits stay under their heading and blank lines survive. Overlapping edits keep the server's lines plus this client's new lines; an unknown base falls back to appending the client's new lines.
- New files are pushed with `on_conflict: "rename"`: if another session created the same path meanwhile, the server stores this one as `<stem>.<n>.md` (status `renamed`) and the client renames its copy and relinks the index lines it added.

## 8. Several projects in one session

Rare (for example two unrelated repos attached). Kept small:

- Materialize all projects into `/root/memory`. A file name that is already taken becomes `<stem>.<n>.md` (n from 2) and the project's index links are rewritten. `layout.json` records the mapping so push reverses it.
- `MEMORY.md` is the concatenation of each project's lines. On push, an added line is routed to the project of the file it links to; removed lines go back to the project that owned them.
- **New files** go to the project of the repo containing the Stop hook's `cwd`; else the project of the git root of `CLAUDE_PROJECT_DIR`; else the first project (sorted). Pushes carry `routed_by` (`cwd`, `project_dir`, `first`), stored as a tag in the history `session` field (`<session>|routed:<rule>`). The admin UI lists such files under "Needs review" until they are edited, moved or marked reviewed.

## 9. Server

Schema additions (`worker/schema.sql`, all `CREATE TABLE IF NOT EXISTS`): `schema_version`, `repo_membership`, `projects`. Existing tables are untouched. Versioned migrations live in `worker/migrations/NNN_name.sql`; each file ends by inserting its own `schema_version` row. `deploy.sh` (through the D1 API) and `selfhost/server.mjs` (at startup) apply the ones above the current version. Migration 001 adds `sync_events.projects`.

API (bearer):

| Route | Behavior |
|---|---|
| `POST /v1/resolve {repos:[{url, submodules:[url]}]}` | Records membership, runs reparent moves, returns `{projects, map}` |
| `GET /v1/pull?projects=<pid>,<pid>&global=1` | `global/CLAUDE.md` plus those projects' files. **No params: legacy root files only** (old clients cached in cloud snapshots for about 7 days keep working) |
| `POST /v1/push` | Unchanged; clients send full server paths. New optional per-file `routed_by` |
| `POST /v1/move {from,to}` | History-preserving move; index onto index merges, other collisions answer 409 |
| `POST /v1/move-prefix {from_prefix,to_prefix}` | Moves a whole folder; collisions renamed, indexes merged |
| `POST /v1/status` | Accepts `projects` (list) |

Path rules: legacy root keeps the old rules; layered paths are exactly `global/CLAUDE.md` and `projects/<pid>/<file>.md`.

Admin API (`/admin/api`, same three auth modes and origin check): `GET /files` returns `layer`, `pid`, `flagged` per file plus `projects` with member repos; `POST /move`, `POST /merge-project`, `PUT/DELETE /membership`, `POST /unflag`. Edit, history and restore work on any path.

Admin UI groups the list as Needs review, Global, one group per project, Legacy root. The project panel edits membership and merges projects; the file panel moves a file to another project or to the legacy root.

## 10. Compatibility and rollout

Old clients keep working at every step: a pull without params returns legacy files, pushes of root paths are accepted. A new client against an old server falls back to the flat mode.

1. **Deploy the server.** Backward compatible. `deploy.sh` applies the migration.
2. **Update the setup script** in every environment (client v3 template; the first comment line changes so the snapshot is rebuilt). Sessions on a cached older snapshot stay on v1/v2 behavior until it expires, about 7 days.
3. **Run the migration** (`tools/migrate-layers.mjs`) from a plan that classifies the existing flat store: global entries to CLAUDE.md, files to projects. It is a dry run unless `--apply` is given, and every move keeps history.
4. **Classify leftovers** in the admin UI: whatever the plan did not mention stays under "Legacy root"; move files into projects from the file panel.

Rollback: restore the old setup script; data written to layered paths stays on the server and old clients ignore it.

## 11. Test plan

`npm test` runs every file on the Cloudflare runtime (`wrangler dev --local`) and the Node runtime.

| File | Covers |
|---|---|
| `test.mjs`, `test3.mjs` | Admin auth modes, CRUD, history, restore; self-host login (unchanged) |
| `test2.mjs` | Client hook behavior: messages, throttling, queue, language, push/pull (workspace pinned to an empty dir, so project `_norepo`) |
| `test4.mjs` | Normalization (https, ssh, credentials, case, port), relative submodule URLs, subset sessions, late reparent, pull with and without params, move and move-prefix with history, 3-way merge on `global/CLAUDE.md` and `projects/*/MEMORY.md`, path validation, status projects, admin layer listing, move, merge, membership |
| `test5.mjs` | Client end to end on real git checkouts (origin URLs only): single repo, superrepo plus subset, only submodules, no repo, two unrelated repos with Stop cwd routing and collisions, header added and stripped, concurrent CLAUDE.md edits, late membership, `proposals/`, a mock legacy server, the old v1 client against the new server |
| `test6.mjs` | Migration tool: dry run, validation, apply, re-run |

## 12. Known limits

- **Mid-session changes are not re-rendered** into context (same as native). Memory saved in one session shows up in the next.
- **Relies on CLI internals**: the first-turn visibility of hook-written files, the `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` switch, the `autoMemoryDirectory` setting, the CLAUDE.md label. Re-check after CLI upgrades; the admin status panel flags new CLI versions.
- **CLAUDE.md has no 200-line cap** (unlike `MEMORY.md`), so every entry costs context in every session; keep entries to one short line and prune.
- **Routing relies on the model**: whether a save lands in CLAUDE.md or auto-memory depends on the header being followed. Misplaced entries are fixed in the admin UI.
- **Multi-project sessions are best effort**: new-file routing uses the Stop `cwd` and is flagged for review.
- **Nested repo paths** (more than owner/repo) are not recognized as repos.
- **Local CLI and desktop app** are covered by [design-local.md](design-local.md).
