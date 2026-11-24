// Admin UI + API. Auth is one of three modes, picked by env (fail closed):
//   Cloudflare Access JWT  ACCESS_TEAM_DOMAIN + ACCESS_AUD                (Cloudflare deployment)
//   Self-host login        ADMIN_TOKEN_SHA256 (+ ADMIN_SESSION_SECRET, ADMIN_COOKIE_SECURE)
//   Trusted proxy header   ADMIN_TRUST_PROXY_HEADER=<header name>         (self-host behind an auth proxy)
// Setting more than one mode is a misconfiguration and every /admin request is refused.
// Every write goes through store.js (writeRow: sha guard + history row), session "admin".

import PAGE from "./admin.html";
import { json, sha256Hex, validPath, writeRow, restoreAt, classify, MAX_FILE_BYTES } from "./store.js";
import { listProjects, movePath, mergeProjects, setMembership, deleteMembership } from "./layers.js";

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
    const { results } = await env.DB.prepare("SELECT path, content, sha, modified, session FROM files WHERE deleted = 0 ORDER BY path").all();
    return json({
      files: results.map((r) => ({
        path: r.path, sha: r.sha, modified: r.modified, size: bytes(r.content), ...parseFrontmatter(r.content),
        ...classify(r.path),
        // a sync client routed this new file by a fallback rule (several projects in one session); cleared by any admin write
        flagged: /\|routed:/.test(r.session || "") ? String(r.session).split("|routed:")[1] : null,
      })),
      projects: await listProjects(env),
      now: Date.now(),
    });
  }

  if (route === "/move" && method === "POST") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    const r = await movePath(env, b.from, b.to, SESSION);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r);
  }

  if (route === "/unflag" && method === "POST") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    if (!validPath(b.path)) return json({ error: "bad path" }, 400);
    await env.DB.prepare("UPDATE files SET session = ? WHERE path = ? AND session LIKE '%|routed:%'").bind(SESSION, b.path).run();
    return json({ ok: true });
  }

  if (route === "/merge-project" && method === "POST") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    const r = await mergeProjects(env, b.from, b.into, SESSION);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r);
  }

  if (route === "/membership" && method === "PUT") {
    const b = await readBody(req);
    if (isErr(b)) return b;
    const r = await setMembership(env, b.repo, b.pid);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r);
  }

  if (route === "/membership" && method === "DELETE") {
    const r = await deleteMembership(env, q("repo"));
    return r.error ? json({ error: r.error }, r.status || 400) : json(r);
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
    "SELECT id, at, session, event, ok, error, files, cli_version, auto_memory, cwd_name, projects FROM sync_events ORDER BY at DESC, id DESC LIMIT 20"
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

// ---------- self-host auth: login session + trusted proxy header ----------
const SESSION_COOKIE = "memsync_admin";
const SESSION_TTL_MS = 12 * 3600_000;
const MAX_FAILS = 10; // failed logins per minute, process-wide
const revoked = new Map(); // nonce -> exp, so logout kills the cookie even if it was copied
let fails = [];
let procSecret = null;
const hmacKeys = new Map();

function b64uEnc(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || "")) return null;
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function sessionKey(env) {
  let secret = env.ADMIN_SESSION_SECRET;
  if (!secret) {
    // No configured secret: sessions last until the process restarts.
    procSecret ||= b64uEnc(crypto.getRandomValues(new Uint8Array(32)));
    secret = procSecret;
  }
  if (!hmacKeys.has(secret)) {
    hmacKeys.set(secret, await crypto.subtle.importKey("raw", enc.encode("memsync-admin-session-v1\n" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return hmacKeys.get(secret);
}

async function newSessionCookie(env, now = Date.now()) {
  const body = `${now + SESSION_TTL_MS}.${b64uEnc(crypto.getRandomValues(new Uint8Array(16)))}`;
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(body));
  return `${body}.${b64uEnc(sig)}`;
}

// Returns {nonce, exp} for a valid, unexpired, unrevoked session cookie, else null.
async function readSession(req, env) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), b64u(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) return null;
    const exp = Number(parts[0]);
    const now = Date.now();
    if (!Number.isFinite(exp) || exp <= now) return null;
    for (const [n, e] of revoked) if (e <= now) revoked.delete(n);
    if (revoked.has(parts[1])) return null;
    return { nonce: parts[1], exp };
  } catch {
    return null;
  }
}

function cookieHeader(env, value, maxAgeSec) {
  const secure = !/^(0|false|no|off)$/i.test(String(env.ADMIN_COOKIE_SECURE ?? "1"));
  return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

function loginPage(lang, status = 200, error = "") {
  const t = TEXT[lang];
  const other = lang === "zh" ? "en" : "zh";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${HTML_ESC(t.loginTitle)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:380px;margin:12vh auto;padding:0 16px}input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin-top:8px}.err{color:#c33}a{float:right}</style></head>
<body><a href="?lang=${other}">${HTML_ESC(TEXT[other].other)}</a><h1>${HTML_ESC(t.loginTitle)}</h1><p>${HTML_ESC(t.loginBody)}</p>${error ? `<p class="err">${HTML_ESC(error)}</p>` : ""}
<form method="post" action="/admin/login?lang=${lang}"><label>${HTML_ESC(t.tokenLabel)}<input type="password" name="token" autocomplete="current-password" required autofocus></label><button type="submit">${HTML_ESC(t.loginBtn)}</button></form></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const LOGOUT_FORM = '<form method="post" action="/admin/logout" style="display:contents"><button type="submit" data-i="logout"></button></form>';
const redirect = (to, cookie) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) } });
const plain = (text, status) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// Handles /admin/login and /admin/logout in self-host login mode. Returns null for any other path.
async function loginRoutes(req, env, url, lang) {
  const isLogin = url.pathname === "/admin/login";
  if (!isLogin && url.pathname !== "/admin/logout") return null;
  if (req.method !== "POST") return redirect("/admin?lang=" + lang);
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "bad origin" }, 403);

  if (!isLogin) {
    const s = await readSession(req, env);
    if (s) revoked.set(s.nonce, s.exp);
    return redirect("/admin?lang=" + lang, cookieHeader(env, "", 0));
  }

  const now = Date.now();
  fails = fails.filter((t) => t > now - 60_000);
  if (fails.length >= MAX_FAILS) return loginPage(lang, 429, TEXT[lang].tooMany);
  const given = new URLSearchParams(await req.text().catch(() => "")).get("token") || "";
  const got = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(given)));
  const want = hexBytes(env.ADMIN_TOKEN_SHA256);
  if (!want || !ctEqual(got, want)) {
    fails.push(now);
    console.error("admin: login failed");
    return loginPage(lang, 401, TEXT[lang].badToken);
  }
  return redirect("/admin?lang=" + lang, cookieHeader(env, await newSessionCookie(env, now), SESSION_TTL_MS / 1000));
}

function adminMode(env) {
  const modes = [];
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) modes.push("access");
  if (env.ADMIN_TOKEN_SHA256) modes.push("token");
  if (env.ADMIN_TRUST_PROXY_HEADER) modes.push("proxy");
  if (modes.length > 1) return "conflict";
  return modes[0] || null; // null: no mode configured, keep the original Access flow (403 helper page)
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
    deniedProxy: "Authentication required: the reverse proxy did not send the expected identity header.",
    conflict: "Admin auth is misconfigured: set only one of Cloudflare Access, ADMIN_TOKEN_SHA256 and ADMIN_TRUST_PROXY_HEADER.",
    loginTitle: "Admin login",
    loginBody: "Enter the admin token.",
    tokenLabel: "Admin token",
    loginBtn: "Log in",
    badToken: "Wrong token.",
    tooMany: "Too many failed attempts. Try again in a minute.",
    needLogin: "Login required.",
    other: "中文",
  },
  zh: {
    title: "管理后台尚未启用",
    body: "管理后台尚未启用：Cloudflare Access 还没有配置（ACCESS_TEAM_DOMAIN 和 ACCESS_AUD 为空）。",
    steps: "为本主机名创建一个 Self-hosted Access 应用，路径填 /admin，然后把 ACCESS_TEAM_DOMAIN 和 ACCESS_AUD 写进 deploy.env，重新运行 ./deploy.sh。",
    detected: "检测到 Cloudflare Access 登录信息（仅用于配置，尚未校验）：",
    denied: "未通过 Cloudflare Access 身份验证。",
    deniedProxy: "需要先通过身份验证：反向代理没有发送预期的身份 header。",
    conflict: "管理后台的认证配置有冲突：Cloudflare Access、ADMIN_TOKEN_SHA256、ADMIN_TRUST_PROXY_HEADER 只能设置其中一个。",
    loginTitle: "管理后台登录",
    loginBody: "请输入 admin token。",
    tokenLabel: "Admin token",
    loginBtn: "登录",
    badToken: "token 不对。",
    tooMany: "失败次数过多，请一分钟后再试。",
    needLogin: "需要先登录。",
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
  const mode = adminMode(env);
  if (mode === "conflict") {
    console.error("admin: more than one admin auth mode configured");
    return plain(TEXT[lang].conflict, 403);
  }
  const isPage = url.pathname === "/admin" || url.pathname === "/admin/";
  if (mode === "token") {
    const early = await loginRoutes(req, env, url, lang);
    if (early) return early;
    if (!(await readSession(req, env))) {
      return isPage && req.method === "GET" ? loginPage(lang, 401) : json({ error: TEXT[lang].needLogin }, 401);
    }
  } else if (mode === "proxy") {
    if (!(req.headers.get(env.ADMIN_TRUST_PROXY_HEADER) || "").trim()) {
      console.error(`admin: proxy header missing for ${req.method} ${url.pathname}`);
      return plain(TEXT[lang].deniedProxy, 403);
    }
  } else {
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
  }
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    // Only the self-host login mode has a session to end, so only it gets the logout button.
    const page = mode === "token" ? PAGE.replace("<!--SELFHOST_LOGOUT-->", LOGOUT_FORM) : PAGE;
    return new Response(page, { headers: PAGE_HEADERS });
  }
  if (url.pathname.startsWith("/admin/api/")) return await api(req, env, url);
  return json({ error: "not found" }, 404);
}
