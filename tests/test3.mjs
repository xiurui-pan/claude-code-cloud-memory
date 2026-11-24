// Self-host admin auth: login form + signed session cookie, and trusted proxy header mode. Node backend only.
import crypto from "node:crypto";
import assert from "node:assert";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start, up, BACKEND } from "./backend.mjs";

if (BACKEND !== "node") { console.log("skipped: self-host admin auth only exists on the node backend"); process.exit(0); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const SYNC = sha("sekret"), ADMIN = "admin-secret-token", SECRET = "test-session-secret-0123456789";
const S1 = "http://127.0.0.1:8821", S2 = "http://127.0.0.1:8822", S3 = "http://127.0.0.1:8823", S4 = "http://127.0.0.1:8824";
const base = { TOKEN_SHA256: SYNC, ADMIN_COOKIE_SECURE: "0" };
const servers = [
  start({ port: 8821, state: path.join(HERE, ".state3a"), vars: { ...base, ADMIN_TOKEN_SHA256: sha(ADMIN), ADMIN_SESSION_SECRET: SECRET } }),
  start({ port: 8822, state: path.join(HERE, ".state3b"), vars: { TOKEN_SHA256: SYNC, ADMIN_TOKEN_SHA256: sha(ADMIN) } }), // default: Secure cookie, random session key
  start({ port: 8823, state: path.join(HERE, ".state3c"), vars: { ...base, ADMIN_TRUST_PROXY_HEADER: "X-Auth-User" } }),
  start({ port: 8824, state: path.join(HERE, ".state3d"), vars: { ...base, ADMIN_TOKEN_SHA256: sha(ADMIN) } }), // throttle test
];
for (const p of [8821, 8822, 8823, 8824]) await up(p);

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const form = (B, token, extra = {}) => fetch(B + "/admin/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams({ token }) });
const cookieOf = (r) => (r.headers.getSetCookie()[0] || "").split(";")[0];
const login = async (B = S1) => cookieOf(await form(B, ADMIN));
const get = (B, p, headers = {}) => fetch(B + p, { redirect: "manual", headers });
const mac = (body, secret = SECRET) => crypto.createHmac("sha256", "memsync-admin-session-v1\n" + secret).update(body).digest("base64url");

await t("no cookie: /admin shows the login form (401), en + zh", async () => {
  const r = await get(S1, "/admin"); assert.equal(r.status, 401);
  const h = await r.text(); assert(h.includes("Admin login") && h.includes('name="token"') && h.includes('type="password"') && !h.includes("Memory admin"));
  const z = await (await get(S1, "/admin", { "accept-language": "zh-CN,zh;q=0.9" })).text(); assert(z.includes("管理后台登录") && z.includes("登录"));
  assert((await (await get(S1, "/admin?lang=zh")).text()).includes("管理后台登录"));
});
await t("no cookie: API is 401, bearer tokens do not work on /admin", async () => {
  assert.equal((await get(S1, "/admin/api/files")).status, 401);
  assert.equal((await get(S1, "/admin/api/files", { authorization: "Bearer sekret" })).status, 401);
  assert.equal((await get(S1, "/admin/api/files", { authorization: "Bearer " + ADMIN })).status, 401);
  assert.equal((await fetch(S1 + "/admin/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "x.md", content: "x" }) })).status, 401);
});
await t("bad token: 401, no cookie, error shown; empty token too", async () => {
  for (const tk of ["nope", "", ADMIN + " ", SYNC]) { const r = await form(S1, tk); assert.equal(r.status, 401); assert.equal(r.headers.getSetCookie().length, 0); assert((await r.text()).includes("Wrong token")); }
  const rz = await fetch(S1 + "/admin/login?lang=zh", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=bad" }); assert((await rz.text()).includes("token 不对"));
});
let cookie;
await t("good token: 303 to /admin, HttpOnly + SameSite=Strict + Path=/admin cookie", async () => {
  const r = await form(S1, ADMIN); assert.equal(r.status, 303); assert.equal(new URL(r.headers.get("location"), S1).pathname, "/admin");
  const sc = r.headers.getSetCookie(); assert.equal(sc.length, 1);
  assert(sc[0].startsWith("memsync_admin=") && /;\s*HttpOnly/i.test(sc[0]) && /;\s*SameSite=Strict/i.test(sc[0]) && /;\s*Path=\/admin(;|$)/.test(sc[0]) && /Max-Age=\d+/.test(sc[0]));
  assert(!/;\s*Secure/i.test(sc[0]), "ADMIN_COOKIE_SECURE=0 must drop Secure");
  cookie = cookieOf(r);
});
await t("Secure is the default", async () => { const r = await form(S2, ADMIN); assert.equal(r.status, 303); assert(/;\s*Secure/i.test(r.headers.getSetCookie()[0])); });
await t("cookie: page (with logout button) and API work", async () => {
  const r = await get(S1, "/admin", { cookie }); assert.equal(r.status, 200);
  const h = await r.text(); assert(h.includes("Memory admin") && h.includes('action="/admin/logout"') && h.includes("记忆库管理") && h.includes('logout:"退出登录"'));
  assert.equal((await get(S1, "/admin/api/files", { cookie })).status, 200);
  const w = await fetch(S1 + "/admin/api/file", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ path: "sh.md", content: "hello\n", base_sha: null }) });
  assert.equal(w.status, 200);
  const p = await (await fetch(S1 + "/v1/pull", { headers: { authorization: "Bearer sekret" } })).json(); assert(p.files.some((f) => f.path === "sh.md"));
});
await t("cookie: cross-origin write refused, wrong cookie name ignored", async () => {
  const w = await fetch(S1 + "/admin/api/file", { method: "PUT", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }); assert.equal(w.status, 403);
  assert.equal((await get(S1, "/admin/api/files", { cookie: cookie.replace("memsync_admin", "other") })).status, 401);
});
await t("tampered / forged / expired cookies are rejected", async () => {
  const [exp, nonce, sig] = cookie.split("=")[1].split(".");
  const bad = [
    `${exp}.${nonce}.${sig.slice(0, -2)}AA`,                 // signature changed
    `${Number(exp) + 1e9}.${nonce}.${sig}`,                   // expiry extended
    `${exp}.${nonce}x.${sig}`,                                // nonce changed
    `${exp}.${nonce}`, "garbage", "a.b.c", "",                // wrong shapes
    (() => { const b = `${Date.now() + 1e6}.forged`; return `${b}.${mac(b, "other-secret")}`; })(), // signed with another secret
    (() => { const b = `${Date.now() - 1000}.expired`; return `${b}.${mac(b)}`; })(),                // validly signed but expired
  ];
  for (const v of bad) assert.equal((await get(S1, "/admin/api/files", { cookie: "memsync_admin=" + v })).status, 401, v);
  const b = `${Date.now() + 1e6}.handmade`; // sanity: our own mac() matches the server, so the rejections above are real
  assert.equal((await get(S1, "/admin/api/files", { cookie: `memsync_admin=${b}.${mac(b)}` })).status, 200);
});
await t("cookie from a server with a different session key is rejected", async () => {
  const c2 = await login(S2); assert.equal((await get(S2, "/admin/api/files", { cookie: c2 })).status, 200);
  assert.equal((await get(S1, "/admin/api/files", { cookie: c2 })).status, 401);
});
await t("login CSRF: cross-origin login POST refused", async () => { const r = await form(S1, ADMIN, { origin: "https://evil.example" }); assert.equal(r.status, 403); assert.equal(r.headers.getSetCookie().length, 0); });
await t("GET /admin/login redirects, logout needs POST", async () => {
  const r = await get(S1, "/admin/login"); assert.equal(r.status, 303);
  const l = await get(S1, "/admin/logout", { cookie }); assert.equal(l.status, 303);
  assert.equal((await get(S1, "/admin/api/files", { cookie })).status, 200, "GET /admin/logout must not log out");
});
await t("logout: clears cookie and revokes the old one", async () => {
  const c = await login();
  assert.equal((await get(S1, "/admin/api/files", { cookie: c })).status, 200);
  const r = await fetch(S1 + "/admin/logout", { method: "POST", redirect: "manual", headers: { cookie: c } });
  assert.equal(r.status, 303); assert(/Max-Age=0/.test(r.headers.getSetCookie()[0]));
  assert.equal((await get(S1, "/admin/api/files", { cookie: c })).status, 401, "replayed cookie must fail");
  assert.equal((await get(S1, "/admin/api/files", { cookie })).status, 200, "other sessions stay valid");
  const out = await fetch(S1 + "/admin/logout", { method: "POST", redirect: "manual", headers: { cookie: c, origin: "https://evil.example" } }); assert.equal(out.status, 403);
});
await t("/v1 is unaffected: bearer works, admin token does not", async () => {
  assert.equal((await fetch(S1 + "/v1/pull", { headers: { authorization: "Bearer sekret" } })).status, 200);
  assert.equal((await fetch(S1 + "/v1/pull", { headers: { authorization: "Bearer " + ADMIN } })).status, 401);
  assert.equal((await fetch(S1 + "/v1/pull", { headers: { cookie } })).status, 401);
});
await t("login throttle: 429 after 10 failures in a minute", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await form(S4, "bad" + i)).status, 401);
  assert.equal((await form(S4, ADMIN)).status, 429);
});

// ---- trusted proxy header mode ----
const PH = (v = "x@example.invalid") => ({ "x-auth-user": v });
await t("proxy mode: header required (403 without, empty, whitespace)", async () => {
  assert.equal((await get(S3, "/admin")).status, 403);
  assert.equal((await get(S3, "/admin", PH(""))).status, 403);
  assert.equal((await get(S3, "/admin/api/files", PH("   "))).status, 403);
  assert.equal((await get(S3, "/admin/api/files", { authorization: "Bearer sekret" })).status, 403);
  assert.equal((await get(S3, "/admin/api/files", { "x-other": "x" })).status, 403);
  assert((await (await get(S3, "/admin?lang=zh")).text()).includes("反向代理"));
});
await t("proxy mode: header grants page + API, no logout button", async () => {
  const r = await get(S3, "/admin", PH()); assert.equal(r.status, 200);
  const h = await r.text(); assert(h.includes("Memory admin") && !h.includes('action="/admin/logout"'));
  assert.equal((await get(S3, "/admin/api/files", PH())).status, 200);
  const w = await fetch(S3 + "/admin/api/file", { method: "PUT", headers: { ...PH(), "content-type": "application/json" }, body: JSON.stringify({ path: "px.md", content: "p\n", base_sha: null }) }); assert.equal(w.status, 200);
  const x = await fetch(S3 + "/admin/api/file", { method: "PUT", headers: { ...PH(), origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }); assert.equal(x.status, 403);
});
await t("proxy mode: no login routes, /v1 unaffected", async () => {
  assert.equal((await form(S3, ADMIN)).status, 403);
  assert.equal((await get(S3, "/v1/pull", PH())).status, 401);
  assert.equal((await fetch(S3 + "/v1/pull", { headers: { authorization: "Bearer sekret" } })).status, 200);
});

// ---- startup validation ----
const run = (vars) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(HERE, "..", "selfhost", "server.mjs")], { cwd: HERE, encoding: "utf8", timeout: 10000,
  env: { PATH: process.env.PATH, PORT: "8829", DB_PATH: path.join(HERE, ".state3e", "m.db"), ...vars } });
await t("startup refuses bad config", async () => {
  let r = run({}); assert.notEqual(r.status, 0); assert(r.stderr.includes("TOKEN_SHA256 is required"));
  r = run({ TOKEN_SHA256: "abc" }); assert.notEqual(r.status, 0);
  r = run({ TOKEN_SHA256: SYNC, ADMIN_TOKEN_SHA256: sha(ADMIN), ADMIN_TRUST_PROXY_HEADER: "X-Auth-User" }); assert.notEqual(r.status, 0); assert(r.stderr.includes("only one admin auth mode"));
  r = run({ TOKEN_SHA256: SYNC, ADMIN_TOKEN_SHA256: SYNC }); assert.notEqual(r.status, 0); assert(r.stderr.includes("must differ"));
  r = run({ TOKEN_SHA256: SYNC, ADMIN_TOKEN_SHA256: "short" }); assert.notEqual(r.status, 0);
});

servers.forEach((s) => s.stop());
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
