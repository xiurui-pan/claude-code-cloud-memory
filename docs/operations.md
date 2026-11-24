# Operations

Admin UI, migration, client updates, troubleshooting, day-to-day operations, risks and uninstall. Back to [README](../README.md).

## Admin UI and Cloudflare Access

Open `https://<your-host>/admin` in a browser: view, edit, create and delete memory files, see each file's history and restore a single version, or roll the whole store back to a point in time. One HTML file, no external dependencies, mobile-friendly, light/dark. Language follows the browser (`navigator.language`) with an EN/中文 toggle in the header (the choice is remembered). Files are grouped by layer (Needs review, Global, each project, Legacy root), can be filtered by `metadata.type` from frontmatter and searched; a new file is pre-filled with native frontmatter and can append an index line to the `MEMORY.md` of its layer.

All writes go through the same `writeRow` as the sync API (sha optimistic lock, history row, session tag `admin`). The editor submits the sha it opened; if the file changed meanwhile the server returns 409 and the page keeps your unsaved text.

### Authentication

On Cloudflare the admin UI accepts **only** a Cloudflare Access JWT, not the bearer token (and `/v1/*` accepts only the bearer token). Self-hosted servers use a login or a proxy header instead, see [Self-hosting](selfhost.md#5-admin-ui). The Worker verifies the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) with WebCrypto: RS256 signature (keys from `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, cached about an hour), `aud` contains `ACCESS_AUD`, `iss` equals the team domain, `exp` and `nbf`.

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

## Migrating an existing flat store

If you ran v1/v2 (one memory store for all projects), the files sit at the root of the store and show up as "Legacy root" in the admin UI. `tools/migrate-layers.mjs` moves them into layers from a plan you write. It does not decide what is global; you do.

```json
{
  "global_claude_md": "- Reply in Chinese\n- Prefer short answers\n",
  "moves": [
    {"from": "deploy.md", "to": "projects/github.com/acme/platform/deploy.md"},
    {"from": "MEMORY.md", "to": "projects/github.com/acme/platform/MEMORY.md"}
  ],
  "drop": ["obsolete.md"],
  "project_indexes": {"github.com/acme/platform": "- [Deploy](deploy.md) — order of nodes\n"}
}
```

- `global_claude_md`: entries for the global `CLAUDE.md`, header not included; lines are merged into what is already there.
- `moves`: legacy root file → project path. Moves keep history. Moving `MEMORY.md` onto an existing project index merges the lines.
- `project_indexes`: index lines merged into a project's `MEMORY.md`.
- `drop`: legacy files to delete (history keeps them).
- Legacy files the plan does not mention stay where they are, so you can classify them in the admin UI afterwards.

```bash
export MEMSYNC_URL=https://memory.example.com MEMSYNC_TOKEN=<access token>   # token not needed in a cloud session; run node with NODE_USE_ENV_PROXY=1 there
node tools/migrate-layers.mjs plan.json            # dry run: prints every move, merged line and drop
node tools/migrate-layers.mjs plan.json --apply    # execute
```

Rollout order: (1) deploy the server (backward compatible), (2) update the setup script in every environment, (3) run the migration, (4) classify the leftovers in the admin UI. Clients on a cached older snapshot keep using the legacy root files until the snapshot expires.

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
# all current memories: global + one project (a plain /v1/pull returns only the legacy root files)
curl -sS "https://memory.example.com/v1/pull?global=1&projects=github.com/owner/repo" | jq -r '.files[] | "== \(.path)\n\(.content)"'

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
  3. `curl -sS "https://<host>/v1/pull?global=1" | jq '.files|length'` confirms data is on the server; a 401 means the network secret is invalid.
  4. Alternatives if the switch is gone: set `CLAUDE_CODE_REMOTE_MEMORY_DIR` in the `settings.json` `env` (the other switch in the source); or have the SessionStart hook `cat /root/memory/MEMORY.md` to stdout (injected as context, capped at 10,000 characters) and put the saving rules in `~/.claude/CLAUDE.md`.
  5. If Anthropic ships first-party cloud memory (unreleased "memory stores" sync code is visible in the CLI source), export the files from D1 and move them; the format is the native one.
  Your data lives in D1, so a client or switch problem does not lose it.
- **Auto-dream does not run in cloud.** Native auto-dream (background consolidation) requires a number of new local session transcripts, and each container only has the current one. Since `MEMORY.md` loads only its first 200 lines / 25 KB, a shared store needs occasional tidying. You can add your own periodic job (a scheduled task that pulls, merges duplicates, drops stale entries, compacts the index, pushes). Suggested rules: never delete, only merge; keep one line per memory in the index; keep the index under about 150 lines; rely on `/v1/restore` to undo a bad run.
- **Single-user design.** One token, one memory store, no per-user separation. Do not share the token or the admin Access policy with people who should not see all memories.
- **Global vs project routing depends on the model.** The header in `CLAUDE.md` steers saves (4 of 4 test utterances were routed correctly with Sonnet), but a misplaced entry is possible; fix it in the admin UI.
- **`CLAUDE.md` has no 200-line cap.** Keep global entries to one short line each and prune them.
- **Mid-session changes are not re-rendered.** A memory saved in one session is in context from the next session, as natively.
- **Nested repo paths** (more than `owner/repo`, for example GitLab subgroups) are not recognized as repos; such a session counts as `_norepo`.
- **Do not store secrets in memory.** Memory files are plain text in D1, shown in the admin UI and loaded into every session's context.
- **Hooks never break a session.** `memsync.py` exits 0 on every failure; the cost is that a sync problem is visible only through the messages and panels above.
- **Local CLI / desktop app**: see the limits in [local.md](local.md).

## Uninstall

1. Remove the setup script (or the memsync part of it) from each environment, and delete the network secret.
2. Optionally export the memories first: `curl -sS "https://<host>/v1/pull?global=1&projects=<pid>" | jq -r '.files[] | "== \(.path)\n\(.content)"'` (the admin UI shows every project id).
3. Delete the Worker, the D1 database, the custom domain route and the Access application in the Cloudflare dashboard. Self-hosted: `docker compose -f selfhost/docker-compose.yml down -v` (this also deletes the data volume, so take a backup first).
