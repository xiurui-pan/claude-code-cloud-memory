import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync as spawnSync0 } from "node:child_process";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Optional visual check. Needs Playwright: `npm install --no-save playwright && npx playwright install chromium`.
// Usage: node tests/ui2.mjs [outDir]   (UI_LANG=zh for the Chinese UI; default English)
const ZH = process.env.UI_LANG === "zh";
const L = ZH ? { type: "类型", saved: "已保存", restored: "已恢复", deleted: "已删除", locale: "zh-CN" } : { type: "Type", saved: "Saved", restored: "Restored", deleted: "Deleted", locale: "en-US" };
const OUT = process.argv[2] || path.join(os.tmpdir(), "memsync-shots"); fs.mkdirSync(OUT, { recursive: true });
import http from "node:http"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
import { createRequire } from "node:module"; const { chromium } = createRequire(import.meta.url)("playwright");
const b64u = (b) => Buffer.from(b).toString("base64url");
fs.rmSync(path.join(HERE, ".state-ui2"), { recursive: true, force: true });
const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...kp.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
http.createServer((q, r) => { r.setHeader("content-type","application/json"); r.end(JSON.stringify({ keys: [jwk] })); }).listen(8897);
const TEAM = "http://127.0.0.1:8897", AUD = "aud-ui";
const now = Math.floor(Date.now()/1000);
const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), p = b64u(JSON.stringify({ aud: [AUD], iss: TEAM, exp: now+3600, nbf: now-10 }));
const jwt = h+"."+p+"."+b64u(crypto.sign("sha256", Buffer.from(h+"."+p), kp.privateKey));
spawnSync0("npx", ["wrangler", "d1", "execute", "memsync-test", "--local", "--persist-to", path.join(HERE, ".state-ui2"), "--file", path.join(HERE, "..", "worker", "schema.sql")], { cwd: HERE, stdio: "ignore" });
const w = spawn("npx", ["wrangler","dev","--local","--port","8911","--inspector-port","9021","--persist-to",path.join(HERE, ".state-ui2"),"--var",`ACCESS_TEAM_DOMAIN:${TEAM}`,"--var",`ACCESS_AUD:${AUD}`,"--var","TOKEN_SHA256:"+crypto.createHash("sha256").update("x").digest("hex")], { cwd: HERE, detached: true, stdio: "ignore" });
const B = "http://127.0.0.1:8911";
for (let i=0;i<120;i++){ try{ await fetch(B+"/health"); break; }catch{ await new Promise(r=>setTimeout(r,500)); } }
// seed via sync API so the list isn't empty
await fetch(B+"/v1/push",{method:"POST",headers:{authorization:"Bearer x"},body:JSON.stringify({session:"seed",files:[
 {path:"MEMORY.md",content:"- [Reply style](reply-style.md) — Concise replies\n",base_sha:null},
 {path:"reply-style.md",content:"---\nname: reply-style\ndescription: Concise and direct\nmetadata:\n  type: feedback\n---\n\nReply concisely.\n",base_sha:null},
 {path:"repo-map.md",content:"---\nname: repo-map\ndescription: Repository map\nmetadata:\n  type: project\n---\n\n- app/\n",base_sha:null}]})});
const bear = { authorization: "Bearer x", "content-type": "application/json" };
const ev = (o) => fetch(B + "/v1/status", { method: "POST", headers: bear, body: JSON.stringify({ session: "sess-1", event: "push", ok: true, files: 2, cli_version: "2.1.2", auto_memory: "unknown;flag=0", cwd_name: "example-project", ...o }) });
await ev({ cli_version: "2.1.1", at: Date.now() - 5 * 864e5 }); await ev({ event: "pull", ok: false, error: "HTTP 401", files: 0, at: Date.now() - 60000 }); await ev({ ok: false, error: "URLError:ConnectionRefusedError" });
const errors = []; const browser = (await import("node:module")).createRequire(import.meta.url)("playwright").chromium; const br = await browser.launch(); const out = OUT; const results = [];
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
  const ctx = await br.newContext({ ...opts, locale: L.locale }); await ctx.addCookies([{ name: "CF_Authorization", value: jwt, url: B }]); const pg = await ctx.newPage();
  pg.on("console", (m) => { if (m.type() === "error") errors.push(label + ": " + m.text()); }); pg.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
  try {
    await pg.goto(B + "/admin"); await pg.click("#bStatus"); await pg.locator(".badge.red").first().waitFor({ timeout: 8000 });
    const badges = await pg.locator(".badge").allTextContents(); const rows = await pg.locator("#status tr").count();
    const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await pg.screenshot({ path: `${out}/status-${label}.png`, fullPage: true });
    results.push(`${label}: badges=${JSON.stringify(badges)} tableRows=${rows} overflow=${o}px`); if (o > 1) results.push("FAIL overflow");
    await pg.click("#bStatus"); await pg.getByText("reply-style", { exact: false }).first().waitFor({ timeout: 5000 }); results.push(label + ": toggle back ok");
  } catch (e) { results.push(label + " FAIL " + e.message.split("\n")[0]); }
  await ctx.close();
}
await br.close(); try { process.kill(-w.pid, "SIGKILL"); } catch {}
console.log(results.join("\n")); console.log("console errors:", errors.length ? errors.join("\n") : "none"); process.exit(0);
