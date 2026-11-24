# Reference

How the cloud integration works under the hood, the repository layout, and the HTTP API. Back to [README](../README.md).

## Why this works in cloud sessions

These are the findings the design rests on. They come from reading the Claude Code CLI source and testing in real cloud sessions.

- **The gate.** When `CLAUDE_CODE_REMOTE` is set (every cloud session) and `CLAUDE_CODE_REMOTE_MEMORY_DIR` is not, the CLI disables native auto-memory.
- **The undocumented switch.** Setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` takes the "force enable" branch and turns auto-memory on regardless of the gate. This is not in the documentation (see [Risks](operations.md#risks-and-limitations)).
- **`settings.json` is honored.** The docs say cloud sessions do not read your user-level `~/.claude/settings.json`; that only means the file on your own machine is not carried up. A `~/.claude/settings.json` written *inside the container* by the environment setup script is read normally, and its `hooks`, `env` and `autoMemoryDirectory` all take effect.
- **Timing.** The host waits for SessionStart hooks. Both the `MEMORY.md` and the `~/.claude/CLAUDE.md` written by the hook are in the context of the first turn (measured, including with a 5 s sleep in the hook). Claude Code labels the file "user's private global instructions for all projects", as it does natively, and `@/abs/path` imports inside it work. A `CLAUDE.md` written by the setup script is overwritten by the hook's version. Edits made mid-session are not re-rendered into context.
- **Network secret injection.** A "network secret" configured on the environment makes the egress proxy add `Authorization: Bearer <secret>` to requests for that host. Requests made from hooks go through the proxy, so `memsync.py` never holds the token. The proxy does not inject secrets while the setup script runs, which is why the client download endpoint (`/client/memsync.py`) is public and contains no secrets.
- **Setup-script snapshot caching.** The result of the setup script is cached as a container snapshot for about 7 days, and the cache is rebuilt when the setup script (or the allowed network hosts) changes. So updating the client means changing the script; see [Updating the client](operations.md#updating-the-client).

## Repository layout

| Path | Purpose |
|---|---|
| `worker/index.js` | Worker entry (the self-host server runs it unchanged): bearer auth, pull, push, resolve, move, history, restore, status; routes `/admin*` to `admin.js` |
| `worker/store.js` | Shared write path: `writeRow` (sha optimistic lock + history row), `applyOne`, `restoreAt`, `recordStatus`, path rules, 3-way line merge |
| `worker/layers.js` | Layers: repo URL normalization, `/v1/resolve` and submodule membership, reparenting, layered pull, history-preserving moves, project merge |
| `worker/migrations/` | Versioned SQL migrations (`NNN_name.sql`), applied by `deploy.sh` and the self-host server |
| `tools/migrate-layers.mjs` | Moves an existing flat store into layers from a JSON plan (dry run by default) |
| `docs/design-cloud-v3.md` | Design: verified facts, model, algorithms, rollout, tests, limits |
| `worker/admin.js`, `worker/admin.html` | Admin UI: Access JWT verification, self-host login session or proxy-header auth, `/admin/api/*`, single-file frontend (EN/中文) |
| `worker/memsync.py` | Hook client (Python standard library only). Served publicly at `/client/memsync.py`, contains no secrets |
| `worker/schema.sql` | D1 schema (`files`, `history`, `sync_events`, `schema_version`, `repo_membership`, `projects`) |
| `deploy.sh` | Deploys D1, schema, Worker and optional custom domain through the Cloudflare REST API |
| `deploy.env.example` | Deployment settings template (copy to `deploy.env`, which is gitignored) |
| `setup-script.template.sh` | Environment setup script template; `deploy.sh` fills in your URL |
| `selfhost/server.mjs` | Self-host runtime: D1 shim over `node:sqlite` plus a `node:http` adapter around the Worker's `fetch()` |
| `selfhost/text-loader.mjs` | Node module hook that loads `memsync.py` and `admin.html` as string modules (what Text modules are on Cloudflare) |
| `selfhost/Dockerfile`, `selfhost/docker-compose.yml`, `selfhost/env.example` | Container image, compose file (with a commented Caddy example), settings template |
| `selfhost/render-setup-script.sh` | Fills your URL into the setup script template (the self-host counterpart of what `deploy.sh` does) |
| `tests/` | Test harness, run with `npm test` against `wrangler dev --local` and against the self-host server (`BACKEND=cf` or `BACKEND=node` for one of them) |

## API and concurrency semantics

All endpoints except `/health` and `/client/memsync.py` require `Authorization: Bearer <token>`. In a cloud session with the network secret configured, plain `curl` works because the proxy adds the header.

| Method and path | Description |
|---|---|
| `GET /health` | Health check |
| `GET /client/memsync.py` | Download the hook client |
| `GET /v1/pull` | **No params**: legacy root files only (what v1/v2 clients expect): `{files:[{path,content,sha,modified}]}` |
| `GET /v1/pull?projects=<pid>,<pid>&global=1` | `global/CLAUDE.md` and the files of those projects |
| `POST /v1/resolve` | `{repos:[{url, submodules:[url...]}]}` → records submodule membership, folds late-learned projects into the parent, returns `{projects:[pid...], map:{url: pid}}` |
| `POST /v1/move` | `{from, to}`: move one file, history kept; an index onto an index is merged, any other collision is a 409 |
| `POST /v1/move-prefix` | `{from_prefix, to_prefix}` (both end with `/`): move a folder; name collisions get a `.2` suffix, indexes are merged |
| `POST /v1/push` | `{session, files:[{path, content\|null, base_sha, added_lines?, removed_lines?, on_conflict?}]}` |
| `GET /v1/history?path=&limit=&content=1` | Change history |
| `POST /v1/status` | Client sync report `{session, event: pull\|push, ok, error, files, cli_version, auto_memory, cwd_name, projects}`, stored in `sync_events` (latest ~2000 kept) |
| `POST /v1/restore` `{at: epoch_ms}` | Restore all files to their state at that time (the restore itself is recorded in history and can be undone) |

`sha` is the SHA-256 hex of the file's UTF-8 content. Paths: letters, digits and `._-/`, must end in `.md`, at most 200 characters, no `..`; files up to 200 KB; up to 500 files per push. Layered paths are exactly `global/CLAUDE.md` and `projects/<host>/<owner>/<repo>/<file>.md` (or `projects/_norepo/<file>.md`); every other path is a legacy root file. A push may tag a new file with `routed_by` to mark that the client chose its project by a fallback rule.

Rules:

- **Normal memory files.** If the server version equals the client's `base_sha`, the write is applied. Otherwise the last writer wins and the older version stays in `history`.
- **New files.** With `on_conflict: "rename"` (sent by current clients), a new file (`base_sha` null) whose path another session already took is stored as `<stem>.<n>.md` and answered with `{status: "renamed", to}`; the client renames its copy and fixes its `MEMORY.md` links. Without the flag the plain rule above applies.
- **`MEMORY.md` (any project) and `global/CLAUDE.md`.** On conflict the server does a positional 3-way merge (diff3) against the base text it finds in `history`: each side's edits land where they were made, blank lines and sections included. Where both sides changed the same lines it keeps the server's lines, drops the lines this client deleted and adds this client's new lines. If the base is not in history it falls back to appending the client's new lines. The merged result is written back to the local copy.
- **Deletes.** A delete is applied only if the server version is unchanged. If another session edited the file, the edited version is kept and restored locally.
- **Atomicity.** Writes to one path use an optimistic lock (`WHERE sha = ?`) and retry up to 4 times on conflict.
