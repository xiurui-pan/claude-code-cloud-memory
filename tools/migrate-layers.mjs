#!/usr/bin/env node
// Move an existing flat memory store (legacy root files) into layers: a global CLAUDE.md body and
// per-project folders. Input is a JSON plan you write; the tool never decides what is global.
//
//   node tools/migrate-layers.mjs plan.json            dry run: prints what would change
//   node tools/migrate-layers.mjs plan.json --apply    execute through the sync API
//
// Plan:
//   {
//     "global_claude_md": "- Reply in Chinese\n- ...",                  body text, header NOT included; lines are merged into global/CLAUDE.md
//     "moves": [ {"from": "deploy.md", "to": "projects/github.com/acme/platform/deploy.md"} ],
//     "drop":  [ "obsolete.md" ],                                        legacy files to delete (history keeps them)
//     "project_indexes": { "github.com/acme/platform": "- [Deploy](deploy.md) — ...\n" }   lines merged into that project's MEMORY.md
//   }
//
// Environment: MEMSYNC_URL (required, or --url), MEMSYNC_TOKEN (not needed inside a cloud session whose
// network proxy injects the bearer; in that case run node with NODE_USE_ENV_PROXY=1 so fetch honours HTTPS_PROXY).
// Moves keep history (the old path gets a delete row, the new path a write row). Legacy root files the plan
// does not mention stay where they are and show up as "Legacy root" in the admin UI.

import fs from "node:fs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const uIdx = args.indexOf("--url");
const planFile = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
const URL_ = (uIdx >= 0 ? args[uIdx + 1] : process.env.MEMSYNC_URL || "").replace(/\/+$/, "");
if (!planFile || !URL_) {
  console.error("usage: MEMSYNC_URL=https://memory.example.com node tools/migrate-layers.mjs plan.json [--apply]");
  process.exit(2);
}

const PID_RE = /^(?:_norepo|[a-z0-9][a-z0-9.\-]*(?:\/[a-z0-9._\-]+){2})$/;
const PATH_RE = /^[A-Za-z0-9._\-\/]{1,200}\.md$/;
const isProjectPath = (p) => { const m = typeof p === "string" && p.match(/^projects\/(.+)\/([^/]+\.md)$/); return !!m && PID_RE.test(m[1]) && PATH_RE.test(p) && !p.includes(".."); };
const isLegacy = (p) => typeof p === "string" && PATH_RE.test(p) && !p.includes("..") && !p.startsWith("/") && !p.includes("//") && !p.startsWith("global/") && !p.startsWith("projects/");
const lines = (t) => String(t).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());

const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const errors = [];
const moves = plan.moves || [], drop = plan.drop || [], indexes = plan.project_indexes || {};
for (const m of moves) {
  if (!isLegacy(m && m.from)) errors.push(`move: "from" must be a legacy root file: ${m && m.from}`);
  if (!isProjectPath(m && m.to)) errors.push(`move: "to" must be projects/<host>/<owner>/<repo>/<file>.md: ${m && m.to}`);
}
for (const d of drop) if (!isLegacy(d)) errors.push(`drop: not a legacy root file: ${d}`);
for (const pid of Object.keys(indexes)) if (!PID_RE.test(pid) || `projects/${pid}/MEMORY.md`.length > 200) errors.push(`project_indexes: bad project id: ${pid}`);
if (plan.global_claude_md !== undefined && typeof plan.global_claude_md !== "string") errors.push("global_claude_md must be a string");
if (errors.length) { console.error(errors.join("\n")); process.exit(2); }

const headers = { "content-type": "application/json", "user-agent": "memsync-migrate/3", ...(process.env.MEMSYNC_TOKEN ? { authorization: `Bearer ${process.env.MEMSYNC_TOKEN}` } : {}) };
async function api(method, path, body) {
  const r = await fetch(URL_ + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok && !(j && j.results)) throw Object.assign(new Error(`${method} ${path}: HTTP ${r.status} ${j.error || ""}`), { status: r.status });
  return j;
}

// Current server state: legacy root files + the layers the plan touches.
const pids = [...new Set([...Object.keys(indexes), ...moves.map((m) => m.to.match(/^projects\/(.+)\/[^/]+$/)[1])])];
const legacy = new Map((await api("GET", "/v1/pull")).files.map((f) => [f.path, f]));
const layered = new Map((await api("GET", `/v1/pull?global=1${pids.length ? "&projects=" + encodeURIComponent(pids.join(",")) : "&projects="}`)).files.map((f) => [f.path, f]));

const ops = []; // {title, notes: [], run: async () => ...}
let problems = 0;
const note = (op, s) => op.notes.push(s);

for (const m of moves) {
  const op = { title: `move  ${m.from}  ->  ${m.to}`, notes: [] };
  const src = legacy.get(m.from), dst = layered.get(m.to);
  const isIdx = m.to.endsWith("/MEMORY.md") && m.from === "MEMORY.md";
  if (!src) { note(op, "SKIP: source not found"); problems++; op.run = null; }
  else if (dst && !isIdx) { note(op, "CONFLICT: destination exists (move it elsewhere or drop one)"); problems++; op.run = null; }
  else {
    if (dst) note(op, "destination index exists: lines are merged");
    op.run = () => api("POST", "/v1/move", { from: m.from, to: m.to });
  }
  ops.push(op);
}

function mergeOp(title, path, text) {
  const op = { title, notes: [] };
  const cur = layered.get(path);
  const have = new Set(lines(cur ? cur.content : ""));
  const add = lines(text).filter((l) => !have.has(l));
  note(op, cur ? `merge into existing file (${have.size} line(s) there)` : "create file");
  for (const l of add) note(op, "+ " + l);
  if (!add.length && cur) { note(op, "nothing new"); op.run = null; }
  else op.run = async () => {
    const body = { session: "migrate", files: [{ path, content: String(text).endsWith("\n") ? text : text + "\n", base_sha: null, added_lines: lines(text), removed_lines: [] }] };
    const res = (await api("POST", "/v1/push", body)).results[0];
    if (!["written", "merged", "noop"].includes(res.status)) throw new Error(`${path}: ${res.status}`);
    return res;
  };
  ops.push(op);
}
for (const [pid, text] of Object.entries(indexes)) mergeOp(`index ${`projects/${pid}/MEMORY.md`}`, `projects/${pid}/MEMORY.md`, text);
if (plan.global_claude_md) mergeOp("global global/CLAUDE.md", "global/CLAUDE.md", plan.global_claude_md);

for (const d of drop) {
  const op = { title: `drop  ${d}`, notes: [] };
  const f = legacy.get(d);
  if (!f) { note(op, "SKIP: not found"); op.run = null; }
  else op.run = async () => {
    const res = (await api("POST", "/v1/push", { session: "migrate", files: [{ path: d, content: null, base_sha: f.sha }] })).results[0];
    if (res.status !== "deleted") throw new Error(`${d}: ${res.status}`);
    return res;
  };
  ops.push(op);
}

console.log(`${apply ? "APPLY" : "DRY RUN"} against ${URL_}: ${ops.length} operation(s)\n`);
let failed = 0;
for (const op of ops) {
  console.log(op.title);
  for (const n of op.notes) console.log("    " + n);
  if (apply && op.run) {
    try { await op.run(); console.log("    done"); } catch (e) { failed++; console.log("    FAILED: " + e.message); }
  }
}
const left = [...legacy.keys()].filter((p) => !moves.some((m) => m.from === p) && !drop.includes(p));
console.log(`\n${left.length} legacy root file(s) stay where they are${left.length ? " (classify them in the admin UI): " + left.join(", ") : ""}`);
if (!apply) console.log("Dry run only. Re-run with --apply to execute.");
process.exit(failed || problems ? 1 : 0);
