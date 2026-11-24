import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync as spawnSync0 } from "node:child_process";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Optional visual check. Needs Playwright: `npm install --no-save playwright && npx playwright install chromium`.
// Usage: node tests/ui.mjs [outDir]   (UI_LANG=zh for the Chinese UI; default English)
const ZH = process.env.UI_LANG === "zh";
const L = ZH ? { type: "类型", saved: "已保存", restored: "已恢复", deleted: "已删除", locale: "zh-CN" } : { type: "Type", saved: "Saved", restored: "Restored", deleted: "Deleted", locale: "en-US" };
const OUT = process.argv[2] || path.join(os.tmpdir(), "memsync-shots"); fs.mkdirSync(OUT, { recursive: true });
import http from "node:http"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
import { createRequire } from "node:module"; const { chromium } = createRequire(import.meta.url)("playwright");
const b64u = (b) => Buffer.from(b).toString("base64url");
fs.rmSync(path.join(HERE, ".state-ui"), { recursive: true, force: true });
const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...kp.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
http.createServer((q, r) => { r.setHeader("content-type","application/json"); r.end(JSON.stringify({ keys: [jwk] })); }).listen(8899);
const TEAM = "http://127.0.0.1:8899", AUD = "aud-ui";
const now = Math.floor(Date.now()/1000);
const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), p = b64u(JSON.stringify({ aud: [AUD], iss: TEAM, exp: now+3600, nbf: now-10 }));
const jwt = h+"."+p+"."+b64u(crypto.sign("sha256", Buffer.from(h+"."+p), kp.privateKey));
spawnSync0("npx", ["wrangler", "d1", "execute", "memsync-test", "--local", "--persist-to", path.join(HERE, ".state-ui"), "--file", path.join(HERE, "..", "worker", "schema.sql")], { cwd: HERE, stdio: "ignore" });
const w = spawn("npx", ["wrangler","dev","--local","--port","8901","--inspector-port","9001","--persist-to",path.join(HERE, ".state-ui"),"--var",`ACCESS_TEAM_DOMAIN:${TEAM}`,"--var",`ACCESS_AUD:${AUD}`,"--var","TOKEN_SHA256:"+crypto.createHash("sha256").update("x").digest("hex")], { cwd: HERE, detached: true, stdio: "ignore" });
const B = "http://127.0.0.1:8901";
for (let i=0;i<120;i++){ try{ await fetch(B+"/health"); break; }catch{ await new Promise(r=>setTimeout(r,500)); } }
// seed via sync API so the list isn't empty
await fetch(B+"/v1/push",{method:"POST",headers:{authorization:"Bearer x"},body:JSON.stringify({session:"seed",files:[
 {path:"MEMORY.md",content:"- [Reply style](reply-style.md) — Concise replies\n",base_sha:null},
 {path:"reply-style.md",content:"---\nname: reply-style\ndescription: Concise and direct\nmetadata:\n  type: feedback\n---\n\nReply concisely.\n",base_sha:null},
 {path:"repo-map.md",content:"---\nname: repo-map\ndescription: Repository map\nmetadata:\n  type: project\n---\n\n- app/\n",base_sha:null}]})});
const errors = []; const out = OUT;
const browser = await chromium.launch();
const results = [];
const step = async (n, f) => { try { await f(); results.push("PASS "+n); } catch (e) { results.push("FAIL "+n+": "+e.message.split("\n")[0]); } };
for (const [label, opts] of [["desktop",{viewport:{width:1280,height:800}}],["phone",{viewport:{width:390,height:844},isMobile:true,hasTouch:true}]]) {
  const ctx = await browser.newContext({ ...opts, locale: L.locale, deviceScaleFactor: label==="phone"?2:1 });
  await ctx.addCookies([{ name:"CF_Authorization", value: jwt, url: B }]);
  const pg = await ctx.newPage();
  pg.on("console", m => { if (m.type()==="error") errors.push(label+": "+m.text()); });
  pg.on("pageerror", e => errors.push(label+" pageerror: "+e.message));
  pg.on("dialog", async d => { const m=d.message(); if (d.type()==="prompt") await d.accept(m.includes(L.type)?"user":""); else await d.accept(); });
  await step(label+" list renders", async () => { await pg.goto(B+"/admin"); await pg.getByText("reply-style", {exact:false}).first().waitFor({timeout:8000}); });
  await pg.screenshot({ path: `${out}/admin-${label}-list.png`, fullPage: true });
  if (label === "desktop") {
    await step("search filter", async () => { await pg.fill("#q","repo"); await pg.waitForTimeout(300); const t = await pg.locator("#list").innerText(); if (t.includes("reply-style")) throw new Error("filter not applied"); await pg.fill("#q",""); });
    await step("open + edit + save", async () => { await pg.getByText("reply-style").first().click(); await pg.locator("#ed").waitFor(); await pg.locator("#ed").fill((await pg.locator("#ed").inputValue())+"One more line.\n"); await pg.click("#bSave"); await pg.getByText(L.saved).first().waitFor({timeout:5000}); });
    await pg.screenshot({ path: `${out}/admin-desktop-detail.png`, fullPage: true });
    await step("history + view + restore", async () => { await pg.click("#bHist"); await pg.locator("button[data-v]").first().waitFor(); const n = await pg.locator("button[data-v]").count(); if (n < 2) throw new Error("expected >=2 versions, got "+n); await pg.locator("button[data-v]").last().click(); await pg.locator("#bRes").click(); await pg.getByText(L.restored).first().waitFor({timeout:5000}); });
    await step("new file + index line", async () => { await pg.click("#bNew"); await pg.locator("#dPath").fill("ui-test"); const ed = pg.locator("#ed"); await ed.fill((await ed.inputValue()).replace("name: ","name: ui-test").replace("description: ","description: browser test")+"\nbody\n"); await pg.click("#bSave"); await pg.getByText(L.saved).first().waitFor({timeout:5000});
      const m = await (await fetch(B+"/v1/pull",{headers:{authorization:"Bearer x"}})).json(); const idx = m.files.find(f=>f.path==="MEMORY.md").content; if (!idx.includes("ui-test.md")) throw new Error("index not appended: "+idx); });
    await step("delete", async () => { await pg.click("#bDel"); await pg.getByText(L.deleted).first().waitFor({timeout:5000}); const m = await (await fetch(B+"/v1/pull",{headers:{authorization:"Bearer x"}})).json(); if (m.files.some(f=>f.path==="ui-test.md")) throw new Error("still present"); });
  } else {
    await step("phone open detail + back", async () => { await pg.getByText("repo-map").first().click(); await pg.locator("#ed").waitFor(); await pg.screenshot({ path: `${out}/admin-phone-detail.png`, fullPage: true }); await pg.click("#bBack"); });
    await step("phone no horizontal scroll", async () => { const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (o > 1) throw new Error("overflow "+o+"px"); });
  }
  await ctx.close();
}
await browser.close(); try { process.kill(-w.pid, "SIGKILL"); } catch {} 
console.log(results.join("\n")); console.log("console errors:", errors.length ? errors.join("\n") : "none"); process.exit(0);
