// Self-hosted runtime for the memory server: runs worker/index.js unchanged on plain Node 22+.
//   - D1 shim over node:sqlite (the subset worker/*.js uses)
//   - node:http adapter: Node request -> WHATWG Request -> worker fetch() -> streamed Response
// No npm dependencies. Configuration is read from the environment, see selfhost/README in the main README.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { register } from "node:module";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const die = (msg) => { console.error("memsync: " + msg); process.exit(1); };

// ---------- config ----------
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || "0.0.0.0";
const DB_PATH = path.resolve(env.DB_PATH || "./data/memory.db");
const MAX_BODY = Number(env.MAX_BODY_BYTES || 100 * 1024 * 1024);
const PUBLIC_URL = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null; // e.g. https://memory.example.com

const isHash = (v) => /^[0-9a-f]{64}$/i.test(v || "");
if (!isHash(env.TOKEN_SHA256)) die("TOKEN_SHA256 is required: the SHA-256 hex (64 chars) of the access token");
if (env.ADMIN_TOKEN_SHA256 && !isHash(env.ADMIN_TOKEN_SHA256)) die("ADMIN_TOKEN_SHA256 must be 64 hex chars");
if (env.ADMIN_TOKEN_SHA256 && env.ADMIN_TOKEN_SHA256.toLowerCase() === env.TOKEN_SHA256.toLowerCase()) die("ADMIN_TOKEN_SHA256 must differ from TOKEN_SHA256 (use a separate admin token)");
const adminModes = [env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD, env.ADMIN_TOKEN_SHA256, env.ADMIN_TRUST_PROXY_HEADER].filter(Boolean);
if (adminModes.length > 1) die("set only one admin auth mode: ADMIN_TOKEN_SHA256, ADMIN_TRUST_PROXY_HEADER, or ACCESS_TEAM_DOMAIN + ACCESS_AUD");
if (!adminModes.length) console.warn("memsync: no admin auth configured, /admin will answer 403 (set ADMIN_TOKEN_SHA256 to enable it)");

// ---------- D1 shim ----------
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  _prep() { return this.db.prepare(this.sql); }
  async first(col) {
    const row = this._prep().get(...this.params);
    if (row === undefined) return null;
    return col === undefined ? { ...row } : row[col];
  }
  async all() {
    const results = this._prep().all(...this.params).map((r) => ({ ...r }));
    return { results, success: true, meta: { changes: 0, rows_read: results.length } };
  }
  async run() {
    const r = this._prep().run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() { return this._prep().all(...this.params).map((r) => Object.values(r)); }
  // Used by batch(): run synchronously inside the surrounding transaction.
  _runSync() {
    const stmt = this._prep();
    if (stmt.columns().length) {
      const results = stmt.all(...this.params).map((r) => ({ ...r }));
      return { results, success: true, meta: { changes: 0 } };
    }
    const r = stmt.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async exec(sql) { this.db.exec(sql); return { count: 1, duration: 0 }; }
  // D1 batch is atomic; all statements run in one transaction.
  async batch(stmts) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = stmts.map((s) => s._runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
sqlite.exec(fs.readFileSync(path.join(HERE, "..", "worker", "schema.sql"), "utf8")); // idempotent (IF NOT EXISTS)
// Versioned migrations (worker/migrations/NNN_name.sql): each file records itself in schema_version.
{
  const dir = path.join(HERE, "..", "worker", "migrations");
  const applied = sqlite.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get().v;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort() : [];
  for (const f of files) {
    const version = parseInt(f, 10);
    if (version <= applied) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      die(`migration ${f} failed: ${e.message}`);
    }
    console.log(`memsync: applied migration ${f}`);
  }
}

// ---------- worker bootstrap ----------
// Workers provide crypto.subtle.timingSafeEqual (used by index.js); Node's WebCrypto does not.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: (a, b) => a.byteLength === b.byteLength && nodeCrypto.timingSafeEqual(a, b),
    configurable: true,
  });
}
register("./text-loader.mjs", import.meta.url); // memsync.py and admin.html become string modules
const worker = (await import("../worker/index.js")).default;

const workerEnv = {
  DB: new D1(sqlite),
  TOKEN_SHA256: env.TOKEN_SHA256,
  ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN || "",
  ACCESS_AUD: env.ACCESS_AUD || "",
  ADMIN_TOKEN_SHA256: env.ADMIN_TOKEN_SHA256 || "",
  ADMIN_TRUST_PROXY_HEADER: env.ADMIN_TRUST_PROXY_HEADER || "",
  ADMIN_SESSION_SECRET: env.ADMIN_SESSION_SECRET || "",
  // Secure cookies need HTTPS; set ADMIN_COOKIE_SECURE=0 only for http://localhost testing.
  ADMIN_COOKIE_SECURE: env.ADMIN_COOKIE_SECURE ?? "1",
};
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}), passThroughOnException() {} };

// ---------- http adapter ----------
async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const base = PUBLIC_URL ? PUBLIC_URL.origin : `http://${req.headers.host || "localhost"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(base + req.url, { method: req.method, headers, body: hasBody ? await readBody(req) : undefined });
    const response = await worker.fetch(request, workerEnv, ctx);
    const out = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === "HEAD") return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error("memsync: request failed: " + String((e && e.message) || e));
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: status === 413 ? "payload too large" : "internal error" }));
  }
});

server.listen(PORT, HOST, () => console.log(`memsync: listening on ${HOST}:${PORT}, database ${DB_PATH}`));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { sqlite.close(); process.exit(0); }));
  // Do not hang on keep-alive connections.
  process.on(sig, () => setTimeout(() => process.exit(0), 3000).unref());
}
