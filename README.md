# claude-code-cloud-memory

English | [简体中文](README.zh-CN.md)

Persistent, cross-session memory for Claude Code **cloud sessions** (claude.ai/code), backed by a Cloudflare Worker + D1 that you host yourself.

Cloud sessions run in a fresh container each time and ship with native auto-memory turned off. This project turns native auto-memory back on in the container and syncs the memory directory to your Worker: memory is pulled when a session starts and pushed when a reply finishes. The memory format, loading and write rules are exactly Claude Code's native ones, and one memory store is shared across all projects and sessions.

Features:

- Native auto-memory (`MEMORY.md` index + one `.md` file per memory), nothing custom on the model side.
- Server with optimistic concurrency, per-file last-writer-wins, 3-way line merge for `MEMORY.md`, full history and restore.
- Admin UI (browser) behind Cloudflare Access: view, edit, create, delete, per-file history, whole-store rollback, sync-status panel. English and Chinese.
- The access token never appears in environment variables, URLs or repos (it is a cloud-environment network secret).
- Errors are visible: hook `systemMessage` in the chat, the admin status panel, Workers Logs.

## How it works

```
new session starts (container prepared by your environment setup script)
  └─ SessionStart hook: memsync.py pull
       GET https://<your-host>/v1/pull  →  files written to /root/memory/
       └─ Claude Code loads /root/memory/MEMORY.md natively (first 200 lines / 25 KB)
while working
  └─ Claude writes memories by the native rules: one .md per memory (with frontmatter) + a MEMORY.md index line
after every reply (Stop hook) and at session end (SessionEnd hook)
  └─ memsync.py push: POST the files that changed since the last sync to /v1/push

              ┌──────────────────────────── Claude cloud container ───────────────────────────┐
              │ ~/.claude/settings.json (written by setup script)                              │
              │   env: CLAUDE_CODE_DISABLE_AUTO_MEMORY=0, MEMSYNC_URL, MEMSYNC_DIR            │
              │   autoMemoryDirectory: /root/memory                                            │
              │   hooks: SessionStart pull · Stop push · SessionEnd push                       │
              └───────────────┬────────────────────────────────────────────────────────────────┘
                              │ HTTPS (egress proxy adds  Authorization: Bearer <network secret>)
                              ▼
                  Cloudflare Worker  ──  D1 (files, history, sync_events)
                        ▲
        /admin (Cloudflare Access JWT)  ←  your browser
```

## Why this works in cloud sessions

These are the findings the design rests on. They come from reading the Claude Code CLI source and testing in real cloud sessions.

- **The gate.** When `CLAUDE_CODE_REMOTE` is set (every cloud session) and `CLAUDE_CODE_REMOTE_MEMORY_DIR` is not, the CLI disables native auto-memory.
- **The undocumented switch.** Setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` takes the "force enable" branch and turns auto-memory on regardless of the gate. This is not in the documentation (see [Risks](#risks-and-limitations)).
- **`settings.json` is honored.** The docs say cloud sessions do not read your user-level `~/.claude/settings.json`; that only means the file on your own machine is not carried up. A `~/.claude/settings.json` written *inside the container* by the environment setup script is read normally, and its `hooks`, `env` and `autoMemoryDirectory` all take effect.
- **Timing.** The `MEMORY.md` written by the SessionStart hook is in place in time to be loaded on the first turn.
- **Network secret injection.** A "network secret" configured on the environment makes the egress proxy add `Authorization: Bearer <secret>` to requests for that host. Requests made from hooks go through the proxy, so `memsync.py` never holds the token. The proxy does not inject secrets while the setup script runs, which is why the client download endpoint (`/client/memsync.py`) is public and contains no secrets.
- **Setup-script snapshot caching.** The result of the setup script is cached as a container snapshot for about 7 days, and the cache is rebuilt when the setup script (or the allowed network hosts) changes. So updating the client means changing the script; see [Updating the client](#updating-the-client).

## Repository layout

| Path | Purpose |
|---|---|
| `worker/index.js` | Worker entry: bearer auth, pull, push, history, restore, status; routes `/admin*` to `admin.js` |
| `worker/store.js` | Shared write path: `writeRow` (sha optimistic lock + history row), `applyOne`, `restoreAt`, `recordStatus` |
| `worker/admin.js`, `worker/admin.html` | Admin UI: Access JWT verification, `/admin/api/*`, single-file frontend (EN/中文) |
| `worker/memsync.py` | Hook client (Python standard library only). Served publicly at `/client/memsync.py`, contains no secrets |
| `worker/schema.sql` | D1 schema (`files`, `history`, `sync_events`) |
| `deploy.sh` | Deploys D1, schema, Worker and optional custom domain through the Cloudflare REST API |
| `deploy.env.example` | Deployment settings template (copy to `deploy.env`, which is gitignored) |
| `setup-script.template.sh` | Environment setup script template; `deploy.sh` fills in your URL |
| `tests/` | Local test harness (`wrangler dev --local`), run with `npm test` |

## Quick start

Requirements: a Cloudflare account, `bash`, `curl`, `jq`, and `openssl` or `python3` on the machine you deploy from.

### 1. Create a Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → Create Token. Permissions:

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Account Settings · Read (lets `deploy.sh` auto-detect the account)
- Only if you use a custom domain: Zone · DNS · Edit and Zone · Zone · Read, limited to your zone

Start from the "Edit Cloudflare Workers" template and add "Account · D1 · Edit" and "Zone · DNS · Edit". Leave the client IP filter empty.

### 2. Configure and deploy

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env          # at least HOST (optional), see comments
export CF_API_TOKEN=...     # or put it in deploy.env
./deploy.sh
```

Settings (in `deploy.env` or the environment; environment wins):

| Variable | Default | Meaning |
|---|---|---|
| `CF_API_TOKEN` | none | Cloudflare API token. If unset, no auth header is sent (works only behind an injecting proxy) |
| `CF_ACCOUNT_ID` | auto | Needed only if the token sees more than one account |
| `WORKER_NAME` | `claude-memory` | Worker name |
| `D1_NAME` | `claude-memory` | D1 database name (reused if it exists) |
| `HOST` | empty | Custom domain, e.g. `memory.example.com`. The zone is found by longest suffix match among your zones. Empty keeps `workers.dev` enabled and uses that URL |
| `ACCESS_TEAM_DOMAIN` | empty | Admin UI, e.g. `https://myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | empty | Admin UI, Access application AUD tag |
| `TOKEN_SHA256` | generated | SHA-256 hex of the access token |

On the first run `deploy.sh` generates a random access token, **prints it once**, and stores only its SHA-256 in `.token_sha256` (gitignored). Save the printed token right away: you need it as the network secret below, and it cannot be recovered. Later runs never rotate it by accident: they reuse `.token_sha256`, and if that file is gone (for example you deploy from a fresh checkout) they keep the token already bound to the Worker. To get a new token, see [Rotate the access token](#operations). The script is idempotent: the D1 database is reused and the schema uses `IF NOT EXISTS`.

At the end it prints the rendered setup script (your URL filled in) and the network-secret host.

With `HOST` set, the `workers.dev` route is disabled. Without it, `workers.dev` stays enabled and the printed URL is `https://<worker>.<your-subdomain>.workers.dev`.

### 3. Configure the Claude cloud environment

In claude.ai/code → environment settings:

1. **Network secret**: host = the host printed by `deploy.sh` (for example `memory.example.com`), type Bearer, value = the access token printed in step 2. Check that the environment's network access allows this host.
2. **Setup script**: paste the rendered script printed by `deploy.sh` (also saved as `setup-script.rendered.sh`). If the environment already has a setup script, append this one; if the existing script also writes `~/.claude/settings.json`, merge the two by hand.

Set `MEMSYNC_LANG=zh` at the top of the script for Chinese hook messages.

### 4. Verify

Start a new cloud session in that environment and ask Claude to remember something ("remember that I prefer X"). Then:

```bash
# inside any cloud session of that environment (the proxy adds the token)
curl -sS https://memory.example.com/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'
```

Start another session: the memory is loaded at the start. Also check that the system prompt of the new session mentions the auto-memory directory `/root/memory/`; if it does not, the switch did not take effect (see [Troubleshooting](#troubleshooting)).

## Admin UI and Cloudflare Access

Open `https://<your-host>/admin` in a browser: view, edit, create and delete memory files, see each file's history and restore a single version, or roll the whole store back to a point in time. One HTML file, no external dependencies, mobile-friendly, light/dark. Language follows the browser (`navigator.language`) with an EN/中文 toggle in the header (the choice is remembered). Files are grouped by `metadata.type` from frontmatter and searchable; a new file is pre-filled with native frontmatter and can append an index line to `MEMORY.md`.

All writes go through the same `writeRow` as the sync API (sha optimistic lock, history row, session tag `admin`). The editor submits the sha it opened; if the file changed meanwhile the server returns 409 and the page keeps your unsaved text.

### Authentication

The admin UI accepts **only** a Cloudflare Access JWT, not the bearer token (and `/v1/*` accepts only the bearer token). The Worker verifies the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) with WebCrypto: RS256 signature (keys from `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, cached about an hour), `aud` contains `ACCESS_AUD`, `iss` equals the team domain, `exp` and `nbf`.

It is **off by default**: if `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, every `/admin*` request gets 403. Verification failures are also 403. A custom domain (`HOST`) is the straightforward way to protect `/admin` with Access.

### Enable it

1. Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Application domain: your `HOST`, path `admin` (Access then protects `/admin` and everything below; `/v1` and `/health` are unaffected).
3. Policy: Allow, Include → Emails, only your own address.
4. Find the team domain and the AUD:
   - Team domain: Zero Trust → Settings → General → Team domain. It looks like `https://<team>.cloudflareaccess.com`.
   - AUD: the application's **Application Audience (AUD) Tag** in its details.
   - Shortcut: after the Access app exists and before the Worker is configured, open `/admin` and log in once. The 403 "not configured" helper page then shows `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` taken from the JWT Access sent (shown for setup only, never trusted). If you are not logged in yet, the `kid` parameter of the redirect URL to the Access login page is the AUD as well.
5. Put both values into `deploy.env` and run `./deploy.sh` again.

The 403 helper page is available in English and Chinese: it follows the `Accept-Language` header, and `?lang=zh` / `?lang=en` forces one.

## API and concurrency semantics

All endpoints except `/health` and `/client/memsync.py` require `Authorization: Bearer <token>`. In a cloud session with the network secret configured, plain `curl` works because the proxy adds the header.

| Method and path | Description |
|---|---|
| `GET /health` | Health check |
| `GET /client/memsync.py` | Download the hook client |
| `GET /v1/pull` | All live files: `{files:[{path,content,sha,modified}]}` |
| `POST /v1/push` | `{session, files:[{path, content\|null, base_sha, added_lines?, removed_lines?}]}` |
| `GET /v1/history?path=&limit=&content=1` | Change history |
| `POST /v1/status` | Client sync report `{session, event: pull\|push, ok, error, files, cli_version, auto_memory, cwd_name}`, stored in `sync_events` (latest ~2000 kept) |
| `POST /v1/restore` `{at: epoch_ms}` | Restore all files to their state at that time (the restore itself is recorded in history and can be undone) |

`sha` is the SHA-256 hex of the file's UTF-8 content. Paths: letters, digits and `._-/`, must end in `.md`, at most 200 characters, no `..`; files up to 200 KB; up to 500 files per push.

Rules:

- **Normal memory files.** If the server version equals the client's `base_sha`, the write is applied. Otherwise the last writer wins and the older version stays in `history`.
- **`MEMORY.md`.** On conflict the server does a 3-way line merge: it keeps lines other sessions added, removes lines this client removed, appends lines this client added. The merged result is written back to the local copy.
- **Deletes.** A delete is applied only if the server version is unchanged. If another session edited the file, the edited version is kept and restored locally.
- **Atomicity.** Writes to one path use an optimistic lock (`WHERE sha = ?`) and retry up to 4 times on conflict.

## Updating the client

The container runs a copy of `memsync.py` that the setup script downloaded. Deploying only updates the copy served by the Worker.

1. Edit `worker/memsync.py` and run `./deploy.sh`.
2. **Change the environment's setup script** (for example bump the version in the first comment line) so the cached snapshot is rebuilt. Without a change, the old client can stay cached for about 7 days.
3. Do this in every environment that uses the script.

## Troubleshooting

Sync failures show up in four places, nearest first:

| Where | What you see | What to do |
|---|---|---|
| **Chat message** (hook `systemMessage`) | `Memory sync: pull failed (…), no persistent memory was loaded for this session.` / `Memory sync: push failed (HTTP 401), N file(s) not synced, will retry after the next reply.` / `Memory sync recovered, N file(s) pushed.` / `Memory sync: some files could not be synced: x.md (invalid path)`. A failed push is reported on the first failure, then at most once every 10 minutes; success shows nothing. On a failed pull Claude is also told via `additionalContext` that no memory was loaded | `HTTP 401`: the network secret is missing or wrong (host and Bearer type). `connection timed out` / `connection failed`: Worker or network problem, check `/health`. `invalid path` / `file too large`: rename (letters, digits, `._-/`, ending in `.md`) or split (limit 200 KB). `MEMSYNC_URL is not set`: the setup script did not run or `settings.json` was overwritten. A failed push is retried after the next reply, nothing is lost |
| **Admin → Sync status** | Health badges, the latest 20 sync events, first-seen time of each Claude Code version | See the table below |
| **Workers Logs** | Cloudflare dashboard → Workers & Pages → your Worker → Logs. 500 errors and Access verification failures are logged with `console.error` (route and error message only, no memory content, tokens or headers) | Server-side faults |
| **`sync.log` in the container** | `/root/.claude/memsync/sync.log`, one line per pull/push, with exception details on failure. `status_queue.json` in the same directory holds status reports not yet delivered (max 50, flushed on the next successful request) | Details of a single session: `cat` it inside the session |

Status panel badges:

| Badge | Meaning | What to do |
|---|---|---|
| Red: sync failed N times in a row | The latest events are all failures with no success after them | Look at the last error and use the table above. A new session with no memory is usually this |
| Red: auto-memory disabled | A report with `auto_memory=false` in the last 7 days | Native auto-memory is off; check the switch, see [Risks](#risks-and-limitations) |
| Yellow: no events for 3 days | No new sessions, or the client is not reporting (hook not installed, old client) | Start a new session and see whether events appear; if not, check the setup script |
| Yellow: Claude Code upgraded to X | A new CLI version appeared (first seen less than 7 days ago, and an older one was seen before) | Start a new session and confirm the system prompt still has the auto-memory section and memory loads |

**What `auto_memory` means.** A hook cannot see the system prompt, but Claude Code writes the full system prompt into the session transcript as an entry with `type: attachment` and `attachment.type: prompt_snapshot`. With auto-memory on, the snapshot contains the memory directory (`/root/memory`); with it off, it does not. On push, the client reads the latest snapshot from the Stop hook's `transcript_path` and reports `true` or `false`. At SessionStart no snapshot exists yet, so pull events report `unknown`. If a future CLI stops writing this snapshot, the value stays `unknown`; then rely on the yellow "Claude Code upgraded" badge and check by hand.

## Operations

Run these in a cloud session of the environment (the proxy adds the token), or add `-H "Authorization: Bearer $TOKEN"`:

```bash
# all current memories
curl -sS https://memory.example.com/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'

# last 20 changes
curl -sS "https://memory.example.com/v1/history?limit=20" | jq -c '.history[] | {path, deleted, session, at}'

# roll everything back to a point in time (epoch milliseconds)
curl -sS -X POST -d '{"at": 1790000000000}' https://memory.example.com/v1/restore
```

**Rotate the access token.** Generate a new one (`python3 -c "import secrets;print(secrets.token_urlsafe(32))"`), compute `printf %s "$NEW" | sha256sum`, run `TOKEN_SHA256=<hash> ./deploy.sh`, then replace the value of the network secret in every environment.

**Add an environment.** Paste the setup script into the new environment (merge by hand if it already writes `settings.json`) and add the network secret (same host, Bearer, same token).

## Risks and limitations

- **Relies on undocumented behavior.** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` enabling auto-memory in the cloud comes from the CLI source (default off when `CLAUDE_CODE_REMOTE` is set and `CLAUDE_CODE_REMOTE_MEMORY_DIR` is not; value `0` forces it on). A future version may change it. If new sessions suddenly have no memory:
  1. Check whether the system prompt of a new session still has an auto-memory section pointing at `/root/memory/`. If not, the switch stopped working.
  2. `cat /root/.claude/memsync/sync.log` and look for `pull ok`.
  3. `curl -sS https://<host>/v1/pull | jq '.files|length'` confirms data is on the server; a 401 means the network secret is invalid.
  4. Alternatives if the switch is gone: set `CLAUDE_CODE_REMOTE_MEMORY_DIR` in the `settings.json` `env` (the other switch in the source); or have the SessionStart hook `cat /root/memory/MEMORY.md` to stdout (injected as context, capped at 10,000 characters) and put the saving rules in `~/.claude/CLAUDE.md`.
  5. If Anthropic ships first-party cloud memory (unreleased "memory stores" sync code is visible in the CLI source), export the files from D1 and move them; the format is the native one.
  Your data lives in D1, so a client or switch problem does not lose it.
- **Auto-dream does not run in cloud.** Native auto-dream (background consolidation) requires a number of new local session transcripts, and each container only has the current one. Since `MEMORY.md` loads only its first 200 lines / 25 KB, a shared store needs occasional tidying. You can add your own periodic job (a scheduled task that pulls, merges duplicates, drops stale entries, compacts the index, pushes). Suggested rules: never delete, only merge; keep one line per memory in the index; keep the index under about 150 lines; rely on `/v1/restore` to undo a bad run.
- **Single-user design.** One token, one shared memory store, no per-user separation. Do not share the token or the admin Access policy with people who should not see all memories.
- **Do not store secrets in memory.** Memory files are plain text in D1, shown in the admin UI and loaded into every session's context.
- **Hooks never break a session.** `memsync.py` exits 0 on every failure; the cost is that a sync problem is visible only through the messages and panels above.
- **Idea, not implemented:** an MCP connector on the Worker so claude.ai chat can query the same memories. It would need its own OAuth flow (custom connectors do not take a static bearer token), so it is left out.

## Uninstall

1. Remove the setup script (or the memsync part of it) from each environment, and delete the network secret.
2. Optionally export the memories first: `curl -sS https://<host>/v1/pull | jq -r '.files[] | "== \(.path)\n\(.content)"'`.
3. Delete the Worker, the D1 database, the custom domain route and the Access application in the Cloudflare dashboard.

## Development

```bash
npm install
npm run check   # node --check + python -m py_compile
npm test        # test.mjs (admin, Access JWT, API) + test2.mjs (memsync.py end to end), via wrangler dev --local
```

The tests start local Workers with a local JWKS server; no Cloudflare account is needed. `tests/ui.mjs` and `tests/ui2.mjs` are optional Playwright screenshot scripts (`npm install playwright` first).

## License

MIT. See [LICENSE](LICENSE).
