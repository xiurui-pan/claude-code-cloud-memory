// tools/migrate-layers.mjs against a live server: dry run changes nothing, --apply moves with history.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start, up, BACKEND } from "./backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "tools", "migrate-layers.mjs");
const PORT = 8851, B = `http://127.0.0.1:${PORT}`;
const w = start({ port: PORT, state: path.join(HERE, ".state6"), vars: { TOKEN_SHA256: crypto.createHash("sha256").update("sekret").digest("hex") } });
console.log("backend:", BACKEND);
await up(PORT);
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const bearer = { authorization: "Bearer sekret", "content-type": "application/json" };
const push = (files) => fetch(B + "/v1/push", { method: "POST", headers: bearer, body: JSON.stringify({ session: "seed", files }) }).then((r) => r.json());
const live = () => Object.fromEntries(w.sql("SELECT path, content FROM files WHERE deleted = 0").map((r) => [r.path, r.content]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t6-"));
const run = (plan, ...extra) => {
  const f = path.join(tmp, "plan.json"); fs.writeFileSync(f, JSON.stringify(plan));
  return spawnSync(process.execPath, [TOOL, f, ...extra], { encoding: "utf8", env: { ...process.env, MEMSYNC_URL: B, MEMSYNC_TOKEN: "sekret" } });
};
const P = "github.com/acme/platform";
const plan = {
  global_claude_md: "- Reply in Chinese\n- Prefer short answers\n",
  moves: [{ from: "deploy.md", to: `projects/${P}/deploy.md` }, { from: "MEMORY.md", to: `projects/${P}/MEMORY.md` }],
  drop: ["obsolete.md", "ghost.md"],
  project_indexes: { [P]: "- [Deploy](deploy.md) — order of nodes\n- [Extra](extra.md)\n" },
};

await push([{ path: "MEMORY.md", content: "- [Deploy](deploy.md) — order of nodes\n- [Stay](stay.md)\n", base_sha: null }, { path: "deploy.md", content: "B then A\n", base_sha: null },
  { path: "obsolete.md", content: "old\n", base_sha: null }, { path: "stay.md", content: "unmentioned\n", base_sha: null }]);

await t("dry run prints the plan and changes nothing", async () => {
  const before = live();
  const r = run(plan);
  assert(r.stdout.includes("DRY RUN") && r.stdout.includes(`move  deploy.md  ->  projects/${P}/deploy.md`) && r.stdout.includes("+ - Reply in Chinese") && r.stdout.includes("drop  obsolete.md"), r.stdout);
  assert(r.stdout.includes("1 legacy root file(s) stay") || r.stdout.includes("legacy root file(s) stay where they are"), r.stdout);
  assert.deepEqual(live(), before);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

await t("plan validation: bad paths exit 2 and print why", async () => {
  const r = run({ moves: [{ from: "x.md", to: "projects/bad/x.md" }], drop: ["global/CLAUDE.md"] });
  assert.equal(r.status, 2); assert(r.stderr.includes("projects/<host>") && r.stderr.includes("not a legacy root file"), r.stderr);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: "utf8" }).status, 2);
});

await t("--apply: moves keep history, indexes/global merged, drops deleted, unmentioned legacy files stay", async () => {
  const r = run(plan, "--apply");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const f = live();
  assert.equal(f[`projects/${P}/deploy.md`], "B then A\n");
  assert.equal(f[`projects/${P}/MEMORY.md`], "- [Deploy](deploy.md) — order of nodes\n- [Stay](stay.md)\n- [Extra](extra.md)\n");
  assert.equal(f["global/CLAUDE.md"], "- Reply in Chinese\n- Prefer short answers\n");
  assert(!f["deploy.md"] && !f["obsolete.md"] && !f["MEMORY.md"]); assert.equal(f["stay.md"], "unmentioned\n");
  const h = w.sql("SELECT deleted, session FROM history WHERE path = 'deploy.md' ORDER BY id").map((x) => [x.deleted, x.session]);
  assert.deepEqual(h, [[0, "seed"], [1, "move"]]);
  assert.equal(w.sql("SELECT COUNT(*) c FROM history WHERE path = 'obsolete.md'")[0].c, 2);
});

await t("re-running the plan is safe (skips missing sources, nothing new to merge)", async () => {
  const r = run(plan, "--apply");
  assert(r.stdout.includes("SKIP: source not found")); assert.equal(r.status, 1); // a missing source is reported as a problem
  assert.equal(live()["global/CLAUDE.md"], "- Reply in Chinese\n- Prefer short answers\n");
});

w.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
