import http from "node:http"; import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os";
import { spawnSync } from "node:child_process"; import { start, up, BACKEND } from "./backend.mjs"; import assert from "node:assert";
import path from "node:path"; import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const b64u = (b) => Buffer.from(b).toString("base64url");
const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...kp.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ keys: [jwk] })); }).listen(8798);
const TEAM = "http://127.0.0.1:8798", AUD = "aud2"; const now0 = Math.floor(Date.now() / 1000);
const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), p = b64u(JSON.stringify({ aud: [AUD], iss: TEAM, exp: now0 + 3600, nbf: now0 - 10 }));
const jwt = h + "." + p + "." + b64u(crypto.sign("sha256", Buffer.from(h + "." + p), kp.privateKey));
const D = path.join(HERE, ".state2");
const w = start({ port: 8811, state: D, vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, TOKEN_SHA256: crypto.createHash("sha256").update("sekret").digest("hex") } });
console.log("backend:", BACKEND);
const B = "http://127.0.0.1:8811";
await up(8811);
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const bearer = { authorization: "Bearer sekret", "content-type": "application/json" };
const post = (b) => fetch(B + "/v1/status", { method: "POST", headers: bearer, body: JSON.stringify(b) });
const status = async () => (await fetch(B + "/admin/api/status", { headers: { "cf-access-jwt-assertion": jwt } })).json();
const sql = w.sql;
const wipe = () => sql("DELETE FROM sync_events");
const day = 864e5, ev = (o) => ({ session: "s", event: "pull", ok: true, error: null, files: 1, cli_version: "1.0.0", auto_memory: "unknown", cwd_name: "x", ...o });
const mem = fs.mkdtempSync(os.tmpdir() + "/m-"), stt = fs.mkdtempSync(os.tmpdir() + "/s-");
const wsEmpty = fs.mkdtempSync(os.tmpdir() + "/ws-"), gfile = os.tmpdir() + "/gclaude-" + process.pid + ".md"; // no repo -> project _norepo
const run = (cmd, over = {}, st = stt, input = "{}") => { const e = { ...process.env, MEMSYNC_URL: B, MEMSYNC_DIR: mem, MEMSYNC_STATE: st, MEMSYNC_TOKEN: "sekret", MEMSYNC_WORKSPACE: wsEmpty, MEMSYNC_GLOBAL_FILE: gfile, CLAUDE_CODE_REMOTE_SESSION_ID: "tsess", HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*", ...over }; return spawnSync("python3", [path.join(HERE, "..", "worker", "memsync.py"), cmd], { input, env: e, encoding: "utf8" }); };
const dead = { MEMSYNC_URL: "http://127.0.0.1:1" };
const tm = (f) => JSON.parse(fs.readFileSync(stt + "/notify.json", "utf8"));

await t("/v1/status needs bearer", async () => { assert.equal((await fetch(B + "/v1/status", { method: "POST", body: "{}" })).status, 401); });
await t("/v1/status validates", async () => { assert.equal((await post({ event: "bogus" })).status, 400); assert.equal((await post(ev({}))).status, 200); const r = sql("SELECT * FROM sync_events"); assert.equal(r.length, 1); assert.equal(r[0].ok, 1); });
await t("field clipping", async () => { await post(ev({ error: "x".repeat(5000), cli_version: "v".repeat(500), session: "s".repeat(500) })); const r = sql("SELECT length(error) e, length(cli_version) c, length(session) s FROM sync_events ORDER BY id DESC LIMIT 1")[0]; assert.deepEqual([r.e, r.c, r.s], [200, 40, 100]); });
await t("prune to 2000", async () => { sql("DELETE FROM sync_events"); sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2100) INSERT INTO sync_events (at,event,ok) SELECT 1,'pull',1 FROM n"); await post(ev({})); assert.equal(sql("SELECT COUNT(*) c FROM sync_events")[0].c, 2000); });

const rules = [
 ["RED failures no success after", async () => { await wipe(); await post(ev({ at: Date.now() - 2000 })); await post(ev({ ok: false, error: "HTTP 401", at: Date.now() - 1000 })); const s = await status(); assert(s.health.some((x) => x.level === "red" && x.code === "sync_failing")); assert.equal(s.consecutive_failures, 1); }],
 ["no RED when success after failure", async () => { await wipe(); await post(ev({ ok: false, at: Date.now() - 2000 })); await post(ev({ at: Date.now() - 1000 })); const s = await status(); assert.equal(s.consecutive_failures, 0); assert.deepEqual(s.health.map((x) => x.level), ["green"]); }],
 ["RED auto_memory=false", async () => { await wipe(); await post(ev({ auto_memory: "false", at: Date.now() - 2 * day })); await post(ev({})); const s = await status(); assert(s.health.some((x) => x.code === "auto_memory_off" && x.level === "red")); }],
 ["YELLOW no events in 3 days", async () => { await wipe(); await post(ev({ at: Date.now() - 4 * day })); const s = await status(); assert(s.health.some((x) => x.code === "no_recent_events" && x.level === "yellow")); }],
 ["YELLOW no events at all", async () => { await wipe(); assert(((await status()).health).some((x) => x.code === "no_events")); }],
 ["YELLOW cli upgraded", async () => { await wipe(); await post(ev({ cli_version: "2.0.0", at: Date.now() - 6.5 * day })); await post(ev({ cli_version: "2.1.0", at: Date.now() - 1000 })); const s = await status(); assert(s.health.some((x) => x.code === "cli_upgraded" && x.message.includes("upgraded to 2.1.0") && x.params.version === "2.1.0")); assert.equal(s.versions.length, 2); assert.equal(s.recent.length, 2); assert(s.last_success); }],
 ["no upgrade flag for first-ever version", async () => { await wipe(); await post(ev({ cli_version: "2.0.0" })); assert(!(await status()).health.some((x) => x.code === "cli_upgraded")); }],
];
for (const [n, f] of rules) await t("health: " + n, f);
await t("admin status needs Access", async () => { assert.equal((await fetch(B + "/admin/api/status", { headers: bearer })).status, 403); });

// ---- memsync client ----
await wipe();
await t("pull failure -> JSON systemMessage + additionalContext, exit 0", async () => { const r = run("pull", dead); assert.equal(r.status, 0); const j = JSON.parse(r.stdout); assert(j.systemMessage.startsWith("Memory sync: pull failed (")); assert(j.systemMessage.includes("no persistent memory was loaded")); assert.equal(j.hookSpecificOutput.hookEventName, "SessionStart"); assert.equal(j.hookSpecificOutput.additionalContext, j.systemMessage); console.log("   ", j.systemMessage); });
await t("pull failure queued locally", async () => { const q = JSON.parse(fs.readFileSync(stt + "/status_queue.json", "utf8")); assert.equal(q.length, 1); assert.equal(q[0].ok, false); });
fs.writeFileSync(mem + "/a.md", "---\nname: a\n---\nhello\n"); fs.writeFileSync(mem + "/b.md", "bbb\n");
await t("push failure message, no decision/continue", async () => { fs.unlinkSync(stt + "/notify.json"); const r = run("push", dead); assert.equal(r.status, 0); const j = JSON.parse(r.stdout); assert(/^Memory sync: push failed \(.+\), 2 file\(s\) not synced, will retry after the next reply\.$/.test(j.systemMessage), j.systemMessage); assert(!("decision" in j) && !("continue" in j) && !j.hookSpecificOutput); console.log("   ", j.systemMessage); });
await t("throttle: second failure silent", async () => { const r = run("push", dead); assert.equal(r.status, 0); assert.equal(r.stdout, ""); });
await t("throttle: after 10min shown again", async () => { const n = tm(); n.last_shown -= 700; fs.writeFileSync(stt + "/notify.json", JSON.stringify(n)); const r = run("push", dead); assert(JSON.parse(r.stdout).systemMessage.includes("push failed")); });
await t("HTTP error message shows status", async () => { const st2 = fs.mkdtempSync(os.tmpdir() + "/s-"); fs.writeFileSync(mem + "/c.md", "c\n"); const r = run("push", { MEMSYNC_TOKEN: "wrong" }, st2); const j = JSON.parse(r.stdout); assert(j.systemMessage.includes("HTTP 401"), j.systemMessage); console.log("   ", j.systemMessage); fs.unlinkSync(mem + "/c.md"); });
await t("recovery message once, then silent; queue flushed", async () => { const r = run("push"); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).systemMessage, "Memory sync recovered, 2 file(s) pushed."); const r2 = run("push"); assert.equal(r2.stdout, ""); const rows = sql("SELECT ok,event,error,files,cli_version,auto_memory,cwd_name,session FROM sync_events ORDER BY id"); console.log("   rows:", JSON.stringify(rows)); assert(rows.length >= 4); assert.equal(rows.filter((x) => x.ok === 0).length, 4); assert.equal(rows.at(-1).ok, 1); assert.equal(rows.at(-1).session, "tsess"); assert(["true","false","unknown"].includes(rows.at(-1).auto_memory)); assert(!fs.existsSync(stt + "/status_queue.json") || JSON.parse(fs.readFileSync(stt + "/status_queue.json")).length === 0); });
await t("success pull prints nothing", async () => { const r = run("pull"); assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert(fs.existsSync(mem + "/a.md")); });
await t("rejected_path / rejected_size surfaced", async () => { fs.writeFileSync(mem + "/bad name!.md", "x\n"); fs.writeFileSync(mem + "/big.md", "y".repeat(150000) + "\n"); const r = run("push"); assert.equal(r.status, 0); const j = JSON.parse(r.stdout); assert(j.systemMessage.includes("bad name!.md (invalid path)"), j.systemMessage); console.log("   ", j.systemMessage); const row = sql("SELECT ok,error FROM sync_events ORDER BY id DESC LIMIT 1")[0]; assert.equal(row.ok, 0); assert(row.error.includes("rejected_path")); const r2 = run("push"); assert.equal(r2.stdout, ""); });
await t("queue capped at 50", async () => { const st3 = fs.mkdtempSync(os.tmpdir() + "/s-"); for (let i = 0; i < 55; i++) run("pull", dead, st3); assert.equal(JSON.parse(fs.readFileSync(st3 + "/status_queue.json")).length, 50); });
await t("garbage stdin + no tty ok", async () => { const r = run("push", {}, stt, "not json"); assert.equal(r.status, 0); });
await t("MEMSYNC_LANG=zh gives Chinese messages", async () => { const r = run("pull", { ...dead, MEMSYNC_LANG: "zh" }, fs.mkdtempSync(os.tmpdir() + "/s-")); const j = JSON.parse(r.stdout); assert(j.systemMessage.startsWith("记忆同步：拉取失败（")); assert(j.systemMessage.includes("没有加载持久记忆")); const st4 = fs.mkdtempSync(os.tmpdir() + "/s-"); fs.writeFileSync(mem + "/bad name!.md", "x\n"); const r2 = run("push", { MEMSYNC_LANG: "zh" }, st4); assert(JSON.parse(r2.stdout).systemMessage.includes("（路径不合法）"), r2.stdout); });
await t("missing MEMSYNC_URL -> clear systemMessage, exit 0, throttled", async () => { const st5 = fs.mkdtempSync(os.tmpdir() + "/s-"); const r = run("pull", { MEMSYNC_URL: "" }, st5); assert.equal(r.status, 0); const j = JSON.parse(r.stdout); assert(j.systemMessage.includes("MEMSYNC_URL is not set")); assert.equal(j.hookSpecificOutput.additionalContext, j.systemMessage); const r2 = run("push", { MEMSYNC_URL: "" }, st5); assert.equal(r2.stdout, ""); const r3 = run("pull", { MEMSYNC_URL: "", MEMSYNC_LANG: "zh" }, fs.mkdtempSync(os.tmpdir() + "/s-")); assert(JSON.parse(r3.stdout).systemMessage.includes("没有设置 MEMSYNC_URL")); });
w.stop();
console.log(`pass ${pass} fail ${fail}`); process.exit(fail ? 1 : 0);
