// Memory layers: global/CLAUDE.md, projects/<pid>/*, project identity and submodule grouping.
// Shared by the /v1 sync API and /admin.
//
//   pid  = normalized git remote of a project's root repo: host/owner/repo (lowercase), or _norepo
//          (exactly three segments, so projects/<pid>/<file> parses unambiguously)
//   A superrepo and all its submodules are ONE project; membership (repo -> pid) is learned from
//   .gitmodules reports (POST /v1/resolve) or set by hand in the admin UI.

import { GLOBAL, MAX_PID, validPath, validPid, writeRow, sha256Hex, mergeIndex, isMergePath, classify } from "./store.js";

export const projectDir = (pid) => `projects/${pid}/`;

// ---------- repo URL normalization ----------
// https://user:tok@GitHub.com/Acme/Platform.git/ , git@github.com:acme/platform.git ,
// ssh://git@github.com:22/acme/platform , github.com/acme/platform  ->  github.com/acme/platform
export function normRepo(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  let host, rest, m;
  if ((m = s.match(/^[a-z][a-z0-9+.\-]*:\/\/(?:[^/@]*@)?([^/:@]+)(?::\d+)?\/(.+)$/i))) [, host, rest] = m;
  else if ((m = s.match(/^(?:[^@/\s]+@)?([^/:@\s]+):(?!\/\/)(.+)$/))) [, host, rest] = m; // scp-like
  else if ((m = s.match(/^([^/@:\s]+\.[^/@:\s]+|localhost)\/(.+)$/i))) [, host, rest] = m; // bare host/owner/repo
  else return null;
  const segs = rest.split(/[?#]/)[0].split("/").filter(Boolean);
  if (segs.length !== 2) return null; // host/owner/repo only; deeper paths (nested groups) are not supported
  segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, "");
  host = host.toLowerCase();
  const out = [host, ...segs.map((x) => x.toLowerCase())];
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(host)) return null;
  if (!out.slice(1).every((x) => /^[a-z0-9._\-]+$/.test(x) && x !== "." && x !== "..")) return null;
  return out.join("/");
}

// Resolve a submodule URL against the superrepo's remote (git semantics: relative to the remote URL).
export function resolveRel(sub, base) {
  const s = String(sub || "").trim();
  if (!/^\.\.?\//.test(s)) return normRepo(s);
  const b = normRepo(base);
  if (!b) return null;
  const parts = b.split("/");
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length > 1) parts.pop(); } else parts.push(seg);
  }
  return normRepo(parts.join("/"));
}

// ---------- low-level file moves (history preserving: delete row + write row) ----------
const getRow = (env, path) => env.DB.prepare("SELECT path, content, sha, deleted FROM files WHERE path = ?").bind(path).first();
const isLive = (r) => !!r && !r.deleted;
const rewriteLinks = (text, renames) => text.replace(/\]\(([^)]+)\)/g, (m, t) => (t in renames ? `](${renames[t]})` : m));

// Write `content` at dest and delete the source row. Destination first, so a crash leaves a duplicate, never a loss.
async function transfer(env, src, dest, content, session) {
  const now = Date.now();
  const dst = await getRow(env, dest);
  const sha = await sha256Hex(content);
  if (!(await writeRow(env, dest, dst, content, sha, 0, session, now))) throw new Error(`write conflict on ${dest}`);
  if (!(await writeRow(env, src.path, src, "", "", 1, session, now))) throw new Error(`write conflict on ${src.path}`);
  return sha;
}

// Move one file. Merges line-wise when both sides are indexes; other collisions are refused.
export async function movePath(env, from, to, session = "move") {
  if (!validPath(from) || !validPath(to)) return { error: "bad path", status: 400 };
  if (from === to) return { error: "from and to are the same", status: 400 };
  const src = await getRow(env, from);
  if (!isLive(src)) return { error: "source not found", status: 404 };
  const dst = await getRow(env, to);
  let content = src.content, result = "moved";
  if (isLive(dst)) {
    const isIdx = (p) => p.split("/").pop() === "MEMORY.md";
    if (!(isIdx(from) && isIdx(to))) return { error: "destination exists", status: 409 };
    content = mergeIndex(dst.content, src.content.split("\n"), []);
    result = "merged";
  }
  return { ok: true, result, path: to, sha: await transfer(env, src, to, content, session) };
}

// Move every live file under from_prefix to to_prefix. Name collisions are renamed <stem>.<n>.md
// (links in the moved index are rewritten); two indexes are merged.
export async function movePrefix(env, fromPrefix, toPrefix, session = "move") {
  const okPrefix = (p) => typeof p === "string" && /^[A-Za-z0-9._\-/]+\/$/.test(p) && !p.includes("..") && !p.startsWith("/") && !p.includes("//");
  if (!okPrefix(fromPrefix) || !okPrefix(toPrefix)) return { error: "prefixes must be relative paths ending with /", status: 400 };
  if (fromPrefix === toPrefix || toPrefix.startsWith(fromPrefix)) return { error: "invalid prefix pair", status: 400 };
  const { results } = await env.DB.prepare(
    "SELECT path, content, sha, deleted FROM files WHERE deleted = 0 AND substr(path, 1, ?) = ? ORDER BY path"
  ).bind(fromPrefix.length, fromPrefix).all();
  const moved = [], renames = {}, indexes = [];
  for (const r of results) {
    const rest = r.path.slice(fromPrefix.length);
    if (isMergePath(r.path)) { indexes.push(r); continue; }
    let name = rest;
    if (isLive(await getRow(env, toPrefix + name))) {
      const dot = rest.lastIndexOf(".");
      for (let n = 2; ; n++) {
        name = `${rest.slice(0, dot)}.${n}${rest.slice(dot)}`;
        if (!isLive(await getRow(env, toPrefix + name))) break;
      }
      renames[rest] = name;
    }
    if (!validPath(toPrefix + name)) return { error: `invalid destination path ${toPrefix + name}`, status: 400, moved };
    await transfer(env, r, toPrefix + name, r.content, session);
    moved.push({ from: r.path, to: toPrefix + name });
  }
  for (const r of indexes) {
    const dest = toPrefix + r.path.slice(fromPrefix.length);
    if (!validPath(dest)) return { error: `invalid destination path ${dest}`, status: 400, moved };
    const dst = await getRow(env, dest);
    let content = rewriteLinks(r.content, renames);
    if (isLive(dst)) content = mergeIndex(dst.content, content.split("\n"), []);
    await transfer(env, r, dest, content, session);
    moved.push({ from: r.path, to: dest });
  }
  return { ok: true, moved, renamed: renames };
}

// ---------- membership + resolve ----------
const member = (env, repo) => env.DB.prepare("SELECT repo, pid, source FROM repo_membership WHERE repo = ?").bind(repo).first();

async function setMember(env, repo, pid, source) {
  await env.DB.prepare(
    "INSERT INTO repo_membership (repo, pid, source, updated) VALUES (?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET pid = excluded.pid, source = excluded.source, updated = excluded.updated"
  ).bind(repo, pid, source, Date.now()).run();
}

async function touchProject(env, pid) {
  await env.DB.prepare("INSERT OR IGNORE INTO projects (pid, created) VALUES (?, ?)").bind(pid, Date.now()).run();
}

// Project `from` becomes part of project `to`: files move (history kept), membership rows follow.
async function reparent(env, from, to, session) {
  if (from === to) return;
  const r = await movePrefix(env, projectDir(from), projectDir(to), session);
  if (r.error) throw new Error(`reparent ${from} -> ${to}: ${r.error}`);
  await env.DB.prepare("UPDATE repo_membership SET pid = ?, updated = ? WHERE pid = ?").bind(to, Date.now(), from).run();
  await env.DB.prepare("DELETE FROM projects WHERE pid = ?").bind(from).run();
  await touchProject(env, to);
}

// repos: [{url, submodules: [url...]}]  ->  {projects: [pid...], map: {url: pid}}
// Throws Error with .status = 400 on unusable input.
export async function resolveRepos(env, repos) {
  if (!Array.isArray(repos) || repos.length > 100) throw Object.assign(new Error("repos must be an array (max 100)"), { status: 400 });
  const map = {}, projects = new Set();
  for (const r of repos) {
    const url = r && r.url;
    const repo = normRepo(url);
    if (!repo) continue;
    if (repo.length > MAX_PID) throw Object.assign(new Error(`project id too long (max ${MAX_PID} chars): ${repo.slice(0, 60)}...`), { status: 400 });
    let row = await member(env, repo);
    if (!row) { await setMember(env, repo, repo, "self"); row = { repo, pid: repo, source: "self" }; }
    const pid = row.pid;
    for (const su of Array.isArray(r.submodules) ? r.submodules.slice(0, 200) : []) {
      const sub = resolveRel(su, url);
      if (!sub || sub === repo || sub.length > MAX_PID) continue;
      const cur = await member(env, sub);
      if (!cur) {
        await setMember(env, sub, pid, "gitmodules");
        await reparent(env, sub, pid, "reparent"); // files that landed under the submodule's own id before membership was known
      } else if (cur.source !== "manual" && cur.pid !== pid) {
        await setMember(env, sub, pid, "gitmodules");
        if (cur.pid === sub) await reparent(env, sub, pid, "reparent"); // it had its own project: fold it in
      }
      map[su] = pid;
    }
    map[url] = pid;
    await touchProject(env, pid);
    projects.add(pid);
  }
  return { projects: [...projects].sort(), map };
}

// ---------- pull ----------
// No params: legacy root files only (old clients). Otherwise global/CLAUDE.md and/or whole projects.
export async function pullFiles(env, { projects, global }) {
  if (projects === null && !global) {
    const { results } = await env.DB.prepare(
      "SELECT path, content, sha, modified FROM files WHERE deleted = 0 AND path NOT LIKE 'global/%' AND path NOT LIKE 'projects/%' ORDER BY path"
    ).all();
    return results;
  }
  const conds = [], binds = [];
  if (global) { conds.push("path = ?"); binds.push(GLOBAL); }
  for (const pid of projects || []) {
    conds.push("substr(path, 1, ?) = ?");
    binds.push(projectDir(pid).length, projectDir(pid));
  }
  if (!conds.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT path, content, sha, modified FROM files WHERE deleted = 0 AND (${conds.join(" OR ")}) ORDER BY path`
  ).bind(...binds).all();
  return results;
}

export function parsePullParams(url) {
  const raw = url.searchParams.get("projects");
  const global = ["1", "true"].includes(url.searchParams.get("global") || "");
  if (raw === null) return { projects: null, global };
  const projects = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (projects.length > 50 || !projects.every(validPid)) return { error: "bad projects parameter" };
  return { projects: [...new Set(projects)], global };
}

// ---------- admin helpers ----------
export async function listProjects(env) {
  const { results: rows } = await env.DB.prepare("SELECT pid, label, created FROM projects").all();
  const { results: mem } = await env.DB.prepare("SELECT repo, pid, source FROM repo_membership ORDER BY repo").all();
  const { results: files } = await env.DB.prepare("SELECT path FROM files WHERE deleted = 0 AND path LIKE 'projects/%'").all();
  const byPid = new Map(rows.map((r) => [r.pid, { pid: r.pid, label: r.label, repos: [], files: 0 }]));
  const get = (pid) => { if (!byPid.has(pid)) byPid.set(pid, { pid, label: null, repos: [], files: 0 }); return byPid.get(pid); };
  for (const m of mem) get(m.pid).repos.push({ repo: m.repo, source: m.source });
  for (const f of files) { const c = classify(f.path); if (c.layer === "project") get(c.pid).files++; }
  return [...byPid.values()].sort((a, b) => a.pid.localeCompare(b.pid));
}

// Merge project `from` into `into`: files move, every membership row follows (as manual, so a later
// resolve does not split it again).
export async function mergeProjects(env, from, into, session = "admin") {
  if (!validPid(from) || !validPid(into) || from === into) return { error: "bad project ids", status: 400 };
  const r = await movePrefix(env, projectDir(from), projectDir(into), session);
  if (r.error) return r;
  await env.DB.prepare("UPDATE repo_membership SET pid = ?, source = 'manual', updated = ? WHERE pid = ?").bind(into, Date.now(), from).run();
  await env.DB.prepare("DELETE FROM projects WHERE pid = ?").bind(from).run();
  await touchProject(env, into);
  return { ok: true, moved: r.moved, renamed: r.renamed };
}

export async function setMembership(env, repoUrl, pid) {
  const repo = normRepo(repoUrl);
  if (!repo || !validPid(pid)) return { error: "bad repo or project id", status: 400 };
  await setMember(env, repo, pid, "manual");
  await touchProject(env, pid);
  return { ok: true, repo, pid };
}

export async function deleteMembership(env, repoUrl) {
  const repo = normRepo(repoUrl);
  if (!repo) return { error: "bad repo", status: 400 };
  await env.DB.prepare("DELETE FROM repo_membership WHERE repo = ?").bind(repo).run();
  return { ok: true, repo };
}
