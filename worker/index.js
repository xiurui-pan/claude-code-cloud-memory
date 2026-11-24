// Claude Code cloud-session memory sync.
// Stores the native auto-memory directory (MEMORY.md + one .md per memory) in D1,
// with full version history for rollback.
//
// Routes
//   GET  /health                 public
//   GET  /client/memsync.py      public: the hook client (contains no secrets)
//   GET  /v1/pull                all live files
//   POST /v1/push                per-file changes, guarded by base_sha
//   GET  /v1/history?path=&limit=&content=1
//   POST /v1/restore {at: epoch_ms}   restore every file to its state at that time
//   POST /v1/status {session,event,ok,error,files,cli_version,auto_memory,cwd_name}  client sync report
// Auth: Authorization: Bearer <token>; the Worker only knows SHA-256(token).
//   /admin, /admin/api/*  admin UI, Cloudflare Access JWT only (see admin.js)

import CLIENT from "./memsync.py";
import { MAX_FILE_BYTES, json, sha256Bytes, validPath, applyOne, restoreAt, recordStatus } from "./store.js";
import { handleAdmin } from "./admin.js";

const MAX_FILES_PER_PUSH = 500;


export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/client/memsync.py" && req.method === "GET") {
        return new Response(CLIENT, { headers: { "content-type": "text/x-python; charset=utf-8" } });
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(req, env, url);
      if (!(await authorized(req, env))) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET" && url.pathname === "/v1/pull") return await pull(env);
      if (req.method === "POST" && url.pathname === "/v1/push") return await push(req, env);
      if (req.method === "GET" && url.pathname === "/v1/history") return await history(url, env);
      if (req.method === "POST" && url.pathname === "/v1/restore") return await restore(req, env);
      if (req.method === "POST" && url.pathname === "/v1/status") {
        const err = await recordStatus(env, await req.json().catch(() => null));
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(`${req.method} ${url.pathname} failed: ${String((e && e.message) || e)}`);
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};



function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function authorized(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.TOKEN_SHA256 || env.TOKEN_SHA256.length !== 64) return false;
  const got = await sha256Bytes(m[1].trim());
  const want = hexToBytes(env.TOKEN_SHA256.toLowerCase());
  return crypto.subtle.timingSafeEqual(got, want);
}


async function pull(env) {
  const { results } = await env.DB.prepare(
    "SELECT path, content, sha, modified FROM files WHERE deleted = 0 ORDER BY path"
  ).all();
  return json({ files: results, now: Date.now() });
}


async function push(req, env) {
  const body = await req.json();
  const session = String(body.session || "").slice(0, 100) || null;
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES_PER_PUSH) return json({ error: "too many files" }, 413);
  const results = [];
  for (const f of files) {
    if (!f || !validPath(f.path)) {
      results.push({ path: f && f.path, status: "rejected_path" });
      continue;
    }
    if (typeof f.content === "string" && new TextEncoder().encode(f.content).length > MAX_FILE_BYTES) {
      results.push({ path: f.path, status: "rejected_size" });
      continue;
    }
    results.push(await applyOne(env, f, session));
  }
  return json({ results, now: Date.now() });
}

async function history(url, env) {
  const path = url.searchParams.get("path");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
  const withContent = url.searchParams.get("content") === "1";
  const cols = withContent ? "id, path, content, sha, deleted, session, at" : "id, path, sha, deleted, session, at";
  const stmt = path
    ? env.DB.prepare(`SELECT ${cols} FROM history WHERE path = ? ORDER BY id DESC LIMIT ?`).bind(path, limit)
    : env.DB.prepare(`SELECT ${cols} FROM history ORDER BY id DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all();
  return json({ history: results });
}

async function restore(req, env) {
  const body = await req.json();
  const at = Number(body.at);
  if (!Number.isFinite(at) || at <= 0) return json({ error: "body.at must be epoch milliseconds" }, 400);
  const changed = await restoreAt(env, at);
  return json({ restored_to: at, changed });
}
