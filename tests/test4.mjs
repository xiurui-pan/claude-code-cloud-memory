// Layers on the server: /v1/resolve (project identity + submodule grouping), layered /v1/pull,
// /v1/move and /v1/move-prefix, 3-way merge on global/CLAUDE.md and projects/*/MEMORY.md,
// status events with projects, and the admin layer API. Runs on both backends.
import crypto from "node:crypto";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start, up, BACKEND } from "./backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA = crypto.createHash("sha256").update("sekret").digest("hex");
const PORT = 8831, B = `http://127.0.0.1:${PORT}`;
const w = start({ port: PORT, state: path.join(HERE, ".state4"), vars: { TOKEN_SHA256: SHA, ADMIN_TRUST_PROXY_HEADER: "X-Auth-User" } });
console.log("backend:", BACKEND);
await up(PORT);
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const bearer = { authorization: "Bearer sekret", "content-type": "application/json" };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const post = (p, b) => fetch(B + p, { method: "POST", headers: bearer, body: JSON.stringify(b) });
const jpost = async (p, b) => { const r = await post(p, b); return { ...(await r.json()), status: r.status }; };
const resolve = (repos) => jpost("/v1/resolve", { repos });
const push = (files, session = "t") => post("/v1/push", { session, files }).then((r) => r.json());
const pull = async (qs = "") => (await (await fetch(B + "/v1/pull" + qs, { headers: bearer })).json()).files;
const paths = (files) => files.map((f) => f.path).sort();
const adm = (p, o = {}) => fetch(B + "/admin/api" + p, { ...o, headers: { "x-auth-user": "me", "content-type": "application/json", ...(o.headers || {}) } });
const admJson = async (p, o) => { const r = await adm(p, o); return { ...(await r.json()), status: r.status }; };

const P = "github.com/acme/platform", API = "github.com/acme/api", CHAT = "github.com/acme/chat";

await t("normalization: https/ssh/credentials/case/.git/slash/port/bare all give one pid", async () => {
  const forms = ["https://github.com/acme/platform", "https://github.com/Acme/Platform.git", "https://x-access-token:tok3n@GitHub.com/acme/platform.git/", "git@github.com:acme/platform.git",
    "ssh://git@github.com:22/acme/platform.git", "git://github.com/acme/platform", "github.com/acme/platform", "  https://github.com/acme/platform.git\n"];
  for (const u of forms) { const r = await resolve([{ url: u }]); assert.deepEqual(r.projects, [P], u); assert.equal(r.map[u], P); }
  assert.deepEqual((await resolve([{ url: "not a url" }, { url: "" }, { url: "https://github.com/onlyowner" }])).projects, []);
  assert.equal((await post("/v1/resolve", { repos: "x" })).status, 400);
  assert.equal((await fetch(B + "/v1/resolve", { method: "POST", body: "{}" })).status, 401);
});

await t("project id too long fails clearly", async () => {
  const r = await resolve([{ url: "https://github.com/acme/" + "x".repeat(190) }]);
  assert.equal(r.status, 400); assert(/too long/.test(r.error), r.error);
});

await t("submodules: relative (../, ./) and absolute URLs resolve against the superrepo remote; subset session maps to parent", async () => {
  const r = await resolve([{ url: "git@github.com:acme/platform.git", submodules: ["../api.git", "https://github.com/Acme/chat.git", "./lib", "../../other/thing"] }]);
  assert.deepEqual(r.projects, [P]); assert.equal(r.map["../api.git"], P);
  const sub = await resolve([{ url: "https://github.com/acme/api.git" }, { url: "git@github.com:acme/chat.git" }]); // only submodules attached
  assert.deepEqual(sub.projects, [P]);
  assert.deepEqual((await resolve([{ url: "https://github.com/acme/api" }])).projects, [P]);
  assert.deepEqual((await resolve([{ url: "https://github.com/acme/platform/vendor/lib" }])).projects, []); // nested paths are not repos
  assert.deepEqual((await resolve([{ url: "https://github.com/other/thing" }])).projects, [P]); // ../../other/thing climbs to the host
  const rows = w.sql("SELECT repo, pid, source FROM repo_membership ORDER BY repo");
  assert(rows.find((x) => x.repo === API && x.pid === P && x.source === "gitmodules"));
  assert(rows.find((x) => x.repo === P && x.source === "self"));
});

await t("first sight of superrepo + submodule clone in one request: submodule listed first still maps to the superrepo", async () => {
  // Cloud multi-repo sessions scan /home/user alphabetically, so a submodule clone can come before its superrepo.
  const r = await resolve([{ url: "https://github.com/acme3/chat" }, { url: "https://github.com/acme3/zplatform", submodules: ["git@github.com:acme3/chat.git"] }]);
  assert.deepEqual(r.projects, ["github.com/acme3/zplatform"]);
  assert.equal(r.map["https://github.com/acme3/chat"], "github.com/acme3/zplatform");
});

await t("unrelated repos give separate projects, sorted and deduped", async () => {
  const r = await resolve([{ url: "https://github.com/acme/tools" }, { url: "https://github.com/acme/docs" }, { url: "https://github.com/ACME/tools.git" }]);
  assert.deepEqual(r.projects, ["github.com/acme/docs", "github.com/acme/tools"]);
});

await t("layered path validation", async () => {
  const ok = (p) => push([{ path: p, content: "x\n", base_sha: null }]).then((r) => r.results[0].status);
  assert.equal(await ok("global/CLAUDE.md"), "written");
  assert.equal(await ok(`projects/${P}/a.md`), "written");
  assert.equal(await ok("projects/_norepo/a.md"), "written");
  for (const bad of ["global/other.md", "global/x/CLAUDE.md", "projects/a.md", "projects/x/a.md", `projects/${P}/sub/a.md`, "projects/GitHub.com/a/b/a.md", "projects/../x/a.md",
    "projects/" + "github.com/acme/" + "y".repeat(180) + "/MEMORY.md"]) assert.equal(await ok(bad), "rejected_path", bad);
  assert.equal(await ok("legacy_note.md"), "written"); // legacy root still fine
});

await t("pull: no params = legacy root only; with params = layers", async () => {
  await push([{ path: "MEMORY.md", content: "- [l](legacy_note.md)\n", base_sha: null }, { path: `projects/${P}/MEMORY.md`, content: "- [a](a.md)\n", base_sha: null },
    { path: "projects/github.com/acme/tools/t.md", content: "t\n", base_sha: null }]);
  assert.deepEqual(paths(await pull()), ["MEMORY.md", "legacy_note.md"]);
  assert.deepEqual(paths(await pull("?projects=&global=1")), ["global/CLAUDE.md"]);
  assert.deepEqual(paths(await pull(`?projects=${P}`)), [`projects/${P}/MEMORY.md`, `projects/${P}/a.md`]);
  assert.deepEqual(paths(await pull(`?projects=${P},github.com/acme/tools&global=1`)), ["global/CLAUDE.md", `projects/${P}/MEMORY.md`, `projects/${P}/a.md`, "projects/github.com/acme/tools/t.md"]);
  assert.deepEqual(paths(await pull("?projects=_norepo")), ["projects/_norepo/a.md"]);
  assert.equal((await fetch(B + "/v1/pull?projects=../x", { headers: bearer })).status, 400);
  assert.equal((await fetch(B + "/v1/pull?projects=Bad/Pid", { headers: bearer })).status, 400);
});

await t("3-way merge: global/CLAUDE.md and projects/*/MEMORY.md", async () => {
  const g0 = "- one\n- two\n";
  await push([{ path: "global/CLAUDE.md", content: g0, base_sha: sha("x\n") }]); // replace placeholder
  const base = sha(g0);
  const a = await push([{ path: "global/CLAUDE.md", content: g0 + "- from A\n", base_sha: base, added_lines: ["- from A"], removed_lines: [] }], "A");
  assert.equal(a.results[0].status, "written");
  const b = await push([{ path: "global/CLAUDE.md", content: "- one\n- from B\n", base_sha: base, added_lines: ["- from B"], removed_lines: ["- two"] }], "B");
  assert.equal(b.results[0].status, "merged"); assert.equal(b.results[0].content, "- one\n- from A\n- from B\n");
  // project index, nested pid path
  const idx = `projects/${P}/MEMORY.md`, i0 = "- [a](a.md)\n";
  const x = await push([{ path: idx, content: i0 + "- [x](x.md)\n", base_sha: sha(i0), added_lines: ["- [x](x.md)"], removed_lines: [] }], "A");
  assert.equal(x.results[0].status, "written");
  const y = await push([{ path: idx, content: i0 + "- [y](y.md)\n", base_sha: sha(i0), added_lines: ["- [y](y.md)"], removed_lines: [] }], "B");
  assert.equal(y.results[0].status, "merged"); assert.equal(y.results[0].content, "- [a](a.md)\n- [x](x.md)\n- [y](y.md)\n");
  // a non-index project file is last writer wins
  const z = await push([{ path: `projects/${P}/a.md`, content: "A2\n", base_sha: sha("nope") }]);
  assert.equal(z.results[0].status, "overwrote_remote");
});

await t("routed_by tags the history session of that file only", async () => {
  await push([{ path: `projects/github.com/acme/tools/r.md`, content: "r\n", base_sha: null, routed_by: "first" }, { path: `projects/github.com/acme/tools/r2.md`, content: "r\n", base_sha: null }], "S1");
  const rows = w.sql("SELECT path, session FROM files WHERE path LIKE '%/r.md' OR path LIKE '%/r2.md' ORDER BY path");
  assert.equal(rows[0].session, "S1|routed:first"); assert.equal(rows[1].session, "S1");
});

await t("3-way merge is positional: blank lines and sections kept, edits land under their heading", async () => {
  const P2 = "projects/github.com/acme/merge3/MEMORY.md";
  const g0 = "# Me\n\n## A\n- a1\n\n## B\n- b1\n";
  await push([{ path: P2, content: g0, base_sha: null }]);
  const base = sha(g0);
  await push([{ path: P2, content: "# Me\n\n## A\n- a1\n- a2\n\n## B\n- b1\n", base_sha: base, added_lines: ["- a2"], removed_lines: [] }], "A");
  const b = await push([{ path: P2, content: "# Me\n\n## A\n\n## B\n- b1\n- b2\n", base_sha: base, added_lines: ["- b2"], removed_lines: ["- a1"] }], "B");
  assert.equal(b.results[0].status, "merged");
  assert.equal(b.results[0].content, "# Me\n\n## A\n- a2\n\n## B\n- b1\n- b2\n");
  // base unknown to the server (not in history): falls back to the append merge, and a removed blank line strips nothing
  const cur = b.results[0].content;
  const c = await push([{ path: P2, content: cur + "- c\n", base_sha: sha("never seen\n"), added_lines: ["- c"], removed_lines: [""] }], "C");
  assert.equal(c.results[0].content, cur + "- c\n");
});

await t("new file whose name is taken: stored under a free name when the client asks to rename", async () => {
  const D = "projects/github.com/acme/rename/";
  await push([{ path: D + "n.md", content: "first\n", base_sha: null }], "A");
  await push([{ path: D + "n.2.md", content: "second\n", base_sha: null }], "A");
  const r = await push([{ path: D + "n.md", content: "mine\n", base_sha: null, on_conflict: "rename" }], "B");
  assert.equal(r.results[0].status, "renamed"); assert.equal(r.results[0].to, D + "n.3.md");
  const same = await push([{ path: D + "n.md", content: "first\n", base_sha: null, on_conflict: "rename" }], "B");
  assert.equal(same.results[0].status, "noop"); // identical content is not a collision
  // two sessions racing for the same free name land on different names, both kept
  const [r1, r2] = await Promise.all(["race A\n", "race B\n"].map((c, i) => push([{ path: D + "n.md", content: c, base_sha: null, on_conflict: "rename" }], "R" + i)));
  const tos = [r1.results[0].to, r2.results[0].to];
  assert.notEqual(tos[0], tos[1], JSON.stringify(tos));
  const live = Object.fromEntries((await pull("?projects=github.com/acme/rename")).map((f) => [f.path, f.content]));
  assert.deepEqual(new Set([live[tos[0]], live[tos[1]]]), new Set(["race A\n", "race B\n"]));
  // names the client holds locally (not yet pushed) are skipped
  const av = await push([{ path: D + "n.md", content: "avoid\n", base_sha: null, on_conflict: "rename", avoid: ["n.6.md", "n.7.md"] }], "B");
  assert.equal(av.results[0].to, D + "n.8.md");
  const old = await push([{ path: D + "n.md", content: "old client\n", base_sha: null }], "C");
  assert.equal(old.results[0].status, "overwrote_remote"); // without the flag: unchanged behaviour
});

await t("move: history kept, 404/409/400, index merge", async () => {
  await push([{ path: "m1.md", content: "m1 body\n", base_sha: null }, { path: "m2.md", content: "m2 body\n", base_sha: null }]);
  const r = await jpost("/v1/move", { from: "m1.md", to: `projects/${P}/m1.md` });
  assert.equal(r.status, 200); assert.equal(r.result, "moved"); assert.equal(r.sha, sha("m1 body\n"));
  assert(!paths(await pull()).includes("m1.md"));
  assert((await pull(`?projects=${P}`)).find((f) => f.path === `projects/${P}/m1.md`).content === "m1 body\n");
  const h = w.sql("SELECT path, deleted, session FROM history WHERE path IN ('m1.md', 'projects/github.com/acme/platform/m1.md') ORDER BY id");
  assert.deepEqual(h.map((x) => [x.path, x.deleted, x.session]), [["m1.md", 0, "t"], [`projects/${P}/m1.md`, 0, "move"], ["m1.md", 1, "move"]]);
  assert.equal((await jpost("/v1/move", { from: "nope.md", to: "q.md" })).status, 404);
  assert.equal((await jpost("/v1/move", { from: "m2.md", to: `projects/${P}/m1.md` })).status, 409);
  assert.equal((await jpost("/v1/move", { from: "m2.md", to: "../x.md" })).status, 400);
  assert.equal((await jpost("/v1/move", { from: "m2.md", to: "m2.md" })).status, 400);
  const mi = await jpost("/v1/move", { from: "MEMORY.md", to: `projects/${P}/MEMORY.md` });
  assert.equal(mi.status, 200); assert.equal(mi.result, "merged");
  const idx = (await pull(`?projects=${P}`)).find((f) => f.path === `projects/${P}/MEMORY.md`).content;
  assert(idx.includes("- [l](legacy_note.md)") && idx.includes("- [x](x.md)"), idx);
});

await t("move-prefix: collisions renamed + links rewritten, indexes merged, history kept", async () => {
  await push([{ path: "projects/github.com/acme/src/MEMORY.md", content: "- [n](n.md)\n- [u](u.md)\n", base_sha: null },
    { path: "projects/github.com/acme/src/n.md", content: "src n\n", base_sha: null }, { path: "projects/github.com/acme/src/u.md", content: "src u\n", base_sha: null },
    { path: "projects/github.com/acme/dst/MEMORY.md", content: "- [n](n.md)\n", base_sha: null }, { path: "projects/github.com/acme/dst/n.md", content: "dst n\n", base_sha: null }]);
  const r = await jpost("/v1/move-prefix", { from_prefix: "projects/github.com/acme/src/", to_prefix: "projects/github.com/acme/dst/" });
  assert.equal(r.status, 200); assert.deepEqual(r.renamed, { "n.md": "n.2.md" });
  const f = Object.fromEntries((await pull("?projects=github.com/acme/dst")).map((x) => [x.path.split("/").pop(), x.content]));
  assert.equal(f["n.md"], "dst n\n"); assert.equal(f["n.2.md"], "src n\n"); assert.equal(f["u.md"], "src u\n");
  assert.equal(f["MEMORY.md"], "- [n](n.md)\n- [n](n.2.md)\n- [u](u.md)\n");
  assert.deepEqual(await pull("?projects=github.com/acme/src"), []);
  assert.equal(w.sql("SELECT COUNT(*) c FROM history WHERE path = 'projects/github.com/acme/src/u.md'")[0].c, 2);
  assert.equal((await jpost("/v1/move-prefix", { from_prefix: "a/", to_prefix: "a/b/" })).status, 400);
  assert.equal((await jpost("/v1/move-prefix", { from_prefix: "a", to_prefix: "b/" })).status, 400);
});

await t("late membership: files under the submodule's own project move into the parent (history kept, index merged)", async () => {
  const S = "github.com/acme2/web", PARENT = "github.com/acme2/suite";
  assert.deepEqual((await resolve([{ url: "https://github.com/acme2/web" }])).projects, [S]);
  await push([{ path: `projects/${S}/MEMORY.md`, content: "- [w](w.md)\n", base_sha: null }, { path: `projects/${S}/w.md`, content: "w\n", base_sha: null }, { path: `projects/${S}/n.md`, content: "web n\n", base_sha: null },
    { path: `projects/${PARENT}/MEMORY.md`, content: "- [s](s.md)\n- [n](n.md)\n", base_sha: null }, { path: `projects/${PARENT}/n.md`, content: "suite n\n", base_sha: null }]);
  const r = await resolve([{ url: "https://github.com/acme2/suite", submodules: ["../web.git"] }]);
  assert.deepEqual(r.projects, [PARENT]);
  assert.deepEqual(await pull(`?projects=${S}`), []);
  const f = Object.fromEntries((await pull(`?projects=${PARENT}`)).map((x) => [x.path.split("/").pop(), x.content]));
  assert.equal(f["w.md"], "w\n"); assert.equal(f["n.md"], "suite n\n"); assert.equal(f["n.2.md"], "web n\n");
  assert.equal(f["MEMORY.md"], "- [s](s.md)\n- [n](n.md)\n- [w](w.md)\n");
  assert.equal(w.sql(`SELECT COUNT(*) c FROM history WHERE path = 'projects/${S}/w.md'`)[0].c, 2);
  assert.deepEqual((await resolve([{ url: "https://github.com/acme2/web" }])).projects, [PARENT]);
  assert(!w.sql("SELECT pid FROM projects").some((x) => x.pid === S));
});

await t("status events store the resolved project list", async () => {
  assert.equal((await post("/v1/status", { event: "pull", ok: true, files: 1, projects: [P, "_norepo"] })).status, 200);
  assert.equal((await post("/v1/status", { event: "push", ok: true, files: 0 })).status, 200);
  const rows = w.sql("SELECT event, projects FROM sync_events ORDER BY id");
  assert.equal(rows[0].projects, `${P},_norepo`); assert.equal(rows[1].projects, null);
  assert.equal(w.sql("SELECT MAX(version) v FROM schema_version")[0].v, 1);
});

// ---------- admin ----------
await t("admin: layer fields, projects with member repos, flagged files", async () => {
  const d = await admJson("/files");
  assert.equal(d.status, 200);
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.equal(by["global/CLAUDE.md"].layer, "global");
  assert.deepEqual([by[`projects/${P}/a.md`].layer, by[`projects/${P}/a.md`].pid, by[`projects/${P}/a.md`].file], ["project", P, "a.md"]);
  assert.equal(by["legacy_note.md"].layer, "legacy");
  assert.equal(by["projects/github.com/acme/tools/r.md"].flagged, "first");
  assert.equal(by["projects/github.com/acme/tools/r2.md"].flagged, null);
  const p = d.projects.find((x) => x.pid === P);
  assert(p.repos.some((r) => r.repo === API && r.source === "gitmodules") && p.repos.some((r) => r.repo === CHAT)); assert(p.files >= 3);
  assert((await admJson("/status")).recent.some((e) => e.projects === `${P},_norepo`));
});

await t("admin: move file between layers (history session admin), conflict, unflag, CSRF/origin", async () => {
  await push([{ path: "adm_note.md", content: "n\n", base_sha: null }]);
  const r = await admJson("/move", { method: "POST", body: JSON.stringify({ from: "adm_note.md", to: `projects/${P}/adm_note.md` }) });
  assert.equal(r.status, 200);
  assert.equal(w.sql("SELECT session FROM files WHERE path = 'projects/github.com/acme/platform/adm_note.md'")[0].session, "admin");
  assert.equal((await admJson("/move", { method: "POST", body: JSON.stringify({ from: "legacy_note.md", to: `projects/${P}/adm_note.md` }) })).status, 409);
  assert.equal((await admJson("/move", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await admJson("/unflag", { method: "POST", body: JSON.stringify({ path: "projects/github.com/acme/tools/r.md" }) })).status, 200);
  assert.equal((await admJson("/files")).files.find((f) => f.path === "projects/github.com/acme/tools/r.md").flagged, null);
  assert.equal((await fetch(B + "/admin/api/move", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 403); // no auth header
});

await t("admin: membership edit (manual survives resolve), delete, merge projects", async () => {
  const U = "github.com/acme3/one", V = "github.com/acme3/two";
  await resolve([{ url: "https://github.com/" + U.slice(11) }, { url: "https://github.com/" + V.slice(11) }]);
  await push([{ path: `projects/${V}/v.md`, content: "v\n", base_sha: null }, { path: `projects/${V}/MEMORY.md`, content: "- [v](v.md)\n", base_sha: null }, { path: `projects/${U}/MEMORY.md`, content: "- u\n", base_sha: null }]);
  const m = await admJson("/membership", { method: "PUT", body: JSON.stringify({ repo: "git@github.com:acme3/two.git", pid: U }) });
  assert.equal(m.status, 200);
  assert.deepEqual((await resolve([{ url: "https://github.com/acme3/two" }])).projects, [U]); // manual wins
  assert.equal((await admJson("/membership", { method: "PUT", body: JSON.stringify({ repo: "bad", pid: U }) })).status, 400);
  const mg = await admJson("/merge-project", { method: "POST", body: JSON.stringify({ from: V, into: U }) });
  assert.equal(mg.status, 200);
  assert.deepEqual(paths(await pull(`?projects=${V}`)), []);
  const f = Object.fromEntries((await pull(`?projects=${U}`)).map((x) => [x.path.split("/").pop(), x.content]));
  assert.equal(f["v.md"], "v\n"); assert.equal(f["MEMORY.md"], "- u\n- [v](v.md)\n");
  assert.equal(w.sql(`SELECT source FROM repo_membership WHERE repo = '${V}'`)[0].source, "manual");
  assert.equal((await admJson("/merge-project", { method: "POST", body: JSON.stringify({ from: U, into: U }) })).status, 400);
  const del = await admJson("/membership?repo=" + encodeURIComponent(V), { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual((await resolve([{ url: "https://github.com/acme3/two" }])).projects, [V]); // back to its own project
});

await t("admin: edit/history/restore still work on layered paths", async () => {
  const p = `projects/${P}/a.md`;
  const cur = await admJson("/file?path=" + encodeURIComponent(p));
  const e = await admJson("/file", { method: "PUT", body: JSON.stringify({ path: p, content: "edited\n", base_sha: cur.sha }) });
  assert.equal(e.status, 200);
  const h = await admJson("/history?path=" + encodeURIComponent(p));
  assert(h.history.length >= 2);
  assert.equal((await adm("/file", { method: "PUT", body: JSON.stringify({ path: "projects/x/a.md", content: "x" }) })).status, 400);
});

w.stop();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
