// Shared helpers and the single write path used by both the /v1 sync API and /admin.

export const INDEX = "MEMORY.md";
export const MAX_FILE_BYTES = 200_000;
const PATH_RE = /^[A-Za-z0-9._\-\/]{1,200}\.md$/;
export const GLOBAL = "global/CLAUDE.md";
export const NOREPO = "_norepo";
export const MAX_PID = 180; // "projects/" + pid + "/MEMORY.md" must stay within 200 chars
// Project id: host/owner/repo, or _norepo.
const PID_RE = /^(?:_norepo|[a-z0-9][a-z0-9.\-]*(?:\/[a-z0-9._\-]+){2})$/;

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sha256Hex(text) {
  return [...(await sha256Bytes(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validPid(p) {
  return typeof p === "string" && p.length <= MAX_PID && PID_RE.test(p) && !p.includes("..") && !p.includes("//");
}

// Legacy root files (no prefix) keep the original rules. Layered paths are exactly
// global/CLAUDE.md and projects/<pid>/<file>.md (project files are direct children).
export function validPath(p) {
  if (!(typeof p === "string" && PATH_RE.test(p) && !p.includes("..") && !p.startsWith("/") && !p.includes("//"))) return false;
  if (p.startsWith("global/")) return p === GLOBAL;
  if (p.startsWith("projects/")) {
    const m = p.match(/^projects\/(.+)\/([^/]+\.md)$/);
    return !!m && validPid(m[1]);
  }
  return true;
}

// Paths that get the 3-way line merge: every MEMORY.md index and the global CLAUDE.md.
export const isMergePath = (p) => p === GLOBAL || p.split("/").pop() === INDEX;

// Where a path lives: {layer: "global"} | {layer: "project", pid, file} | {layer: "legacy"}.
export function classify(p) {
  if (p === GLOBAL) return { layer: "global" };
  const m = p.match(/^projects\/(.+)\/([^/]+\.md)$/);
  return m ? { layer: "project", pid: m[1], file: m[2] } : { layer: "legacy" };
}

// Apply a 3-way line diff for MEMORY.md indexes and global/CLAUDE.md: drop the lines the client removed,
// append the lines the client added, keep everything other sessions wrote.
export function mergeIndex(serverText, added, removed) {
  const removedSet = new Set((removed || []).map((l) => l.trimEnd()));
  const lines = serverText.replace(/\n+$/, "").split("\n").filter((l) => !removedSet.has(l.trimEnd()));
  const present = new Set(lines.map((l) => l.trimEnd()));
  for (const l of added || []) {
    const t = l.trimEnd();
    if (t && !present.has(t)) {
      lines.push(l);
      present.add(t);
    }
  }
  return lines.join("\n") + "\n";
}

export async function writeRow(env, path, cur, content, sha, deleted, session, now) {
  // Optimistic concurrency: the write only lands if the row is still what we read.
  let stmt;
  if (cur) {
    stmt = env.DB.prepare(
      "UPDATE files SET content = ?, sha = ?, deleted = ?, modified = ?, session = ? WHERE path = ? AND sha = ? AND deleted = ?"
    ).bind(content, sha, deleted, now, session, path, cur.sha, cur.deleted);
  } else {
    stmt = env.DB.prepare(
      "INSERT INTO files (path, content, sha, deleted, modified, session) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING"
    ).bind(path, content, sha, deleted, now, session);
  }
  const res = await stmt.run();
  if (!res.meta || res.meta.changes !== 1) return false;
  await env.DB.prepare(
    "INSERT INTO history (path, content, sha, deleted, session, at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(path, content, sha, deleted, session, now).run();
  return true;
}

export async function applyOne(env, f, session) {
  const path = f.path;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await env.DB.prepare("SELECT path, content, sha, deleted FROM files WHERE path = ?").bind(path).first();
    const liveSha = cur && !cur.deleted ? cur.sha : null;
    const base = f.base_sha || null;
    const now = Date.now();

    if (f.content === null || f.content === undefined) {
      // Deletion
      if (liveSha === null) return { path, status: "noop" };
      if (liveSha !== base) return { path, status: "kept_remote", sha: liveSha, content: cur.content };
      if (await writeRow(env, path, cur, "", "", 1, session, now)) return { path, status: "deleted" };
      continue;
    }

    const sha = await sha256Hex(f.content);
    if (liveSha === sha) return { path, status: "noop", sha };

    let content = f.content;
    let status = "written";
    if (liveSha !== null && liveSha !== base) {
      // Someone else changed it since this client pulled.
      if (isMergePath(path) && cur) {
        content = mergeIndex(cur.content, f.added_lines, f.removed_lines);
        status = "merged";
      } else {
        status = "overwrote_remote"; // last writer wins; previous version stays in history
      }
    }
    const finalSha = content === f.content ? sha : await sha256Hex(content);
    if (await writeRow(env, path, cur, content, finalSha, 0, session, now)) {
      const out = { path, status, sha: finalSha };
      if (status === "merged") out.content = content;
      return out;
    }
  }
  return { path, status: "retry_exhausted" };
}

// Restore every file to its state at epoch-ms `at`. Returns the changed paths.
export async function restoreAt(env, at, session = "restore") {
  const { results: snap } = await env.DB.prepare(
    `SELECT h.path, h.content, h.sha, h.deleted FROM history h
     JOIN (SELECT path, MAX(id) AS mid FROM history WHERE at <= ? GROUP BY path) m ON h.id = m.mid`
  ).bind(at).all();
  const { results: live } = await env.DB.prepare("SELECT path, content, sha, deleted FROM files").all();
  const target = new Map(snap.map((r) => [r.path, r]));
  const now = Date.now();
  const changed = [];
  for (const cur of live) {
    const t = target.get(cur.path) || { content: "", sha: "", deleted: 1 };
    if (t.sha === cur.sha && t.deleted === cur.deleted) continue;
    if (await writeRow(env, cur.path, cur, t.content, t.sha, t.deleted, session, now)) changed.push(cur.path);
  }
  return changed;
}

// ---------- sync status events (POST /v1/status, shown in the admin "Sync status" panel) ----------
const KEEP_EVENTS = 2000;
const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// Returns null when the event is valid and stored, else an error string.
export async function recordStatus(env, b) {
  if (!b || typeof b !== "object") return "bad body";
  if (b.event !== "pull" && b.event !== "push") return "event must be pull or push";
  const now = Date.now();
  let at = Number(b.at);
  if (!Number.isFinite(at) || at < now - 7 * 864e5 || at > now + 60e3) at = now; // queued events keep their time
  const files = Number.isFinite(Number(b.files)) ? Math.max(0, Math.min(1e6, Math.trunc(Number(b.files)))) : 0;
  const projects = Array.isArray(b.projects) ? b.projects.map(String).join(",") : b.projects;
  await env.DB.prepare(
    "INSERT INTO sync_events (at, session, event, ok, error, files, cli_version, auto_memory, cwd_name, projects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(at, clip(b.session, 100), b.event, b.ok ? 1 : 0, clip(b.error, 200), files,
    clip(b.cli_version, 40), clip(b.auto_memory, 60), clip(b.cwd_name, 100), clip(projects, 400)).run();
  await env.DB.prepare("DELETE FROM sync_events WHERE id <= (SELECT MAX(id) FROM sync_events) - ?").bind(KEEP_EVENTS).run();
  return null;
}
