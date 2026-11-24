// Local mode (Claude Code CLI / desktop on the user's machine): install/uninstall merging settings.json, native memory
// dir per project, first sync that only merges, shared global memory, concurrent sessions + lock, migration of existing
// per-project memory, Windows-style paths (simulated). Real hooks (memsync.py) against the server under test; every
// "machine" is its own HOME.
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
const PORT = 8861, B = `http://127.0.0.1:${PORT}`;
const w = start({ port: PORT, state: path.join(HERE, ".state7"), vars: { TOKEN_SHA256: crypto.createHash("sha256").update("sekret").digest("hex") } });
console.log("backend:", BACKEND);
await up(PORT);
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.stack.split("\n").slice(0, 4).join(" | ")); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t7-"));
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
function mkrepo(dir, origin) { fs.mkdirSync(dir, { recursive: true }); git(dir, "init", "-q"); if (origin) git(dir, "remote", "add", "origin", origin); return dir; }
const srv = () => Object.fromEntries(w.sql("SELECT path, content FROM files WHERE deleted = 0 ORDER BY path").map((r) => [r.path, r.content]));
const P = "github.com/acme/platform", pd = (pid) => `projects/${pid}/`;
const HEADER_LOCAL = "# Global memory (shared by every project and session)\nThis file is the user's global memory and is loaded in every project. Edit it directly (~/.claude/CLAUDE.md) to save:";

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MEMSYNC_|CLAUDE_)/.test(k)));
cleanEnv.HTTPS_PROXY = cleanEnv.HTTP_PROXY = cleanEnv.https_proxy = cleanEnv.http_proxy = ""; cleanEnv.NO_PROXY = "*";

let mn = 0;
function machine() {
  const home = fs.mkdtempSync(path.join(TMP, `m${++mn}-`));
  const m = { home, cfg: path.join(home, ".claude") };
  m.env = (extra = {}) => ({ ...cleanEnv, HOME: home, USERPROFILE: home, ...extra });
  m.py = (args, { input = "", env = {}, script = CLIENT } = {}) => spawnSync("python3", [script, ...args], { cwd: TMP, encoding: "utf8", input, env: m.env(env) });
  m.install = (extra = ["--token-stdin"]) => m.py(["install", "--url", B, ...extra], { input: "sekret\n" });
  m.script = path.join(m.cfg, "memsync", "memsync.py");
  m.settings = () => JSON.parse(fs.readFileSync(path.join(m.cfg, "settings.json"), "utf8"));
  // Run the hook exactly as Claude Code would: the command string from settings.json, through a shell, hook JSON on stdin.
  m.hook = (event, root, { cwd = root, session = "s" } = {}) => {
    const groups = m.settings().hooks[event];
    const cmd = groups.flatMap((g) => g.hooks).find((h) => h.command.includes("memsync.py")).command;
    return spawnSync("sh", ["-c", cmd], { cwd: TMP, encoding: "utf8", input: JSON.stringify({ cwd, session_id: session, hook_event_name: event }), env: m.env({ CLAUDE_PROJECT_DIR: root }) });
  };
  m.pull = (root, o) => { const r = m.hook("SessionStart", root, o); assert.equal(r.status, 0, r.stderr); return r; };
  m.push = (root, o) => { const r = m.hook("Stop", root, o); assert.equal(r.status, 0, r.stderr); return r; };
  m.where = (dir) => JSON.parse(m.py(["where", dir]).stdout);
  m.mem = (root) => m.where(root).memory_dir;
  m.read = (root, rel) => fs.readFileSync(path.join(m.mem(root), rel), "utf8");
  m.write = (root, rel, text) => { const f = path.join(m.mem(root), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  m.files = (root) => { const d = m.mem(root); return fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".md")).sort() : []; };
  m.claude = () => fs.readFileSync(path.join(m.cfg, "CLAUDE.md"), "utf8");
  return m;
}
const pyEval = (code, env = {}) => spawnSync("python3", ["-c", `import sys, json, importlib.util\nspec = importlib.util.spec_from_file_location("memsync", ${JSON.stringify(CLIENT)})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n${code}`], { encoding: "utf8", env: { ...cleanEnv, ...env } });

const repoA = mkrepo(path.join(TMP, "ws", "platform"), "https://github.com/acme/platform.git");
const repoB = mkrepo(path.join(TMP, "ws", "tools"), "git@github.com:acme/tools.git");
const plain = path.join(TMP, "ws", "scratch"); fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(path.join(repoA, "src", "deep"), { recursive: true });

// ---------------------------------------------------------------- install / uninstall
await t("install merges into an existing settings.json, keeps other hooks, is idempotent, writes backup + private token", async () => {
  const m = machine();
  fs.mkdirSync(m.cfg, { recursive: true });
  const mine = { theme: "dark", permissions: { allow: ["Bash(ls)"] }, env: { FOO: "1" }, autoMemoryDirectory: "/x/mem",
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }], PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] } };
  fs.writeFileSync(path.join(m.cfg, "settings.json"), JSON.stringify(mine));
  let r = m.install(); assert.equal(r.status, 0, r.stderr);
  const s = m.settings();
  assert.equal(s.theme, "dark"); assert.deepEqual(s.permissions, mine.permissions); assert.deepEqual(s.env, mine.env);
  assert.equal(s.autoMemoryDirectory, "/x/mem", "install must not touch autoMemoryDirectory");
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "lint");
  assert.equal(s.hooks.SessionStart.length, 2); assert.equal(s.hooks.SessionStart[0].hooks[0].command, "echo hi");
  for (const ev of ["SessionStart", "Stop", "SessionEnd"]) assert.equal(s.hooks[ev].filter((g) => g.hooks.some((h) => h.command.includes("memsync.py"))).length, 1);
  assert(s.hooks.Stop[0].hooks[0].command.endsWith(" push")); assert(s.hooks.SessionStart[1].hooks[0].command.endsWith(" pull"));
  assert(fs.readdirSync(m.cfg).some((f) => f.startsWith("settings.json.memsync-bak-")));
  assert(fs.existsSync(m.script));
  const tok = path.join(m.cfg, "memsync", "token");
  assert.equal(fs.readFileSync(tok, "utf8").trim(), "sekret");
  if (process.platform !== "win32") assert.equal(fs.statSync(tok).mode & 0o777, 0o600);
  assert(!fs.readFileSync(path.join(m.cfg, "settings.json"), "utf8").includes("sekret"));
  assert(!fs.readFileSync(path.join(m.cfg, "memsync", "config.json"), "utf8").includes("sekret"));
  assert(!r.stdout.includes("sekret") && !r.stderr.includes("sekret"));
  m.install(); // again: still exactly one of ours per event
  for (const ev of ["SessionStart", "Stop", "SessionEnd"]) assert.equal(m.settings().hooks[ev].filter((g) => g.hooks.some((h) => h.command.includes("memsync.py"))).length, 1);
});

await t("install refuses invalid settings.json without touching it; --token-file keeps the file where it is", async () => {
  const m = machine();
  fs.mkdirSync(m.cfg, { recursive: true });
  fs.writeFileSync(path.join(m.cfg, "settings.json"), "{ not json");
  const r = m.install(); assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(m.cfg, "settings.json"), "utf8"), "{ not json");
  fs.writeFileSync(path.join(m.cfg, "settings.json"), "{}");
  const tf = path.join(m.home, "mytoken"); fs.writeFileSync(tf, "sekret\n", { mode: 0o600 });
  assert.equal(m.py(["install", "--url", B, "--token-file", tf]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.cfg, "memsync", "config.json"), "utf8")).token_file, tf);
  assert(!fs.existsSync(path.join(m.cfg, "memsync", "token")));
  fs.mkdirSync(repoA, { recursive: true });
  assert.equal(m.pull(repoA).stdout, ""); // token read from the recorded file
  assert(m.claude().startsWith(HEADER_LOCAL));
});

await t("uninstall removes only our hooks and our header; user content and other hooks stay; --purge deletes state", async () => {
  const m = machine();
  fs.mkdirSync(m.cfg, { recursive: true });
  fs.writeFileSync(path.join(m.cfg, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
  fs.writeFileSync(path.join(m.cfg, "CLAUDE.md"), "My own rules\n- keep it short\n");
  m.install(); m.pull(repoA);
  assert(m.claude().startsWith(HEADER_LOCAL));
  let r = m.py(["uninstall"], { script: m.script }); assert.equal(r.status, 0, r.stderr);
  const s = m.settings();
  assert.deepEqual(s.hooks, { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] });
  assert(m.claude().includes("My own rules") && !m.claude().includes("Global memory (shared"));
  assert(fs.existsSync(path.join(m.cfg, "memsync", "config.json")));
  m.py(["uninstall", "--purge"], { script: m.script });
  assert(!fs.existsSync(path.join(m.cfg, "memsync")));
});

// ---------------------------------------------------------------- native dir
await t("native dir: <config>/projects/<slug of git root>/memory; subdir launch and linked worktree map to the main root; non-git is global only", async () => {
  const m = machine();
  const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
  const real = fs.realpathSync(repoA);
  const want = path.join(m.cfg, "projects", slug(real), "memory");
  assert.equal(m.where(repoA).memory_dir, want);
  assert.equal(m.where(path.join(repoA, "src", "deep")).memory_dir, want);
  const wt = path.join(TMP, "ws", "platform-wt");
  git(repoA, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
  git(repoA, "worktree", "add", "-q", wt, "-b", "wt-branch");
  const info = m.where(wt);
  assert.equal(info.memory_dir, want); assert.equal(info.project, P);
  const np = m.where(plain);
  assert.equal(np.synced, false); assert.equal(np.project, null);
  const custom = path.join(TMP, "custom-mem");
  fs.mkdirSync(m.cfg, { recursive: true }); fs.writeFileSync(path.join(m.cfg, "settings.json"), JSON.stringify({ autoMemoryDirectory: custom }));
  assert.equal(m.where(repoA).memory_dir, custom);
});

await t("Windows-style paths (simulated): slug, long-path hash, hook command quoting, JSON-escaped auto_memory detection, transcript cwd", async () => {
  const r = pyEval(`
print(json.dumps({
  "a": m.native_slug("C:\\\\Users\\\\dev\\\\my repo"),
  "b": m.native_slug("/home/user/proj"),
  "c": m.native_slug("x" * 250),
  "d": m.native_slug("é/日本"),
  "e": m.hook_command("C:\\\\Python312\\\\python.exe", "C:\\\\Users\\\\dev\\\\.claude\\\\memsync\\\\memsync.py", "pull", windows=True),
  "f": m.hook_command("/usr/bin/python3", "/home/u/.claude/memsync/memsync.py", "push", windows=False),
  "h": m.java_hash("hello"),
}))`);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.a, "C--Users-dev-my-repo"); assert.equal(o.b, "-home-user-proj");
  assert(o.c.startsWith("x".repeat(200) + "-") && o.c.length > 201 && o.c.length < 215);
  assert.equal(o.d, "----");
  assert.equal(o.e, '"C:/Python312/python.exe" "C:/Users/dev/.claude/memsync/memsync.py" pull');
  assert.equal(o.f, '"/usr/bin/python3" "/home/u/.claude/memsync/memsync.py" push');
  assert.equal(o.h, 99162322); // "hello".hashCode() in Java
  // auto_memory_state: the transcript escapes backslashes
  const tr = path.join(TMP, "win-transcript.jsonl");
  fs.writeFileSync(tr, JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: "memory dir is C:\\Users\\dev\\.claude\\projects\\C--p\\memory\\" } }) + "\n");
  fs.mkdirSync(path.join(TMP, "win-proj"), { recursive: true });
  const r3 = pyEval(`
from pathlib import Path
m.STATE = Path(${JSON.stringify(path.join(TMP, "win-state"))}); m.AM_CACHE = m.STATE / "am.json"; m.STATE.mkdir(exist_ok=True)
m.MEM = Path("C:\\\\Users\\\\dev\\\\.claude\\\\projects\\\\C--p\\\\memory")
print(m.auto_memory_state("s1", {"transcript_path": ${JSON.stringify(tr)}}))
p = Path(${JSON.stringify(path.join(TMP, "win-proj"))}); (p / "a.jsonl").write_text(json.dumps({"cwd": "C:\\\\Users\\\\dev\\\\my repo"}) + "\\n", encoding="utf-8")
print(m.transcript_cwd(p))`);
  assert.equal(r3.status, 0, r3.stderr);
  assert.deepEqual(r3.stdout.trim().split("\n"), ["true", "C:\\Users\\dev\\my repo"]);
});

// ---------------------------------------------------------------- first sync
const A = machine(), Bm = machine();
await t("first sync, machine A: existing local memory + own CLAUDE.md are uploaded, nothing local changes or disappears", async () => {
  A.install();
  A.write(repoA, "MEMORY.md", "- [Deploy](deploy.md) — node order\n");
  A.write(repoA, "deploy.md", "---\nname: Deploy\n---\nB then A\n");
  A.write(repoA, "shared.md", "A's version of shared\n");
  fs.mkdirSync(A.cfg, { recursive: true });
  fs.writeFileSync(path.join(A.cfg, "CLAUDE.md"), "# My rules\n\n- Reply in Chinese\n");
  const r = A.pull(repoA); assert.equal(r.stdout, "");
  const f = srv();
  assert.equal(f[pd(P) + "deploy.md"], "---\nname: Deploy\n---\nB then A\n");
  assert.equal(f[pd(P) + "shared.md"], "A's version of shared\n");
  assert(f[pd(P) + "MEMORY.md"].includes("[Deploy](deploy.md)"));
  assert(f["global/CLAUDE.md"].includes("- Reply in Chinese") && f["global/CLAUDE.md"].includes("# My rules") && !f["global/CLAUDE.md"].includes("Global memory (shared"));
  assert.equal(A.read(repoA, "deploy.md"), "---\nname: Deploy\n---\nB then A\n");
  assert(A.claude().startsWith(HEADER_LOCAL) && A.claude().includes("- Reply in Chinese"));
  assert(fs.readdirSync(path.join(A.cfg, "memsync", "projects")).length >= 1);
});

await t("first sync, machine B: union of both sides, conflicting same-name file keeps both, server data untouched, nothing deleted", async () => {
  Bm.install();
  Bm.write(repoA, "MEMORY.md", "- [Retry](retry.md) — 3 tries\n- [Shared](shared.md) — B's note\n");
  Bm.write(repoA, "retry.md", "3 tries, 200ms\n");
  Bm.write(repoA, "shared.md", "B's version of shared\n");
  fs.mkdirSync(Bm.cfg, { recursive: true });
  fs.writeFileSync(path.join(Bm.cfg, "CLAUDE.md"), "- Prefer tabs\n- Reply in Chinese\n");
  const before = srv();
  const r = Bm.pull(repoA); assert.equal(r.stdout, "");
  // local side
  assert.deepEqual(Bm.files(repoA), ["MEMORY.md", "deploy.md", "retry.md", "shared.local.md", "shared.md"]);
  assert.equal(Bm.read(repoA, "shared.md"), "A's version of shared\n");           // server version at the original name
  assert.equal(Bm.read(repoA, "shared.local.md"), "B's version of shared\n");      // local version preserved
  assert.equal(Bm.read(repoA, "retry.md"), "3 tries, 200ms\n");
  const idx = Bm.read(repoA, "MEMORY.md");
  assert(idx.includes("[Deploy](deploy.md)") && idx.includes("[Retry](retry.md)") && idx.includes("[Shared](shared.local.md) — B's note"));
  const g = Bm.claude();
  assert(g.startsWith(HEADER_LOCAL) && g.includes("- Prefer tabs") && g.includes("- Reply in Chinese") && g.includes("# My rules"));
  assert.equal(g.split("- Reply in Chinese").length, 2, "duplicate line must not be doubled");
  // server side: everything it had is still there, plus B's
  const after = srv();
  for (const k of Object.keys(before)) assert(k in after, "server lost " + k);
  assert.equal(after[pd(P) + "shared.md"], "A's version of shared\n");
  assert.equal(after[pd(P) + "shared.local.md"], "B's version of shared\n");
  assert.equal(after[pd(P) + "retry.md"], "3 tries, 200ms\n");
  assert(after[pd(P) + "MEMORY.md"].includes("[Deploy](deploy.md)") && after[pd(P) + "MEMORY.md"].includes("[Retry](retry.md)"));
  assert(after["global/CLAUDE.md"].includes("- Prefer tabs") && after["global/CLAUDE.md"].includes("- Reply in Chinese"));
  assert(fs.existsSync(path.join(Bm.cfg, "memsync", "projects")) && fs.readdirSync(path.join(Bm.cfg, "memsync", "projects")).length >= 1);
});

await t("after first sync both machines converge (pull on A sees B's files and global line); normal edits and deletes sync", async () => {
  A.pull(repoA);
  assert.deepEqual(A.files(repoA), ["MEMORY.md", "deploy.md", "retry.md", "shared.local.md", "shared.md"]);
  assert(A.claude().includes("- Prefer tabs"));
  A.write(repoA, "deploy.md", "---\nname: Deploy\n---\nA then B\n");
  A.push(repoA, { cwd: path.join(repoA, "src") }); // Stop hook cwd inside the repo
  assert.equal(srv()[pd(P) + "deploy.md"], "---\nname: Deploy\n---\nA then B\n");
  Bm.pull(repoA);
  assert.equal(Bm.read(repoA, "deploy.md"), "---\nname: Deploy\n---\nA then B\n");
  fs.unlinkSync(path.join(A.mem(repoA), "retry.md"));
  A.push(repoA);
  assert(!(pd(P) + "retry.md" in srv()));
});

await t("projects stay apart (own native dir and base); global file is shared between them", async () => {
  Bm.pull(repoB);
  assert.deepEqual(Bm.files(repoB), []);
  assert.notEqual(Bm.mem(repoA), Bm.mem(repoB));
  Bm.write(repoB, "MEMORY.md", "- [Lint](lint.md) — ruff\n"); Bm.write(repoB, "lint.md", "ruff\n");
  fs.writeFileSync(path.join(Bm.cfg, "CLAUDE.md"), Bm.claude() + "- No emoji\n");
  Bm.push(repoB);
  const f = srv();
  assert.equal(f["projects/github.com/acme/tools/lint.md"], "ruff\n");
  assert(f["global/CLAUDE.md"].includes("- No emoji"));
  assert(!Object.keys(f).some((k) => k.startsWith(pd(P)) && k.endsWith("lint.md")));
  A.pull(repoB);                                    // machine A, first time in project B
  assert.equal(A.read(repoB, "lint.md"), "ruff\n");
  assert(A.claude().includes("- No emoji"));        // global updated through another project's sync
  assert.deepEqual(A.files(repoA).includes("lint.md"), false);
});

await t("non-git directory: only the global file syncs, no project memory is created or uploaded", async () => {
  const before = Object.keys(srv()).filter((k) => k.startsWith("projects/")).length;
  A.pull(plain);
  A.push(plain);
  assert.equal(Object.keys(srv()).filter((k) => k.startsWith("projects/")).length, before);
  assert(!Object.keys(srv()).some((k) => k.includes("_norepo")));
  assert(A.claude().includes("- No emoji"));
});

// ---------------------------------------------------------------- lock
await t("file lock: second holder times out, released on exit, O_EXCL fallback works and recovers a stale lock", async () => {
  const lockfile = path.join(TMP, "lk", "lock");
  for (const backend of ["os", "excl"]) {
    const holder = spawn("python3", ["-c", `import sys, time, importlib.util\nspec = importlib.util.spec_from_file_location("memsync", ${JSON.stringify(CLIENT)})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nwith m.file_lock(${JSON.stringify(lockfile)}, 5):\n    print("held", flush=True); time.sleep(2.5)`],
      { env: { ...cleanEnv, MEMSYNC_LOCK_BACKEND: backend }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((res) => holder.stdout.once("data", res));
    const t0 = Date.now();
    const r = pyEval(`
try:
    with m.file_lock(${JSON.stringify(lockfile)}, 0.4):
        print("got")
except m.LockTimeout:
    print("timeout")`, { MEMSYNC_LOCK_BACKEND: backend });
    assert.equal(r.stdout.trim(), "timeout", backend + " " + r.stderr);
    assert(Date.now() - t0 < 2000);
    await new Promise((res) => holder.on("close", res));
    const r2 = pyEval(`
with m.file_lock(${JSON.stringify(lockfile)}, 2):
    print("got")`, { MEMSYNC_LOCK_BACKEND: backend });
    assert.equal(r2.stdout.trim(), "got", backend + " " + r2.stderr);
  }
  const stale = lockfile + ".excl"; fs.writeFileSync(stale, ""); const old = new Date(Date.now() - 120000); fs.utimesSync(stale, old, old);
  const r3 = pyEval(`
with m.file_lock(${JSON.stringify(lockfile)}, 2):
    print("got")`, { MEMSYNC_LOCK_BACKEND: "excl" });
  assert.equal(r3.stdout.trim(), "got");
});

await t("concurrent hooks of several local sessions: all new files reach the server, state files stay valid JSON", async () => {
  const m = machine(); m.install(); m.pull(repoB);
  const procs = [];
  for (let i = 0; i < 6; i++) {
    m.write(repoB, `c${i}.md`, `concurrent ${i}\n`);
    const groups = m.settings().hooks.Stop;
    const cmd = groups.flatMap((g) => g.hooks).find((h) => h.command.includes("memsync.py")).command;
    procs.push(new Promise((res) => { const p = spawn("sh", ["-c", cmd], { cwd: TMP, env: m.env({ CLAUDE_PROJECT_DIR: repoB }) }); p.stdin.end(JSON.stringify({ cwd: repoB, session_id: "c" + i })); p.on("close", res); }));
  }
  const codes = await Promise.all(procs); assert(codes.every((c) => c === 0));
  const f = srv();
  for (let i = 0; i < 6; i++) assert.equal(f[`projects/github.com/acme/tools/c${i}.md`], `concurrent ${i}\n`);
  const sd = path.join(m.cfg, "memsync", "projects");
  for (const d of fs.readdirSync(sd)) for (const j of ["base.json", "layout.json"]) JSON.parse(fs.readFileSync(path.join(sd, d, j), "utf8"));
  JSON.parse(fs.readFileSync(path.join(m.cfg, "memsync", "global_base.json"), "utf8"));
});

// ---------------------------------------------------------------- migration
await t("migrate: existing native dirs are mapped through their transcript cwd to git projects; dry run changes nothing; unmapped dirs are skipped", async () => {
  const m = machine(); m.install();
  const repoC = mkrepo(path.join(TMP, "ws", "billing"), "https://github.com/acme/billing.git");
  const gone = path.join(TMP, "ws", "deleted-repo");
  const dirs = {};
  const mk = (name, cwd, files) => {
    const d = path.join(m.cfg, "projects", name); fs.mkdirSync(path.join(d, "memory"), { recursive: true });
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, "memory", k), v);
    if (cwd) fs.writeFileSync(path.join(d, "s1.jsonl"), JSON.stringify({ type: "user", cwd }) + "\n");
    dirs[name] = path.join(d, "memory");
  };
  mk("-p-billing", repoC, { "MEMORY.md": "- [Owner](owner.md) — team x\n", "owner.md": "team x owns billing\n" });
  mk("-p-sub", path.join(repoA, "src", "deep"), { "MEMORY.md": "- [Sub](sub.md) — from a subdir session\n", "sub.md": "sub\n" }); // legacy dir keyed on a subdirectory
  mk("-p-plain", plain, { "MEMORY.md": "- [N](n.md) — notes\n", "n.md": "plain dir note\n" });
  mk("-p-gone", gone, { "x.md": "x\n" });
  mk("-p-nocwd", null, { "y.md": "y\n" });
  const before = JSON.stringify(srv());
  let r = m.py(["migrate"]); assert.equal(r.status, 0, r.stderr);
  assert(r.stdout.includes("would sync -p-billing") && r.stdout.includes("github.com/acme/billing") && r.stdout.includes("skip   -p-plain") && r.stdout.includes("cwd no longer exists") && r.stdout.includes("cwd unknown"));
  assert.equal(JSON.stringify(srv()), before);
  r = m.py(["migrate", "--apply"]); assert.equal(r.status, 0, r.stderr + r.stdout);
  const f = srv();
  assert.equal(f["projects/github.com/acme/billing/owner.md"], "team x owns billing\n");
  assert(f["projects/github.com/acme/billing/MEMORY.md"].includes("[Owner](owner.md)"));
  assert.equal(f[pd(P) + "sub.md"], "sub\n");
  assert(!Object.keys(f).some((k) => k.endsWith("n.md") && !k.endsWith("lint.md") && k.includes("_norepo")));
  assert(!Object.values(f).some((v) => v === "plain dir note\n" || v === "x\n" || v === "y\n"));
  // local files are all still there and the unmapped ones untouched
  assert.equal(fs.readFileSync(path.join(dirs["-p-plain"], "n.md"), "utf8"), "plain dir note\n");
  assert.equal(fs.readFileSync(path.join(dirs["-p-billing"], "owner.md"), "utf8"), "team x owns billing\n");
  // the sub-dir legacy dir merged with the server's project files without losing its own
  assert(fs.existsSync(path.join(dirs["-p-sub"], "sub.md")) && fs.existsSync(path.join(dirs["-p-sub"], "deploy.md")));
  // a later session in the repo finds the migrated memory through the normal hook
  m.pull(repoC);
  assert.equal(m.read(repoC, "owner.md"), "team x owns billing\n");
});

w.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
