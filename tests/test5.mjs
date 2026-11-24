// Client v3 end to end: real git checkouts (origin URLs only, no network), real hooks (memsync.py pull/push)
// against the server under test. Covers single repo, superrepo + submodule subsets, no repo, several
// unrelated repos, the CLAUDE.md header, concurrent CLAUDE.md edits, late submodule membership,
// a legacy server and an old (v1) client against the new server.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start, up, BACKEND } from "./backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "worker", "memsync.py");
const CLIENT_V1 = path.join(HERE, "fixtures", "memsync-v1.py");
const PORT = 8841, LEGACY_PORT = 8842, B = `http://127.0.0.1:${PORT}`;
const w = start({ port: PORT, state: path.join(HERE, ".state5"), vars: { TOKEN_SHA256: crypto.createHash("sha256").update("sekret").digest("hex") } });
console.log("backend:", BACKEND);
await up(PORT);
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.stack.split("\n").slice(0, 3).join(" | ")); } };

// The tested header, verbatim.
const HEADER = `# Global memory (shared by every project and session)
This file is the user's global memory and is loaded in every project. Edit it directly (/root/.claude/CLAUDE.md) to save:
- anything the user asks you to remember for all projects or globally;
- the user's preferences about how you should work (communication, writing style, workflow, review habits)
  that do not depend on a specific repository, service or system.
Keep each entry to one short line. Facts, procedures and rules about a specific project, repo, service
or deployment belong in auto-memory instead.
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t5-"));
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
function mkrepo(dir, origin, modules) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
  if (modules) fs.writeFileSync(path.join(dir, ".gitmodules"), modules.map(([n, u]) => `[submodule "${n}"]\n\tpath = ${n}\n\turl = ${u}\n`).join(""));
  return dir;
}
const PLATFORM_MODULES = [["api", "../api.git"], ["chat", "https://github.com/acme/chat.git"]];
const P = "github.com/acme/platform", pd = (pid) => `projects/${pid}/`;
const srv = () => Object.fromEntries(w.sql("SELECT path, content, session FROM files WHERE deleted = 0 ORDER BY path").map((r) => [r.path, r]));
const lastEvent = () => w.sql("SELECT event, ok, projects, files FROM sync_events ORDER BY id DESC LIMIT 1")[0];

let sn = 0;
function session(root, { cwd } = {}) {
  const id = `s${++sn}`, d = fs.mkdtempSync(path.join(TMP, id + "-"));
  const s = { id, mem: path.join(d, "memory"), st: path.join(d, "state"), g: path.join(d, "CLAUDE.md"), root, cwd0: cwd || root };
  s.run = (cmd, { cwd, env = {}, client = CLIENT, url = B } = {}) => spawnSync("python3", [client, cmd], {
    cwd: TMP, encoding: "utf8", input: JSON.stringify({ cwd: cwd || s.cwd0, session_id: id }),
    env: { ...process.env, MEMSYNC_URL: url, MEMSYNC_DIR: s.mem, MEMSYNC_STATE: s.st, MEMSYNC_GLOBAL_FILE: s.g, MEMSYNC_TOKEN: "sekret",
      CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_REMOTE_SESSION_ID: id, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*", ...env },
  });
  // For tests whose server lives in this process (spawnSync would block its event loop).
  s.runAsync = (cmd, { cwd, env = {}, url = B } = {}) => new Promise((resolve) => {
    const p = spawn("python3", [CLIENT, cmd], { cwd: TMP, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MEMSYNC_URL: url, MEMSYNC_DIR: s.mem, MEMSYNC_STATE: s.st, MEMSYNC_GLOBAL_FILE: s.g, MEMSYNC_TOKEN: "sekret",
        CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_REMOTE_SESSION_ID: id, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*", ...env } });
    let out = ""; p.stdout.on("data", (c) => (out += c)); p.on("close", (status) => resolve({ status, stdout: out }));
    p.stdin.end(JSON.stringify({ cwd: cwd || s.cwd0, session_id: id }));
  });
  s.pull = (o) => { const r = s.run("pull", o); assert.equal(r.status, 0, r.stderr); return r; };
  s.push = (o) => { const r = s.run("push", o); assert.equal(r.status, 0, r.stderr); return r; };
  s.read = (rel) => fs.readFileSync(path.join(s.mem, rel), "utf8");
  s.write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(s.mem, rel)), { recursive: true }); fs.writeFileSync(path.join(s.mem, rel), text); };
  s.has = (rel) => fs.existsSync(path.join(s.mem, rel));
  s.claude = () => fs.readFileSync(s.g, "utf8");
  s.files = () => fs.existsSync(s.mem) ? fs.readdirSync(s.mem, { recursive: true }).filter((f) => f.endsWith(".md")).sort() : [];
  return s;
}

// ---- workspaces ----
const wsS = path.join(TMP, "wsS"), wsA = path.join(TMP, "wsA"), wsB = path.join(TMP, "wsB"), wsU = path.join(TMP, "wsU"), wsN = path.join(TMP, "wsN");
mkrepo(path.join(wsS, "platform"), "https://github.com/acme/platform.git", PLATFORM_MODULES); // single-repo session: submodule dirs not checked out
mkrepo(path.join(wsA, "platform"), "https://x-access-token:tok3n@github.com/Acme/Platform.git", PLATFORM_MODULES); mkrepo(path.join(wsA, "api"), "git@github.com:acme/api.git"); // superrepo + one submodule
mkrepo(path.join(wsB, "api"), "git@github.com:acme/api.git"); mkrepo(path.join(wsB, "chat"), "https://github.com/Acme/chat.git"); // only submodules
mkrepo(path.join(wsU, "tools"), "https://github.com/acme/tools.git"); mkrepo(path.join(wsU, "docs"), "https://github.com/acme/docs"); fs.mkdirSync(path.join(wsU, "tools", "src"));
fs.mkdirSync(wsN, { recursive: true }); mkrepo(path.join(wsN, "scratch"), null); // a repo without origin does not count

await t("single-repo session: header-only CLAUDE.md, new memory pushed under the project, global body without header", async () => {
  const s = session(path.join(wsS, "platform"));
  s.pull();
  assert.equal(s.claude(), HEADER); assert.deepEqual(s.files(), []);
  assert.equal(lastEvent().projects, P);
  s.write("MEMORY.md", "- [Deploy](deploy.md) — order of nodes\n"); s.write("deploy.md", "---\nname: Deploy\n---\nB then A\n");
  fs.writeFileSync(s.g, s.claude() + "\n- Reply in Chinese\n");
  assert.equal(s.push().stdout, "");
  const f = srv();
  assert.deepEqual(Object.keys(f), [pd(P) + "MEMORY.md", pd(P) + "deploy.md", "global/CLAUDE.md"].sort());
  assert.equal(f["global/CLAUDE.md"].content, "- Reply in Chinese\n");
  assert.equal(f[pd(P) + "deploy.md"].content, "---\nname: Deploy\n---\nB then A\n");
  const m = Object.fromEntries(w.sql("SELECT repo, pid, source FROM repo_membership").map((r) => [r.repo, r.pid + ":" + r.source]));
  assert.equal(m["github.com/acme/api"], P + ":gitmodules"); assert.equal(m["github.com/acme/chat"], P + ":gitmodules"); assert.equal(m[P], P + ":self");
  assert(s.claude().startsWith(HEADER)); // header untouched by push
});

await t("session with only submodules (no superrepo) lands in the parent project and sees global memory", async () => {
  const s = session(wsB);
  s.pull();
  assert.deepEqual(s.files(), ["MEMORY.md", "deploy.md"]);
  assert.equal(s.read("deploy.md"), "---\nname: Deploy\n---\nB then A\n");
  assert.equal(s.claude(), HEADER + "\n- Reply in Chinese\n");
  assert.equal(lastEvent().projects, P);
});

await t("superrepo + one submodule = one project, no duplicate files", async () => {
  const s = session(wsA);
  s.pull();
  assert.deepEqual(s.files(), ["MEMORY.md", "deploy.md"]);
  assert.equal(lastEvent().projects, P);
  s.write("MEMORY.md", s.read("MEMORY.md") + "- [Rel](release.md) — changelog first\n"); s.write("release.md", "update CHANGELOG\n");
  s.push();
  assert.equal(srv()[pd(P) + "release.md"].content, "update CHANGELOG\n");
  assert(srv()[pd(P) + "MEMORY.md"].content.includes("[Rel](release.md)"));
  assert.equal(srv()[pd(P) + "release.md"].session.includes("routed"), false); // single project: nothing to flag
});

await t("MEMSYNC_WORKSPACE overrides the scan root", async () => {
  const s = session(wsU);
  s.pull({ env: { MEMSYNC_WORKSPACE: path.join(wsS, "platform") } });
  assert.equal(lastEvent().projects, P);
});

await t("no repo: own project _norepo, still sees global memory, not the other project", async () => {
  const s = session(TMP); // not a repo, no repos below it
  s.pull();
  assert.deepEqual(s.files(), []);
  assert.equal(s.claude(), HEADER + "\n- Reply in Chinese\n"); assert.equal(lastEvent().projects, "_norepo");
  s.write("n.md", "scratch note\n"); s.write("MEMORY.md", "- [n](n.md)\n"); s.push();
  assert.equal(srv()[pd("_norepo") + "n.md"].content, "scratch note\n");
  const s2 = session(path.join(wsN, "scratch")); s2.pull(); // repo without origin
  assert.equal(lastEvent().projects, "_norepo"); assert.deepEqual(s2.files(), ["MEMORY.md", "n.md"]);
});

await t("two unrelated repos: files materialized together, collisions renamed, new files routed by Stop cwd", async () => {
  const D = "github.com/acme/docs", T = "github.com/acme/tools";
  const seed = (pid, name, body, idx) => w.sql(`INSERT INTO files (path, content, sha, deleted, modified, session) VALUES ('${pd(pid)}${name}', '${body}', 'x${pid}${name}', 0, 1, 'seed')`) && null;
  seed(D, "notes.md", "docs notes\n"); seed(T, "notes.md", "tools notes\n"); seed(D, "MEMORY.md", "- [Notes](notes.md) — docs\n"); seed(T, "MEMORY.md", "- [Notes](notes.md) — tools\n"); seed(T, "only_tools.md", "t\n");
  const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
  for (const r of w.sql("SELECT path, content FROM files WHERE session = 'seed'")) w.sql(`UPDATE files SET sha = '${sha(r.content)}' WHERE path = '${r.path}'`);
  const s = session(wsU);
  s.pull();
  assert.equal(lastEvent().projects, `${D},${T}`);
  assert.deepEqual(s.files(), ["MEMORY.md", "notes.2.md", "notes.md", "only_tools.md"]);
  assert.equal(s.read("notes.md"), "docs notes\n"); assert.equal(s.read("notes.2.md"), "tools notes\n");
  assert.equal(s.read("MEMORY.md"), "- [Notes](notes.md) — docs\n- [Notes](notes.2.md) — tools\n");
  // edit a renamed file: goes back to its own project under the original name
  s.write("notes.2.md", "tools notes v2\n");
  // new file + index line, Stop cwd inside the tools repo
  s.write("fresh.md", "fresh\n"); s.write("MEMORY.md", s.read("MEMORY.md") + "- [Fresh](fresh.md) — new\n");
  s.push({ cwd: path.join(wsU, "tools", "src") });
  let f = srv();
  assert.equal(f[pd(T) + "notes.md"].content, "tools notes v2\n"); assert.equal(f[pd(D) + "notes.md"].content, "docs notes\n");
  assert.equal(f[pd(T) + "fresh.md"].content, "fresh\n"); assert(!f[pd(D) + "fresh.md"]);
  assert.equal(f[pd(T) + "fresh.md"].session, `${s.id}|routed:cwd`);
  assert.equal(f[pd(T) + "MEMORY.md"].content, "- [Notes](notes.md) — tools\n- [Fresh](fresh.md) — new\n");
  assert.equal(f[pd(D) + "MEMORY.md"].content, "- [Notes](notes.md) — docs\n");
  // new file with Stop cwd outside any repo: first project (sorted), flagged
  s.write("loose.md", "loose\n"); s.write("MEMORY.md", s.read("MEMORY.md") + "- [Loose](loose.md)\n");
  s.push({ cwd: wsU });
  f = srv();
  assert.equal(f[pd(D) + "loose.md"].session, `${s.id}|routed:first`);
  assert(f[pd(D) + "MEMORY.md"].content.includes("[Loose](loose.md)")); // the index line follows its file
  assert(!f[pd(T) + "MEMORY.md"].content.includes("Loose"));
  // removing a line removes it from its own project only
  s.write("MEMORY.md", s.read("MEMORY.md").replace("- [Notes](notes.md) — docs\n", ""));
  s.push();
  f = srv();
  assert(!f[pd(D) + "MEMORY.md"].content.includes("docs")); assert(f[pd(T) + "MEMORY.md"].content.includes("tools"));
  // delete a topic file
  fs.unlinkSync(path.join(s.mem, "only_tools.md")); s.push();
  assert(!srv()[pd(T) + "only_tools.md"]);
});

await t("proposals/ in the memory dir is never synced", async () => {
  const s = session(path.join(wsS, "platform")); s.pull();
  s.write("proposals/p1.md", "skill proposal\n"); s.write("keep.md", "k\n"); s.push();
  assert(srv()[pd(P) + "keep.md"]); assert(!Object.keys(srv()).some((p) => p.includes("proposals")));
  assert(s.has("proposals/p1.md")); s.pull(); assert(s.has("proposals/p1.md"));
});

await t("CLAUDE.md header: added on pull, tolerant strip on push (trailing whitespace), removed header = whole text is body", async () => {
  const s = session(TMP); s.pull();
  assert(s.claude().startsWith(HEADER));
  const lines = s.claude().split("\n"); lines[0] += "  "; lines[3] += "\t";
  fs.writeFileSync(s.g, lines.join("\n") + "\n- tolerant line\n"); s.push();
  assert(srv()["global/CLAUDE.md"].content.endsWith("- tolerant line\n")); assert(!srv()["global/CLAUDE.md"].content.includes("Global memory (shared"));
  fs.writeFileSync(s.g, "- only entry, header removed\n"); s.push();
  assert(srv()["global/CLAUDE.md"].content.includes("- only entry, header removed"));
});

await t("concurrent CLAUDE.md edits from two sessions merge (3-way line merge)", async () => {
  const X = session(TMP), Y = session(TMP);
  X.pull(); Y.pull();
  fs.writeFileSync(X.g, X.claude() + "- X line\n"); fs.writeFileSync(Y.g, Y.claude() + "- Y line\n");
  X.push(); Y.push();
  const body = srv()["global/CLAUDE.md"].content;
  assert(body.includes("- X line") && body.includes("- Y line"), body);
  assert(Y.claude().startsWith(HEADER) && Y.claude().includes("- X line") && Y.claude().includes("- Y line")); // merged text written back, header kept
  X.push(); assert.equal(srv()["global/CLAUDE.md"].content, body); // idle push changes nothing
  X.pull(); assert(X.claude().includes("- Y line"));
});

await t("same container: pull pushes pending edits first, then mirrors the server (deletions applied)", async () => {
  const s = session(path.join(wsS, "platform")); s.pull();
  s.write("pending.md", "unsent\n");
  s.pull();
  assert(srv()[pd(P) + "pending.md"]);
  w.sql(`UPDATE files SET deleted = 1 WHERE path = '${pd(P)}pending.md'`);
  s.pull();
  assert(!s.has("pending.md"));
});

await t("late membership: files of a submodule's own project follow it into the parent project", async () => {
  const wsC = path.join(TMP, "wsC"), wsD = path.join(TMP, "wsD");
  mkrepo(path.join(wsC, "web"), "https://github.com/acme2/web.git");
  mkrepo(path.join(wsD, "suite"), "https://github.com/acme2/suite.git", [["web", "../web.git"]]);
  const a = session(path.join(wsC, "web")); a.pull(); a.write("w.md", "web fact\n"); a.write("MEMORY.md", "- [w](w.md)\n"); a.push();
  assert(srv()[pd("github.com/acme2/web") + "w.md"]);
  const b = session(path.join(wsD, "suite")); b.pull(); // learns the submodule
  assert.deepEqual(b.files(), ["MEMORY.md", "w.md"]); assert.equal(lastEvent().projects, "github.com/acme2/suite");
  assert(!srv()[pd("github.com/acme2/web") + "w.md"]); assert(srv()[pd("github.com/acme2/suite") + "w.md"]);
  const c = session(path.join(wsC, "web")); c.pull(); // web alone now maps to the parent
  assert.deepEqual(c.files(), ["MEMORY.md", "w.md"]); assert.equal(lastEvent().projects, "github.com/acme2/suite");
});

await t("server error: pull failure keeps a clear message and exit 0", async () => {
  const s = session(TMP);
  const r = s.run("pull", { url: "http://127.0.0.1:1" });
  assert.equal(r.status, 0); assert(JSON.parse(r.stdout).systemMessage.includes("pull failed"));
});

await t("old client (v1) against the new server: legacy root files only, layers untouched", async () => {
  w.sql(`INSERT OR IGNORE INTO files (path, content, sha, deleted, modified) VALUES ('legacy_x.md', 'old note', 'h1', 0, 1)`);
  const s = session(TMP);
  const r = s.run("pull", { client: CLIENT_V1 }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.files(), ["legacy_x.md"]);
  s.write("v1_new.md", "from v1\n"); const r2 = s.run("push", { client: CLIENT_V1 }); assert.equal(r2.status, 0, r2.stderr);
  const f = srv(); assert.equal(f["v1_new.md"].content, "from v1\n");
  assert(f[pd(P) + "deploy.md"]); assert(f["global/CLAUDE.md"]);
  const r3 = s.run("pull", { client: CLIENT_V1 }); assert.equal(r3.status, 0); assert.deepEqual(s.files(), ["legacy_x.md", "v1_new.md"]); // v1 base survives, nothing layered leaks in
});

await t("legacy server (no /v1/resolve): v3 client falls back to the flat store and leaves CLAUDE.md alone", async () => {
  const store = { "MEMORY.md": "- [old](old.md)\n", "old.md": "legacy body\n" };
  const pushed = [];
  const legacy = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const ok = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
      if (req.url === "/v1/pull") return ok({ files: Object.entries(store).map(([path, content]) => ({ path, content, sha: sha(content) })), now: 1 });
      if (req.url === "/v1/push") { const b = JSON.parse(Buffer.concat(chunks)); return ok({ results: b.files.map((f) => { pushed.push(f.path); store[f.path] = f.content; return { path: f.path, status: "written" }; }) }); }
      if (req.url === "/v1/status") return ok({ ok: true });
      res.statusCode = 404; ok({ error: "not found" });
    });
  }).listen(LEGACY_PORT);
  try {
    const s = session(path.join(wsS, "platform"));
    const url = `http://127.0.0.1:${LEGACY_PORT}`;
    assert.equal((await s.runAsync("pull", { url })).status, 0);
    assert.deepEqual(s.files(), ["MEMORY.md", "old.md"]); assert(!fs.existsSync(s.g));
    s.write("old.md", "legacy body v2\n"); s.write("extra.md", "e\n"); assert.equal((await s.runAsync("push", { url })).status, 0);
    assert.deepEqual(pushed.sort(), ["extra.md", "old.md"]); assert.equal(store["old.md"], "legacy body v2\n");
  } finally { legacy.close(); }
});

w.stop();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
