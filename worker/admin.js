// Admin UI + API. Auth is a Cloudflare Access JWT verified here (fail closed).
// Every write goes through store.js (writeRow: sha guard + history row), session "admin".

import PAGE from "./admin.html";
import { json, sha256Hex, validPath, writeRow, restoreAt, MAX_FILE_BYTES } from "./store.js";

const SESSION = "admin";
const enc = new TextEncoder();

// ---------- Cloudflare Access JWT ----------
const keyCache = new Map(); // team domain -> {at, keys: Map(kid -> CryptoKey)}
const KEY_TTL = 3600_000;
const KEY_MIN_REFETCH = 30_000;

function b64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const parseJson = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

async function loadKeys(team) {
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("certs fetch failed");
  const { keys } = await res.json();
  const m = new Map();
  for (const jwk of keys || []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    m.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache.set(team, { at: Date.now(), keys: m });
  return m;
}

async function keyFor(team, kid) {
  let c = keyCache.get(team);
  const now = Date.now();
  if (!c || now - c.at > KEY_TTL) c = { at: 0, keys: await loadKeys(team) };
  else if (!c.keys.has(kid) && now - c.at > KEY_MIN_REFETCH) c = { at: 0, keys: await loadKeys(team) };
  return c.keys.get(kid) || null;
}

function getToken(req) {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export async function verifyAccess(req, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  const token = getToken(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = parseJson(parts[0]);
    if (header.alg !== "RS256" || !header.kid) return null;
    const key = await keyFor(team, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) return null;
    const p = parseJson(parts[1]);
    const now = Date.now() / 1000;
    const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!auds.includes(aud)) return null;
    if (p.iss !== team) return null;
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (typeof p.nbf === "number" && p.nbf > now + 5) return null;
    return p;
  } catch (e) {
    console.error("admin: access verification error: " + String((e && e.message) || e));
    return null;
  }
}

// ---------- helpers ----------
export function parseFrontmatter(content) {
  const out = { name: "", description: "", type: "" };
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  let inMeta = false;
  for (const line of m[1].split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    const sub = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    const val = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (top) {
      inMeta = top[1] === "metadata";
      if (top[1] === "name") out.name = val(top[2]);
      else if (top[1] === "description") out.description = val(top[2]);
      else if (top[1] === "type" && !out.type) out.type = val(top[2]);
    } else if (sub && inMeta && sub[1] === "type") out.type = val(sub[2]);
  }
  return out;
}

const bytes = (s) => enc.encode(s).length;
const isErr = (r) => r instanceof Response;

async function readBody(req) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "content-type must be application/json" }, 415);
  try {
    return await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
}

const getRow = (env, path) => env.DB.prepare("SELECT path, content, sha, deleted, modified FROM files WHERE path = ?").bind(path).first();

// ---------- API ----------
async function api(req, env, url) {
  const route = url.pathname.slice("/admin/api".length);
  const method = req.method;
  const q = (k) => url.searchParams.get(k);

  if (method !== "GET") {
    // CSRF guard on top of Access: browsers always send Origin on cross-site writes.
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  if (route === "/files" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT path, content, sha, modified FROM files WHERE deleted = 0 ORDER BY path").all();
    return json({
      files: results.map((r) => ({ path: r.path, sha: r.sha, modified: r.modified, size: bytes(r.content), ...parseFrontmatter(r.content) })),
      now: Date.now(),
    });
  }

  if (route === "/file" && method === "GET") {
    if (!validPath(q("path"))) return json({ error: "bad path" }, 400);
    const r = await getRow(env, q("path"));
    if (!r || r.deleted) return json({ error: "not found" }, 404);
    return json({ path: r.path, content: r.content, sha: r.sha, modified: r.modified, size: bytes(r.content) });
  }

  if (route === "/file" && method === "PUT") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    if (!validPath(b.path)) return json({ error: "bad path" }, 400);
    if (typeof b.content !== "string") return json({ error: "content must be a string" }, 400);
    if (bytes(b.content) > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);
    const cur = await getRow(env, b.path);
    const live = cur && !cur.deleted ? cur : null;
    const base = b.base_sha || null; // null = creating
    if ((live ? live.sha : null) !== base) return json({ error: "conflict", sha: live && live.sha, content: live && live.content }, 409);
    const sha = await sha256Hex(b.content);
    if (live && live.sha === sha) return json({ ok: true, sha, noop: true });
    if (!(await writeRow(env, b.path, cur, b.content, sha, 0, SESSION, Date.now()))) return json({ error: "conflict" }, 409);
    return json({ ok: true, sha });
  }

  if (route === "/file" && method === "DELETE") {
    if (!validPath(q("path"))) return json({ error: "bad path" }, 400);
    const cur = await getRow(env, q("path"));
    if (!cur || cur.deleted) return json({ error: "not found" }, 404);
    if (cur.sha !== q("base_sha")) return json({ error: "conflict", sha: cur.sha }, 409);
    if (!(await writeRow(env, cur.path, cur, "", "", 1, SESSION, Date.now()))) return json({ error: "conflict" }, 409);
    return json({ ok: true });
  }

  if (route === "/history" && method === "GET") {
    if (!validPath(q("path"))) return json({ error: "bad path" }, 400);
    const limit = Math.min(parseInt(q("limit") || "100", 10) || 100, 500);
    const { results } = await env.DB.prepare(
      "SELECT id, sha, deleted, session, at, length(CAST(content AS BLOB)) AS size FROM history WHERE path = ? ORDER BY id DESC LIMIT ?"
    ).bind(q("path"), limit).all();
    return json({ history: results });
  }

  if (route === "/version" && method === "GET") {
    const r = await env.DB.prepare("SELECT id, path, content, sha, deleted, session, at FROM history WHERE id = ?").bind(Number(q("id"))).first();
    if (!r) return json({ error: "not found" }, 404);
    return json(r);
  }

  if (route === "/restore-file" && method === "POST") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    if (!validPath(b.path)) return json({ error: "bad path" }, 400);
    const h = await env.DB.prepare("SELECT path, content, sha, deleted FROM history WHERE id = ? AND path = ?").bind(Number(b.id), b.path).first();
    if (!h) return json({ error: "version not found" }, 404);
    const cur = await getRow(env, b.path);
    if (!cur) return json({ error: "not found" }, 404);
    const liveSha = cur.deleted ? null : cur.sha;
    // The editor must tell us which version it believes is current.
    if (liveSha !== (b.base_sha || null)) return json({ error: "conflict", sha: liveSha }, 409);
    if (h.sha === cur.sha && h.deleted === cur.deleted) return json({ ok: true, noop: true });
    if (!(await writeRow(env, b.path, cur, h.content, h.sha, h.deleted, SESSION, Date.now()))) return json({ error: "conflict" }, 409);
    return json({ ok: true, sha: h.sha, deleted: !!h.deleted });
  }

  if (route === "/restore" && method === "POST") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    const at = Number(b.at);
    if (!Number.isFinite(at) || at <= 0) return json({ error: "at must be epoch milliseconds" }, 400);
    return json({ restored_to: at, changed: await restoreAt(env, at, SESSION) });
  }

  if (route === "/status" && method === "GET") return json(await syncStatus(env));

  return json({ error: "not found" }, 404);
}

// ---------- sync status panel ----------
const DAY = 864e5;
export async function syncStatus(env, now = Date.now()) {
  const { results: recent } = await env.DB.prepare(
    "SELECT id, at, session, event, ok, error, files, cli_version, auto_memory, cwd_name FROM sync_events ORDER BY at DESC, id DESC LIMIT 20"
  ).all();
  const { results: streak } = await env.DB.prepare("SELECT ok FROM sync_events ORDER BY at DESC, id DESC LIMIT 500").all();
  let consecutiveFailures = 0;
  for (const r of streak) {
    if (r.ok) break;
    consecutiveFailures++;
  }
  const last = await env.DB.prepare("SELECT MAX(at) AS at FROM sync_events WHERE ok = 1").first();
  const latest = recent[0] || null;
  const { results: versions } = await env.DB.prepare(
    "SELECT cli_version AS version, MIN(at) AS first_seen, MAX(at) AS last_seen, COUNT(*) AS n FROM sync_events WHERE cli_version IS NOT NULL AND cli_version != '' GROUP BY cli_version ORDER BY first_seen DESC"
  ).all();
  const bad = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_events WHERE auto_memory = 'false' AND at > ?").bind(now - 7 * DAY).first();

  const health = [];
  if (consecutiveFailures > 0) {
    health.push({ level: "red", code: "sync_failing", params: { n: consecutiveFailures, error: recent.find((r) => !r.ok)?.error || "unknown" },
      message: `Sync failed ${consecutiveFailures} time(s) in a row with no success since (last error: ${recent.find((r) => !r.ok)?.error || "unknown"})` });
  }
  if (bad && bad.n > 0) {
    health.push({ level: "red", code: "auto_memory_off", params: { n: bad.n },
      message: `${bad.n} report(s) in the last 7 days show native auto-memory is disabled; new sessions may neither read nor write memory` });
  }
  if (!latest) health.push({ level: "yellow", code: "no_events", params: {}, message: "No sync events recorded yet" });
  else if (latest.at < now - 3 * DAY) health.push({ level: "yellow", code: "no_recent_events", params: {}, message: "No sync events received for more than 3 days" });
  // A version counts as an upgrade only if an older version was seen before it.
  const oldest = versions.length ? Math.min(...versions.map((v) => v.first_seen)) : null;
  for (const v of versions) {
    if (v.first_seen > now - 7 * DAY && v.first_seen > oldest) {
      health.push({ level: "yellow", code: "cli_upgraded", params: { version: v.version }, message: `Claude Code upgraded to ${v.version}; verify memory still works in a new session` });
    }
  }
  if (!health.length) health.push({ level: "green", code: "ok", params: {}, message: "Sync is healthy" });
  return { now, recent, last_success: last ? last.at : null, consecutive_failures: consecutiveFailures, versions, health };
}

// ---------- entry ----------
const HTML_ESC = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function pickLang(req, url) {
  const q = url.searchParams.get("lang");
  if (q === "zh" || q === "en") return q;
  const first = (req.headers.get("accept-language") || "").split(",")[0].trim().toLowerCase();
  return first.startsWith("zh") ? "zh" : "en";
}

const TEXT = {
  en: {
    title: "Admin not configured",
    body: "The admin UI is disabled until Cloudflare Access is configured (ACCESS_TEAM_DOMAIN and ACCESS_AUD are empty).",
    steps: "Create a self-hosted Access application for this hostname with path /admin, then set ACCESS_TEAM_DOMAIN and ACCESS_AUD in deploy.env and run ./deploy.sh again.",
    detected: "Cloudflare Access login detected (shown for setup only, not verified):",
    denied: "Cloudflare Access authentication failed.",
    other: "中文",
  },
  zh: {
    title: "管理后台尚未启用",
    body: "管理后台尚未启用：Cloudflare Access 还没有配置（ACCESS_TEAM_DOMAIN 和 ACCESS_AUD 为空）。",
    steps: "为本主机名创建一个 Self-hosted Access 应用，路径填 /admin，然后把 ACCESS_TEAM_DOMAIN 和 ACCESS_AUD 写进 deploy.env，重新运行 ./deploy.sh。",
    detected: "检测到 Cloudflare Access 登录信息（仅用于配置，尚未校验）：",
    denied: "未通过 Cloudflare Access 身份验证。",
    other: "English",
  },
};

function notConfiguredPage(lang, hint) {
  const t = TEXT[lang];
  const other = lang === "zh" ? "en" : "zh";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${HTML_ESC(t.title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 16px}pre{white-space:pre-wrap;word-break:break-all;padding:8px 12px;border:1px solid #8884;border-radius:6px}a{float:right}</style></head>
<body><a href="?lang=${other}">${HTML_ESC(TEXT[other].other)}</a><h1>${HTML_ESC(t.title)}</h1><p>${HTML_ESC(t.body)}</p><p>${HTML_ESC(t.steps)}</p>${hint ? `<p>${HTML_ESC(t.detected)}</p><pre>${HTML_ESC(hint)}</pre>` : ""}</body></html>`;
  return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

export async function handleAdmin(req, env, url) {
  const lang = pickLang(req, url);
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // Setup helper: once the Access app exists, Access forwards its JWT here even though the
    // Worker can't verify it yet. Show (never trust) its aud/iss so the owner can copy them.
    let hint = "";
    try {
      const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
      const tok = req.headers.get("cf-access-jwt-assertion") || (m && m[1]);
      if (tok) {
        const p = parseJson(tok.split(".")[1]);
        const aud = Array.isArray(p.aud) ? p.aud.join(", ") : String(p.aud || "");
        hint = `ACCESS_AUD = ${aud}\nACCESS_TEAM_DOMAIN = ${p.iss || ""}`;
      }
    } catch {}
    return notConfiguredPage(lang, hint);
  }
  const claims = await verifyAccess(req, env);
  if (!claims) console.error(`admin: access check failed for ${req.method} ${url.pathname}`);
  if (!claims) return new Response(TEXT[lang].denied, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
    });
  }
  if (url.pathname.startsWith("/admin/api/")) return await api(req, env, url);
  return json({ error: "not found" }, 404);
}
