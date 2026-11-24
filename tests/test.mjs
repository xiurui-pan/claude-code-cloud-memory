import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, ".state");
const b64u = (b) => Buffer.from(b).toString("base64url");
const mk = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const good = mk(), evil = mk();
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwks = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ keys: [jwk] })); }).listen(8799);
const TEAM = "http://127.0.0.1:8799", AUD = "aud123";
function tok(over = {}, key = good.privateKey, kid = "k1") {
  const now = Math.floor(Date.now() / 1000);
  const p = { aud: [AUD], iss: TEAM, exp: now + 600, nbf: now - 10, email: "x@example.invalid", ...over };
  const h = b64u(JSON.stringify({ alg: "RS256", kid })), b = b64u(JSON.stringify(p));
  const sig = crypto.sign("sha256", Buffer.from(h + "." + b), key);
  return h + "." + b + "." + b64u(sig);
}
const spawnW = (port, vars) => spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port+100), "--persist-to", STATE, ...vars.flatMap((v) => ["--var", v])], { cwd: HERE, detached: true, stdio: ["ignore", "ignore", "inherit"] });
async function up(port) { for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch { await new Promise((r) => setTimeout(r, 500)); } } throw new Error("no start"); }
// fresh DB each run
import fs from "node:fs"; fs.rmSync(STATE, { recursive: true, force: true });
spawnSync("npx", ["wrangler", "d1", "execute", "memsync-test", "--local", "--persist-to", STATE, "--file", path.join(HERE, "..", "worker", "schema.sql")], { cwd: HERE, stdio: "ignore" });
const w1 = spawnW(8801, [`ACCESS_TEAM_DOMAIN:${TEAM}`, `ACCESS_AUD:${AUD}`, "TOKEN_SHA256:" + crypto.createHash("sha256").update("sekret").digest("hex")]);
const w2 = spawnW(8802, ["ACCESS_TEAM_DOMAIN:", "ACCESS_AUD:", "TOKEN_SHA256:" + crypto.createHash("sha256").update("sekret").digest("hex")]);
await up(8801); await up(8802);
const B = "http://127.0.0.1:8801";
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const A = (path, o = {}, token = tok()) => fetch(B + path, { ...o, headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", ...(o.headers || {}) } });
const bearer = { authorization: "Bearer sekret" };

await t("unconfigured -> 403", async () => { const r = await fetch("http://127.0.0.1:8802/admin"); assert.equal(r.status, 403); assert((await r.text()).includes("not configured"));
  const rz = await fetch("http://127.0.0.1:8802/admin", { headers: { "accept-language": "zh-CN,zh;q=0.9" } }); assert.equal(rz.status, 403); assert((await rz.text()).includes("尚未启用"));
  const rq = await fetch("http://127.0.0.1:8802/admin?lang=zh"); assert((await rq.text()).includes("尚未启用")); const r2 = await fetch("http://127.0.0.1:8802/admin/api/files", { headers: bearer }); assert.equal(r2.status, 403); });
await t("health + client public", async () => { assert.equal((await fetch(B + "/health")).status, 200); assert.equal((await fetch(B + "/client/memsync.py")).status, 200); });
await t("missing token 403", async () => assert.equal((await fetch(B + "/admin")).status, 403));
await t("bearer rejected on /admin", async () => { assert.equal((await fetch(B + "/admin", { headers: bearer })).status, 403); assert.equal((await fetch(B + "/admin/api/files", { headers: bearer })).status, 403); });
await t("bad sig", async () => assert.equal((await A("/admin", {}, tok({}, evil.privateKey))).status, 403));
await t("wrong aud", async () => assert.equal((await A("/admin", {}, tok({ aud: ["zzz"] }))).status, 403));
await t("wrong iss", async () => assert.equal((await A("/admin", {}, tok({ iss: "https://evil" }))).status, 403));
await t("expired", async () => assert.equal((await A("/admin", {}, tok({ exp: Math.floor(Date.now() / 1000) - 5 }))).status, 403));
await t("nbf future", async () => assert.equal((await A("/admin", {}, tok({ nbf: Math.floor(Date.now() / 1000) + 3600 }))).status, 403));
await t("unknown kid", async () => assert.equal((await A("/admin", {}, tok({}, good.privateKey, "nope"))).status, 403));
await t("alg none/garbage", async () => assert.equal((await A("/admin", {}, "a.b.c")).status, 403));
await t("valid JWT -> page (header)", async () => { const r = await A("/admin"); assert.equal(r.status, 200); const html = await r.text(); assert(html.includes("Memory admin") && html.includes("记忆库管理") && html.includes("navigator.language")); });
await t("valid JWT via cookie", async () => { const r = await fetch(B + "/admin", { headers: { cookie: "x=1; CF_Authorization=" + tok() } }); assert.equal(r.status, 200); });

// /v1 sync still works
const push = (files) => fetch(B + "/v1/push", { method: "POST", headers: bearer, body: JSON.stringify({ session: "t", files }) }).then((r) => r.json());
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
await t("v1 no bearer 401", async () => assert.equal((await fetch(B + "/v1/pull")).status, 401));
const SYNC = "---\nname: Sync\ndescription: d1\nmetadata:\n  type: feedback\n---\nbody\n";
await t("v1 push + pull", async () => {
  const r = await push([{ path: "sync_a.md", content: SYNC, base_sha: null }, { path: "MEMORY.md", content: "# idx\n", base_sha: null }]);
  assert.equal(r.results[0].status, "written");
  const p = await (await fetch(B + "/v1/pull", { headers: bearer })).json();
  assert(p.files.find((f) => f.path === "sync_a.md" && f.sha === sha(SYNC)));
});
await t("admin list parses frontmatter", async () => {
  const d = await (await A("/admin/api/files")).json();
  const f = d.files.find((x) => x.path === "sync_a.md");
  assert.equal(f.name, "Sync"); assert.equal(f.description, "d1"); assert.equal(f.type, "feedback"); assert.equal(f.size, SYNC.length);
});
let s1;
await t("admin create", async () => {
  const c = "---\nname: N\ndescription: D\nmetadata:\n  type: user\n---\nhello 你好\n";
  const r = await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "adm.md", content: c, base_sha: null }) });
  assert.equal(r.status, 200); s1 = (await r.json()).sha; assert.equal(s1, sha(c));
  assert.equal((await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "adm.md", content: "x", base_sha: null }) })).status, 409);
});
await t("validation (path/size/ctype/origin)", async () => {
  assert.equal((await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "../x.md", content: "x" }) })).status, 400);
  assert.equal((await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "big.md", content: "x".repeat(200001) }) })).status, 413);
  assert.equal((await A("/admin/api/file", { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await A("/admin/api/file", { method: "PUT", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
});
await t("update + 409 on stale sha", async () => {
  const r = await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "adm.md", content: "v2\n", base_sha: s1 }) });
  assert.equal(r.status, 200);
  const r2 = await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "adm.md", content: "v3\n", base_sha: s1 }) });
  assert.equal(r2.status, 409); assert.equal((await r2.json()).sha, sha("v2\n"));
});
await t("sync client sees admin write; admin sees sync write", async () => {
  const p = await (await fetch(B + "/v1/pull", { headers: bearer })).json();
  assert.equal(p.files.find((f) => f.path === "adm.md").sha, sha("v2\n"));
  const r = await push([{ path: "adm.md", content: "v4 from sync\n", base_sha: sha("v2\n") }]);
  assert.equal(r.results[0].status, "written");
  const g = await (await A("/admin/api/file?path=adm.md")).json(); assert.equal(g.content, "v4 from sync\n");
});
let hist;
await t("history + version", async () => {
  hist = (await (await A("/admin/api/history?path=adm.md")).json()).history;
  assert.equal(hist.length, 3); assert.equal(hist[2].session, "admin"); assert.equal(hist[0].session, "t");
  const v = await (await A("/admin/api/version?id=" + hist[2].id)).json(); assert(v.content.includes("hello 你好"));
});
await t("restore single file (409 stale, then ok)", async () => {
  const body = (b) => JSON.stringify({ path: "adm.md", id: hist[2].id, base_sha: b });
  assert.equal((await A("/admin/api/restore-file", { method: "POST", body: body(s1) })).status, 409);
  const r = await A("/admin/api/restore-file", { method: "POST", body: body(sha("v4 from sync\n")) });
  assert.equal(r.status, 200);
  const g = await (await A("/admin/api/file?path=adm.md")).json(); assert.equal(g.sha, s1);
  const p = await (await fetch(B + "/v1/pull", { headers: bearer })).json();
  assert.equal(p.files.find((f) => f.path === "adm.md").sha, s1);
});
await t("delete with sha guard", async () => {
  assert.equal((await A("/admin/api/file?path=adm.md&base_sha=bad", { method: "DELETE" })).status, 409);
  assert.equal((await A("/admin/api/file?path=adm.md&base_sha=" + s1, { method: "DELETE" })).status, 200);
  assert.equal((await A("/admin/api/file?path=adm.md")).status, 404);
  const p = await (await fetch(B + "/v1/pull", { headers: bearer })).json(); assert(!p.files.find((f) => f.path === "adm.md"));
  // restore deleted one
  const h = (await (await A("/admin/api/history?path=adm.md")).json()).history;
  const live = h.find((x) => !x.deleted);
  assert.equal((await A("/admin/api/restore-file", { method: "POST", body: JSON.stringify({ path: "adm.md", id: live.id, base_sha: null }) })).status, 200);
  assert.equal((await A("/admin/api/file?path=adm.md")).status, 200);
});
await t("restore-all (admin + /v1/restore)", async () => {
  const at = Date.now(); await new Promise((r) => setTimeout(r, 20));
  await A("/admin/api/file", { method: "PUT", body: JSON.stringify({ path: "late.md", content: "late", base_sha: null }) });
  const r = await (await A("/admin/api/restore", { method: "POST", body: JSON.stringify({ at }) })).json();
  assert(r.changed.includes("late.md"));
  assert.equal((await A("/admin/api/file?path=late.md")).status, 404);
  const r2 = await (await fetch(B + "/v1/restore", { method: "POST", headers: bearer, body: JSON.stringify({ at }) })).json();
  assert.deepEqual(r2.changed, []);
});
for (const w of [w1, w2]) try { process.kill(-w.pid, "SIGKILL"); } catch {}
jwks.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
