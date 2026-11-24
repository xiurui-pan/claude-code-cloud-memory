#!/bin/bash
# Deploy the memory Worker (D1 + Worker + optional custom domain) via the Cloudflare REST API.
# Config: deploy.env (see deploy.env.example); environment variables override it.
# Requires: bash, curl, jq, and openssl or python3 (to generate a token on first run).
set -euo pipefail
cd "$(dirname "$0")"

# ---- load deploy.env (existing env vars win) ----
KEYS="CF_API_TOKEN CF_ACCOUNT_ID WORKER_NAME D1_NAME HOST ACCESS_TEAM_DOMAIN ACCESS_AUD TOKEN_SHA256"
if [ -f deploy.env ]; then
  while IFS='=' read -r k v; do
    case " $KEYS " in *" $k "*)
      v="${v%\"}"; v="${v#\"}"
      if [ -z "${!k:-}" ]; then export "$k=$v"; fi ;;
    esac
  done < <(grep -E '^[A-Z0-9_]+=' deploy.env || true)
fi
for c in curl jq; do command -v "$c" >/dev/null || { echo "missing dependency: $c" >&2; exit 1; }; done

WORKER_NAME="${WORKER_NAME:-claude-memory}"
D1_NAME="${D1_NAME:-claude-memory}"
HOST="${HOST:-}"
HOST="${HOST#https://}"; HOST="${HOST%/}"
API=https://api.cloudflare.com/client/v4

AUTH=()
if [ -n "${CF_API_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer $CF_API_TOKEN"); fi
cf() { local r; r=$(curl -sS "${AUTH[@]}" "$@"); if [ "$(jq -r .success <<<"$r" 2>/dev/null)" != true ]; then echo "$r" >&2; return 1; fi; echo "$r"; }

# ---- account ----
A="${CF_ACCOUNT_ID:-}"
if [ -z "$A" ]; then
  ACCTS=$(cf "$API/accounts?per_page=50")
  if [ "$(jq '.result | length' <<<"$ACCTS")" != 1 ]; then
    echo "The token sees $(jq '.result | length' <<<"$ACCTS") accounts; set CF_ACCOUNT_ID to one of:" >&2
    jq -r '.result[] | "  \(.id)  \(.name)"' <<<"$ACCTS" >&2
    exit 1
  fi
  A=$(jq -r '.result[0].id' <<<"$ACCTS")
  echo "account: $A (auto-detected)"
fi

# ---- access token (only its SHA-256 is stored) ----
if [ -z "${TOKEN_SHA256:-}" ] && [ -s .token_sha256 ]; then
  TOKEN_SHA256=$(tr -d '[:space:]' < .token_sha256)
  echo "using the token hash from .token_sha256"
fi
# Re-deploy without the hash at hand: keep the token already bound to the Worker
# instead of rotating it (rotation would break every environment's network secret).
KEEP_TOKEN=0
if [ -z "${TOKEN_SHA256:-}" ] && cf "$API/accounts/$A/workers/scripts/$WORKER_NAME/settings" 2>/dev/null \
    | jq -e '.result.bindings[]? | select(.type == "secret_text" and .name == "TOKEN_SHA256")' >/dev/null; then
  KEEP_TOKEN=1
  echo "keeping the access token already set on Worker $WORKER_NAME (set TOKEN_SHA256 to rotate it)"
fi
if [ -z "${TOKEN_SHA256:-}" ] && [ "$KEEP_TOKEN" = 0 ]; then
  if command -v openssl >/dev/null; then TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  else TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))'); fi
  TOKEN_SHA256=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
  (umask 077; printf %s "$TOKEN_SHA256" > .token_sha256)
  cat <<MSG

============================================================
 New access token (shown ONCE, it is not stored anywhere):

   $TOKEN

 Save it now as a network secret in your Claude cloud environment
 (Authorization: Bearer, host shown at the end of this run).
 Only its SHA-256 was written to .token_sha256 (gitignored).
============================================================

MSG
fi
if [ "$KEEP_TOKEN" = 0 ]; then
  case "$TOKEN_SHA256" in *[!0-9a-fA-F]*|"") echo "TOKEN_SHA256 must be 64 hex chars" >&2; exit 1;; esac
  [ "${#TOKEN_SHA256}" = 64 ] || { echo "TOKEN_SHA256 must be 64 hex chars" >&2; exit 1; }
fi

# ---- D1 ----
DB=$(cf "$API/accounts/$A/d1/database?name=$D1_NAME" | jq -r --arg n "$D1_NAME" '[.result[] | select(.name == $n)][0].uuid // empty')
if [ -z "$DB" ]; then
  DB=$(cf -X POST "$API/accounts/$A/d1/database" -H 'content-type: application/json' \
    -d "$(jq -n --arg n "$D1_NAME" '{name: $n}')" | jq -r .result.uuid)
  echo "created D1 $D1_NAME ($DB)"
fi
jq -n --rawfile sql worker/schema.sql '{sql: $sql}' \
  | cf -X POST "$API/accounts/$A/d1/database/$DB/query" -H 'content-type: application/json' -d @- >/dev/null
echo "schema applied"
# Versioned migrations: worker/migrations/NNN_name.sql, each file inserts its own schema_version row.
d1_query() { jq -n --arg sql "$1" '{sql: $sql}' | cf -X POST "$API/accounts/$A/d1/database/$DB/query" -H 'content-type: application/json' -d @-; }
APPLIED=$(d1_query "SELECT COALESCE(MAX(version), 0) AS v FROM schema_version" | jq -r '.result[0].results[0].v // 0')
for f in worker/migrations/[0-9]*.sql; do
  [ -e "$f" ] || continue
  N=$((10#$(basename "$f" | sed 's/_.*//')))
  [ "$N" -gt "$APPLIED" ] || continue
  d1_query "$(cat "$f")" | jq -e '.success' >/dev/null || { echo "migration $f failed" >&2; exit 1; }
  echo "migration $(basename "$f") applied"
done

# ---- Worker ----
META=$(jq -n --arg db "$DB" --arg h "${TOKEN_SHA256:-}" --argjson keep "$KEEP_TOKEN" \
  --arg td "${ACCESS_TEAM_DOMAIN:-}" --arg aud "${ACCESS_AUD:-}" '{
  main_module: "index.js", compatibility_date: "2025-09-01", observability: {enabled: true},
  bindings: ([{type: "d1", name: "DB", id: $db}]
    + (if $keep == 1 then [] else [{type: "secret_text", name: "TOKEN_SHA256", text: $h}] end)
    + [{type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: $td}, {type: "plain_text", name: "ACCESS_AUD", text: $aud}])}
  + (if $keep == 1 then {keep_bindings: ["secret_text"]} else {} end)')
cf -X PUT "$API/accounts/$A/workers/scripts/$WORKER_NAME" \
  -F "metadata=$META;type=application/json" \
  -F "index.js=@worker/index.js;type=application/javascript+module" \
  -F "store.js=@worker/store.js;type=application/javascript+module" \
  -F "layers.js=@worker/layers.js;type=application/javascript+module" \
  -F "admin.js=@worker/admin.js;type=application/javascript+module" \
  -F "admin.html=@worker/admin.html;type=text/plain" \
  -F "memsync.py=@worker/memsync.py;type=text/plain" | jq -c '.result | {id, modified_on}'

# ---- routing: custom domain, or workers.dev ----
if [ -n "$HOST" ]; then
  ZONES='[]'; page=1
  while :; do
    R=$(cf "$API/zones?per_page=50&page=$page&account.id=$A")
    ZONES=$(jq -c --argjson more "$(jq -c .result <<<"$R")" '. + $more' <<<"$ZONES")
    [ "$page" -ge "$(jq '.result_info.total_pages // 1' <<<"$R")" ] && break
    page=$((page + 1))
  done
  # longest zone name that equals HOST or is a dot-suffix of it
  Z=$(jq -r --arg h "$HOST" '[.[] | select(.name as $n | $h == $n or ($h | endswith("." + $n)))] | sort_by(.name | length) | last | .id // empty' <<<"$ZONES")
  [ -n "$Z" ] || { echo "no zone on account $A matches HOST=$HOST" >&2; exit 1; }
  cf -X POST "$API/accounts/$A/workers/scripts/$WORKER_NAME/subdomain" -H 'content-type: application/json' \
    -d '{"enabled":false}' >/dev/null && echo "workers.dev route disabled"
  cf -X PUT "$API/accounts/$A/workers/domains" -H 'content-type: application/json' \
    -d "$(jq -n --arg h "$HOST" --arg s "$WORKER_NAME" --arg z "$Z" '{hostname: $h, service: $s, zone_id: $z, environment: "production"}')" \
    | jq -c '.result | {hostname, service}'
  URL="https://$HOST"
else
  cf -X POST "$API/accounts/$A/workers/scripts/$WORKER_NAME/subdomain" -H 'content-type: application/json' \
    -d '{"enabled":true}' >/dev/null && echo "workers.dev route enabled"
  SUB=$(cf "$API/accounts/$A/workers/subdomain" 2>/dev/null | jq -r '.result.subdomain // empty' || true)
  [ -n "$SUB" ] || { echo "this account has no workers.dev subdomain yet: create one in the dashboard (Workers & Pages) and re-run" >&2; exit 1; }
  URL="https://$WORKER_NAME.$SUB.workers.dev"
fi

# ---- render the environment setup script ----
TPL=$(cat setup-script.template.sh)
printf '%s\n' "${TPL//__MEMSYNC_URL__/$URL}" > setup-script.rendered.sh
SECRET_HOST="${URL#https://}"

cat <<MSG

Deployed: $URL
  health:  $URL/health

Next steps in your Claude cloud environment settings (claude.ai/code):
  1. Network secret  host: $SECRET_HOST   type: Bearer   value: <your access token>
  2. Setup script    paste everything between the markers below (also saved to setup-script.rendered.sh)

----- BEGIN SETUP SCRIPT -----
$(cat setup-script.rendered.sh)
----- END SETUP SCRIPT -----
MSG
if [ -z "${ACCESS_TEAM_DOMAIN:-}" ] || [ -z "${ACCESS_AUD:-}" ]; then
  echo
  echo "Admin UI ($URL/admin) is disabled until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set (see README), then re-run ./deploy.sh."
fi
