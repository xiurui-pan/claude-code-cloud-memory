# Self-hosting

Run the server on your own machine instead of Cloudflare. Back to [README](../README.md).

## Self-hosting (alternative)

For this project, Cloudflare is the recommended way to run the server. It is tiny, the free tier covers it, and there is no machine, TLS certificate or backup job to look after. Self-hosting is for people who want everything on their own box: it runs the same `worker/*.js` on Node 22+ with a SQLite file, so the merge and concurrency rules exist in one copy only.

Requirements: a host with Docker (or Node 22+), and a **public domain with a valid TLS certificate**. Cloud sessions reach the server from Anthropic's infrastructure through the egress proxy, so `localhost`, LAN addresses and plain HTTP do not work.

### 1. Generate tokens and hashes

The server stores only hashes. You need two different tokens: the sync token (goes into the cloud environment as the network secret) and an admin token (typed into the admin login form).

```bash
SYNC_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
ADMIN_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
echo "sync token:  $SYNC_TOKEN"     # save both now; the hashes cannot be turned back into tokens
echo "admin token: $ADMIN_TOKEN"
cat > selfhost/.env <<EOF
TOKEN_SHA256=$(printf %s "$SYNC_TOKEN" | sha256sum | cut -d' ' -f1)
ADMIN_TOKEN_SHA256=$(printf %s "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)
ADMIN_SESSION_SECRET=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
PUBLIC_URL=https://memory.example.com
EOF
```

On macOS use `shasum -a 256` instead of `sha256sum`. `selfhost/.env` is gitignored; `selfhost/env.example` lists every setting.

### 2. Start it

```bash
docker compose -f selfhost/docker-compose.yml --env-file selfhost/.env up -d --build
curl -sS http://127.0.0.1:8787/health      # {"ok":true}
```

The container runs as a non-root user and keeps the SQLite database in the `memory-data` volume (`/data/memory.db`). Without Docker: `TOKEN_SHA256=<hash> npm run selfhost` (Node 22+, no `npm install` needed; data goes to `./data/memory.db`).

### 3. Put it behind HTTPS on a public domain

Point a DNS record for your domain (for example `memory.example.com`) at the host and terminate TLS with any reverse proxy. The compose file has a commented Caddy service that obtains certificates automatically. Uncomment it, create a `Caddyfile` next to the compose file containing

```
memory.example.com {
  reverse_proxy memory:8787
}
```

and remove the `ports` mapping of the `memory` service so that only Caddy can reach it. Set `PUBLIC_URL` to the public origin (`https://memory.example.com`). The admin UI compares the `Origin` of writes with the URL the server sees, and behind a TLS proxy that is the public one only if `PUBLIC_URL` says so.

### 4. Configure the Claude cloud environment

Same as [step 3 of the Quick start](../README.md#quick-start-cloudflare), with your domain:

1. **Network secret**: host = `memory.example.com`, type Bearer, value = the sync token. Allow this host in the environment's network access.
2. **Setup script**: render it with your URL and paste it into the environment.

```bash
selfhost/render-setup-script.sh https://memory.example.com > setup-script.rendered.sh
cat setup-script.rendered.sh
```

`sed "s|__MEMSYNC_URL__|https://memory.example.com|g" setup-script.template.sh` does the same. Then verify as in the last step of the [Quick start](../README.md#quick-start-cloudflare).

### 5. Admin UI

Set exactly one of the first two rows in `selfhost/.env`. With none of them, `/admin` answers 403, as on Cloudflare.

| Setting | Behavior |
|---|---|
| `ADMIN_TOKEN_SHA256` | `/admin` shows a login form. The submitted token is hashed and compared with this value in constant time. Success sets a session cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, path `/admin`, 12 hours, HMAC-signed. Logout revokes the session. After 10 failed logins within a minute the form refuses logins until that minute is over. Set `ADMIN_SESSION_SECRET` so logins survive restarts. For testing over `http://localhost`, set `ADMIN_COOKIE_SECURE=0` |
| `ADMIN_TRUST_PROXY_HEADER=<name>` | Trust an identity header set by a reverse proxy that authenticates users itself (for example `X-Forwarded-User` from oauth2-proxy or Authelia). Any request with a non-empty value is admitted. Use it only when the proxy strips this header from client requests and the container is reachable only through the proxy; otherwise anyone can send the header |
| `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` | Cloudflare Access JWT, as on Cloudflare (the server needs outbound access to your team domain) |

The server refuses to start if more than one mode is set, or if `ADMIN_TOKEN_SHA256` equals `TOKEN_SHA256`.

### 6. Backups and updates

The whole state is one SQLite file, history included. Take a consistent snapshot while the server runs with SQLite's backup API:

```bash
# on the host, if sqlite3 is installed (the path depends on where the volume lives)
sqlite3 /path/to/memory.db ".backup backup.db"

# inside the container (no sqlite3 needed)
docker compose -f selfhost/docker-compose.yml exec memory node --disable-warning=ExperimentalWarning -e \
  "const {DatabaseSync,backup}=require('node:sqlite');backup(new DatabaseSync('/data/memory.db'),'/data/backup.db')"
docker compose -f selfhost/docker-compose.yml cp memory:/data/backup.db ./backup.db
```

A plain `cp` of `memory.db` can miss recent writes that are still in the `-wal` file. To restore, stop the server, replace `memory.db` and delete any `memory.db-wal` and `memory.db-shm` next to it.

To update, run `git pull` and the `up -d --build` command again; the schema is applied idempotently at startup. A server update does not require a setup script change; a client update does, see [Updating the client](operations.md#updating-the-client).

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_SHA256` | required | SHA-256 hex of the sync token |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen port and address |
| `DB_PATH` | `./data/memory.db` (`/data/memory.db` in the image) | SQLite file |
| `PUBLIC_URL` | empty | Public origin; needed for the admin UI behind a TLS proxy |
| `ADMIN_TOKEN_SHA256`, `ADMIN_TRUST_PROXY_HEADER` | empty | Admin auth mode, see above |
| `ADMIN_SESSION_SECRET` | random per start | Key for the session cookie signature |
| `ADMIN_COOKIE_SECURE` | `1` | `0` drops the `Secure` flag (localhost over HTTP only) |
| `MAX_BODY_BYTES` | `104857600` | Request body limit |
